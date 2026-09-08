import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { basename } from 'node:path';

const PLACEHOLDER_HOST = 'replace-with-public-url.example';
const SUCCESS_STATES = new Set(['completed', 'succeeded', 'success']);
const FAILURE_STATES = new Set(['failed', 'error', 'cancelled', 'canceled']);

export async function loadManifest(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function validateManifest(manifest, { allowPlaceholders = false } = {}) {
  const errors = [];
  if (!Array.isArray(manifest.runs) || manifest.runs.length === 0) {
    errors.push('runs must contain at least one test case.');
  }
  const ids = new Set();
  for (const run of manifest.runs ?? []) {
    if (!run.id) errors.push('every run needs an id.');
    if (ids.has(run.id)) errors.push(`duplicate run id: ${run.id}`);
    ids.add(run.id);
    if (![1, 2, 3].includes(run.slotCount)) errors.push(`${run.id}: slotCount must be 1, 2, or 3.`);
    if (!Array.isArray(run.references) || run.references.length !== run.slotCount) {
      errors.push(`${run.id}: references length must equal slotCount.`);
    }
    const expectedSlots = Array.from({ length: run.slotCount }, (_, index) => index + 1);
    const actualSlots = (run.references ?? []).map((reference) => reference.slot).sort((a, b) => a - b);
    if (expectedSlots.join(',') !== actualSlots.join(',')) {
      errors.push(`${run.id}: references must contain slots ${expectedSlots.join(', ')} exactly once.`);
    }
    for (const [field, value] of [['templateVideoUrl', run.templateVideoUrl], ...((run.references ?? []).map((item) => ['reference imageUrl', item.imageUrl]))]) {
      if (!isPublicHttpUrl(value) || (!allowPlaceholders && isPlaceholderUrl(value))) {
        errors.push(`${run.id}: ${field} must be a non-placeholder public HTTPS URL.`);
      }
    }
    if (!run.prompt?.trim()) errors.push(`${run.id}: prompt is required.`);
  }
  return errors;
}

export function buildSeedanceRequest(run, manifest) {
  return {
    model: manifest.model,
    input: {
      prompt: run.prompt,
      generation_type: 'reference-to-video',
      video_urls: [run.templateVideoUrl],
      image_urls: run.references.map((reference) => reference.imageUrl),
      duration: manifest.durationSeconds,
      resolution: manifest.resolution
    }
  };
}

export function buildKieTaskPayload(run, manifest) {
  return {
    model: manifest.model ?? 'bytedance/seedance-2-5',
    input: {
      prompt: run.prompt,
      reference_image_urls: run.references.map((reference) => reference.imageUrl),
      reference_video_urls: [run.templateVideoUrl],
      generate_audio: false,
      return_last_frame: false,
      resolution: manifest.resolution ?? '480p',
      aspect_ratio: manifest.aspectRatio ?? '16:9',
      duration: manifest.durationSeconds ?? 5,
      output_format: 'mp4',
      web_search: false,
      nsfw_checker: true
    }
  };
}

export async function executeRun({ run, manifest, mode, client, requestBuilder = buildSeedanceRequest, now = () => new Date().toISOString() }) {
  const startedAt = now();
  const request = requestBuilder(run, manifest);
  if (mode === 'dry-run') {
    return {
      runId: run.id,
      templateId: run.templateId,
      slotCount: run.slotCount,
      status: 'dry-run',
      startedAt,
      completedAt: now(),
      request,
      provider: { model: manifest.model },
      costUsd: null,
      outputVideoUrl: null,
      qualityReview: null
    };
  }
  const created = await client.create(request);
  const taskId = extractTaskId(created);
  if (!taskId) throw new Error(`${run.id}: provider response has no task id.`);
  const result = await client.waitForCompletion(taskId);
  const status = normaliseStatus(result);
  return {
    runId: run.id,
    templateId: run.templateId,
    slotCount: run.slotCount,
    status,
    startedAt,
    completedAt: now(),
    request,
    provider: { model: manifest.model, taskId, rawResult: result },
    costUsd: extractCost(result),
    creditsConsumed: extractCredits(result),
    providerCostTimeMs: extractProviderCostTime(result),
    outputVideoUrl: extractOutputUrl(result),
    qualityReview: null
  };
}

export function buildReport(records) {
  const actual = records.filter((record) => record.status !== 'dry-run');
  const groups = [1, 2, 3].map((slotCount) => {
    const items = actual.filter((record) => record.slotCount === slotCount);
    const completed = items.filter((record) => SUCCESS_STATES.has(record.status));
    const latencies = completed.map(latencyMs).filter(Number.isFinite);
    const costs = completed.map((record) => record.costUsd).filter(Number.isFinite);
    const credits = completed.map((record) => record.creditsConsumed).filter(Number.isFinite);
    const reviews = completed.map((record) => record.qualityReview).filter(Boolean);
    return {
      slotCount,
      total: items.length,
      completed: completed.length,
      successRate: items.length ? completed.length / items.length : null,
      medianLatencyMs: median(latencies),
      averageCostUsd: average(costs),
      totalKnownCostUsd: items.some((record) => Number.isFinite(record.costUsd)) ? items.reduce((sum, record) => sum + (Number.isFinite(record.costUsd) ? record.costUsd : 0), 0) : null,
      attemptsWithKnownCost: items.filter((record) => Number.isFinite(record.costUsd)).length,
      averageCreditsConsumed: average(credits),
      reviewed: reviews.length,
      qualityPassRate: reviews.length ? reviews.filter((review) => review.usable === true).length / reviews.length : null,
      finalUsableCount: items.filter((record) => record.finalReview?.usable === true).length
    };
  });
  return groups;
}

export function renderMarkdownReport(records) {
  const rows = buildReport(records);
  const lines = [
    '# VidWizard POC — Round 1 Results',
    '',
    `Generated from ${records.length} run record(s). Dry-run records are excluded from performance and cost metrics.`,
    '',
    '| Slots | Runs | Completed | Success rate | Median latency | Avg. credits/video | Avg. cost/video | Quality reviewed | Quality pass rate |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const row of rows) {
    lines.push(`| ${row.slotCount} | ${row.total} | ${row.completed} | ${formatPercent(row.successRate)} | ${formatDuration(row.medianLatencyMs)} | ${formatNumber(row.averageCreditsConsumed)} | ${formatCost(row.averageCostUsd)} | ${row.reviewed} | ${formatPercent(row.qualityPassRate)} |`);
  }
  lines.push('', '## Manual quality review', '', 'For every completed video, review identity mapping, background preservation, action/pose preservation, camera/timing preservation, and overall usability. Mark `usable: true` only when the video is acceptable for the intended Experience.', '');
  return lines.join('\n');
}

export async function saveRecord(directory, record) {
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${record.runId}.json`);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await rename(tempPath, filePath);
  return filePath;
}

export async function readRecords(directory) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.json'));
  const parsed = await Promise.all(files.map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), 'utf8'))));
  return parsed.filter((record) => record && !Array.isArray(record) && typeof record.runId === 'string');
}

export async function readGenerationRecords(directory) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.generation.json'));
  return Promise.all(files.map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), 'utf8'))));
}

export async function readFinalRecords(directory) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.final.json') || basename(entry) === 'final-record.json');
  return Promise.all(files.map(async (entry) => JSON.parse(await readFile(path.join(directory, entry), 'utf8'))));
}

export function buildGenerationReport(generations, shotRecords = [], finalRecords = []) {
  return generations.filter((generation) => generation.mode !== 'dry-run').map((generation) => {
    const attempts = shotRecords.filter((record) => record.generationId === generation.generationId);
    const completed = attempts.filter((record) => ['success', 'completed', 'succeeded'].includes(record.status));
    const knownCosts = attempts.map((record) => record.costUsd).filter(Number.isFinite);
    const knownCredits = attempts.map((record) => record.creditsConsumed).filter(Number.isFinite);
    const final = finalRecords.find((record) => record.generationId === generation.generationId);
    return {
      generationId: generation.generationId,
      templateId: generation.templateId,
      totalAttempts: attempts.length,
      completedAttempts: completed.length,
      knownCostUsd: knownCosts.length ? knownCosts.reduce((a, b) => a + b, 0) : null,
      costKnownAttempts: knownCosts.length,
      costUnknownAttempts: attempts.length - knownCosts.length,
      knownCredits: knownCredits.length ? knownCredits.reduce((a, b) => a + b, 0) : null,
      creditsKnownAttempts: knownCredits.length,
      creditsUnknownAttempts: attempts.length - knownCredits.length,
      assemblyLatencyMs: final?.assembledAt && generation.startedAt ? Date.parse(final.assembledAt) - Date.parse(generation.startedAt) : null,
      finalReviewedCount: final?.finalReview ? 1 : 0,
      finalReviewUsable: final?.finalReview?.usable === true ? 1 : 0,
      costPerUsableFinalUsd: final?.finalReview?.usable === true && attempts.length > 0 && knownCosts.length === attempts.length ? knownCosts.reduce((a, b) => a + b, 0) : null
    };
  });
}

export function buildTemplateReport(generations, shotRecords = [], finalRecords = []) {
  const rows = buildGenerationReport(generations, shotRecords, finalRecords);
  return [...new Set(rows.map(row => row.templateId))].map(templateId => {
    const items = rows.filter(row => row.templateId === templateId);
    const usable = items.reduce((n, row) => n + row.finalReviewUsable, 0);
    const unknown = items.reduce((n, row) => n + row.costUnknownAttempts, 0);
    const known = items.reduce((n, row) => n + (row.knownCostUsd ?? 0), 0);
    const hasCosts = items.some(row => row.costKnownAttempts > 0);
    return { templateId, generations: items.length, reviewed: items.reduce((n,row) => n + row.finalReviewedCount, 0), usable,
      usableRate: usable / items.length, costUnknownAttempts: unknown,
      knownCostUsd: hasCosts ? known : null,
      costPerUsableFinalUsd: usable && !unknown && hasCosts ? known / usable : null };
  });
}

export function renderGenerationMarkdownReport(generations, shotRecords, finalRecords) {
  const rows = buildGenerationReport(generations, shotRecords, finalRecords);
  const lines = ['# VidWizard POC — Generation Results', '', 'Metrics include every shot attempt; unknown cost/credits remain unknown.', '', '| Generation | Template | Attempts | Completed | Known cost USD | Unknown cost | Known credits | Unknown credits | Assembly latency | Final reviewed | Final usable |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const row of rows) lines.push(`| ${row.generationId} | ${row.templateId} | ${row.totalAttempts} | ${row.completedAttempts} | ${row.knownCostUsd == null ? '—' : row.knownCostUsd.toFixed(3)} | ${row.costUnknownAttempts} | ${row.knownCredits == null ? '—' : row.knownCredits} | ${row.creditsUnknownAttempts} | ${row.assemblyLatencyMs == null ? '—' : `${(row.assemblyLatencyMs / 1000).toFixed(1)}s`} | ${row.finalReviewedCount} | ${row.finalReviewUsable} |`);
  lines.push('', '| Template | Generations | Final reviewed | Usable | Usable rate | Cost/usable USD (all attempts) |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of buildTemplateReport(generations, shotRecords, finalRecords)) lines.push(`| ${row.templateId} | ${row.generations} | ${row.reviewed} | ${row.usable} | ${formatPercent(row.usableRate)} | ${formatCost(row.costPerUsableFinalUsd)} |`);
  return lines.join('\n') + '\n';
}

export function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isPlaceholderUrl(value) {
  try { return new URL(value).hostname === PLACEHOLDER_HOST; } catch { return false; }
}
function extractTaskId(result) { return result.id ?? result.task_id ?? result.data?.id ?? result.data?.task_id ?? result.data?.taskId; }
function normaliseStatus(result) { return String(result.status ?? result.data?.status ?? result.data?.state ?? 'unknown').toLowerCase(); }
function extractOutputUrl(result) { return result.output_video_url ?? result.video_url ?? result.data?.output_video_url ?? result.data?.video_url ?? result.data?.response?.[0] ?? parseResultJson(result.data?.resultJson)?.resultUrls?.[0] ?? null; }
function extractCost(result) { const value = result.cost_usd ?? result.usage?.cost_usd ?? result.data?.cost_usd ?? null; return value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function extractCredits(result) { const value = result.creditsConsumed ?? result.data?.creditsConsumed ?? null; return value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function extractProviderCostTime(result) { const value = result.costTime ?? result.data?.costTime ?? null; return value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function parseResultJson(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
function latencyMs(record) { return Date.parse(record.completedAt) - Date.parse(record.startedAt); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function formatPercent(value) { return value === null ? '—' : `${(value * 100).toFixed(1)}%`; }
function formatDuration(value) { return value === null ? '—' : `${(value / 1000).toFixed(1)}s`; }
function formatCost(value) { return value === null ? '—' : `$${value.toFixed(3)}`; }
function formatNumber(value) { return value === null ? '—' : value.toFixed(2); }
