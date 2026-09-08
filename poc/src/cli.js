#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildKieTaskPayload, buildGenerationReport, buildReport, executeRun, loadManifest, readFinalRecords, readGenerationRecords, readRecords, renderGenerationMarkdownReport, renderMarkdownReport, saveRecord, validateManifest } from './core.js';
import { createKieClient } from './provider-client.js';
import { createReviewTemplate, assembleApprovedShots, validateFinalReview } from './review-service.js';
import { detectScenes } from './scene-service.js';
import { hashPlan, resolveShotPlan, validateBoundaries, validateSavedShotPlan, validateShotManifest } from './shot-plan.js';
import { runShots } from './shot-runner.js';
import { assertVideoTools, cutShots, probeMedia } from './video-service.js';

const [command, ...args] = process.argv.slice(2);
const options = parseArgs(args);
const commands = new Set(['validate', 'run', 'report', 'plan', 'prepare', 'run-shots', 'review-template', 'assemble', 'final-review']);
if (!commands.has(command)) die('Usage: node poc/src/cli.js <validate|run|report|plan|prepare|run-shots|review-template|assemble|final-review> [options]');

if (command === 'validate') await validateLegacy();
if (command === 'run') await runLegacy();
if (command === 'report') await report();
if (command === 'plan') await printPlan();
if (command === 'prepare') await prepare();
if (command === 'run-shots') await runShotGeneration();
if (command === 'review-template') await writeReviewTemplate();
if (command === 'assemble') await assemble();
if (command === 'final-review') await finalReview();

async function validateLegacy() {
  const manifest = await loadManifest(required('manifest'));
  const errors = validateManifest(manifest, { allowPlaceholders: true });
  if (errors.length) die(errors.join('\n'));
  console.log(`Manifest valid: ${manifest.runs.length} test cases.`);
}
async function runLegacy() {
  const mode = options.mode ?? 'dry-run';
  if (options['resume-dir'] && mode !== 'live') die('Resume is only allowed in live mode to protect paid generation records.');
  const manifest = await loadManifest(required('manifest'));
  const errors = validateManifest(manifest, { allowPlaceholders: mode === 'dry-run' });
  if (errors.length) die(errors.join('\n'));
  const runDirectory = path.join(options['runs-dir'] ?? 'poc/runs', timestamp());
  const client = mode === 'live' ? createClient() : null;
  for (const run of manifest.runs) await saveRecord(runDirectory, await executeRun({ run, manifest, mode, client, requestBuilder: buildKieTaskPayload }));
  console.log(`Saved ${manifest.runs.length} record(s) to ${runDirectory}`);
}
async function report() {
  const runsDir = options['runs-dir'] ?? 'poc/runs';
  const records = await readRecords(runsDir);
  const output = options.output ?? path.join(runsDir, 'round-1-results.md');
  await mkdir(path.dirname(output), { recursive: true });
  const generations = (await readGenerationRecords(runsDir)).filter((generation) => generation.mode !== 'dry-run');
  const finals = await readFinalRecords(runsDir);
  await writeFile(output, generations.length ? renderGenerationMarkdownReport(generations, records, finals) : renderMarkdownReport(records));
  console.log(`Report saved to ${output}`);
  console.table(generations.length ? buildGenerationReport(generations, records, finals) : buildReport(records));
}
async function printPlan() {
  const { plan } = await resolvePlanFromManifest({ detect: true });
  console.table(plan.shots.map((shot) => ({ id: shot.id, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, durationSeconds: shot.endSeconds - shot.startSeconds, publicVideoUrl: shot.publicVideoUrl ?? '' })));
}
async function prepare() {
  const { plan } = await resolvePlanFromManifest({ detect: true, checkTools: true });
  const media = await probeMedia({ inputPath: plan.localVideoPath });
  const manifest = await loadManifest(required('manifest'));
  const validatedPlan = resolveShotPlan(manifest, plan.shots, { sourceDuration: media.durationSeconds });
  const outputDirectory = options['assets-dir'] ?? path.join('poc/assets', plan.templateId, 'shots');
  const outputs = await cutShots({ inputPath: validatedPlan.localVideoPath, shots: validatedPlan.shots, outputDirectory });
  const preparedPlan = { ...validatedPlan, sourceMedia: media, shots: validatedPlan.shots.map((shot) => ({ ...shot, localVideoPath: outputs.find((output) => output.id === shot.id).localVideoPath })) };
  const outputPath = options.output ?? path.join('poc/assets', plan.templateId, 'shot-plan.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(preparedPlan, null, 2) + '\n');
  console.log(`Prepared ${preparedPlan.shots.length} shot(s). Upload each localVideoPath, add publicVideoUrl, then run run-shots --plan ${outputPath}.`);
}
async function runShotGeneration() {
  const mode = options.mode ?? 'dry-run';
  if (options['resume-dir'] && mode !== 'live') die('Resume is only allowed in live mode to protect paid generation records.');
  const manifest = await loadManifest(required('manifest'));
  const errors = validateShotManifest(manifest);
  if (errors.length) die(errors.join('\n'));
  let plan = await loadRunPlan(manifest);
  if (mode === 'live') {
    const sourceMedia = await probeMedia({ inputPath: manifest.template.localVideoPath });
    const planErrors = validateBoundaries(plan.shots, 'loaded plan', { sourceDuration: sourceMedia.durationSeconds });
    if (planErrors.length) die(planErrors.join('\n'));
    if (plan.sourceDurationSeconds == null) {
      plan = { ...plan, sourceDurationSeconds: sourceMedia.durationSeconds };
      plan.planHash = hashPlan(plan);
    }
    const savedPlanErrors = validateSavedShotPlan(plan, manifest);
    if (savedPlanErrors.length) die(savedPlanErrors.join('\n'));
  }
  let savedGeneration = null;
  if (options['resume-dir']) {
    const generations = await readGenerationRecords(options['resume-dir']);
    if (generations.length !== 1) die('Resume requires exactly one generation snapshot.');
    savedGeneration = generations[0];
    if (savedGeneration.mode !== 'live') die('Cannot resume a non-live generation snapshot.');
    if (savedGeneration.planHash !== plan.planHash || stableJson(savedGeneration.planSnapshot) !== stableJson(plan) || stableJson(savedGeneration.manifestSnapshot) !== stableJson(manifest)) die('Resume manifest/plan does not match the immutable generation snapshot.');
  }
  const runDirectory = options['resume-dir'] ?? path.join(options['runs-dir'] ?? 'poc/runs', `${timestamp()}-${randomUUID()}`);
  await mkdir(runDirectory, { recursive: true });
  const existingRecords = options['resume-dir'] ? await readRecords(runDirectory) : [];
  const generationId = savedGeneration?.generationId ?? `${plan.templateId}-${randomUUID()}`;
  const records = await runShots({ plan, manifest, mode, generationId, existingRecords, client: mode === 'live' ? createClient() : null, saveRecord: async (_unused, record) => saveRecord(runDirectory, record), saveGeneration: async (generation) => { if (options['resume-dir']) return; await mkdir(path.join(runDirectory, '.meta'), { recursive: true }); await writeFile(path.join(runDirectory, '.meta', `${generation.generationId}.generation.json`), JSON.stringify(generation, null, 2) + '\n'); } });
  console.log(`Saved ${records.length} shot record(s) to ${runDirectory}`);
}
async function writeReviewTemplate() {
  const runsDir = required('runs-dir');
  const template = createReviewTemplate(await readRecords(runsDir));
  const output = options.output ?? path.join(runsDir, 'review-template.json');
  await writeFile(output, JSON.stringify(template, null, 2) + '\n');
  console.log(`Review ${template.length} completed shot(s) in ${output}.`);
}
async function assemble() {
  const runsDir = required('runs-dir');
  let records = await readRecords(runsDir);
  if (options.reviews) records = mergeReviews(records, JSON.parse(await readFile(options.reviews, 'utf8')));
  if (options.reviews) await Promise.all(records.filter((record) => record.qualityReview).map((record) => saveRecord(runsDir, record)));
  const outputPath = options.output ?? path.join(runsDir, 'final.mp4');
  const generations = await readGenerationRecords(runsDir);
  if (generations.length !== 1 || generations[0].mode !== 'live') die('Assembly requires exactly one live generation snapshot.');
  const generation = generations[0];
  const expectedShotIds = generation.expectedShotIds;
  if (!Array.isArray(expectedShotIds) || !expectedShotIds.length) die('Generation snapshot has no expected shot order.');
  if (options.plan) {
    const plan = JSON.parse(await readFile(options.plan, 'utf8'));
    if (plan.planHash !== generation.planHash) die('Assembly plan hash does not match the immutable generation snapshot.');
  }
  const generationId = generation.generationId;
  const profile = outputProfile(generation.manifestSnapshot);
  const result = await assembleApprovedShots({ records, expectedShotIds, planSnapshot: generation.planSnapshot, templateId: generation.templateId, outputPath, tempDirectory: path.join(runsDir, '.assembly'), normalize: true, probe: async (inputPath) => probeMedia({ inputPath }), sourceAudioPath: options['source-audio'] ?? generation.planSnapshot?.localVideoPath ?? null, expectedDurationSeconds: generation.sourceDurationSeconds, width: profile.width, height: profile.height, generationId });
  await Promise.all(records.map((record) => saveRecord(runsDir, { ...record, actualDurationSeconds: result.actualDurationSeconds[record.shotId] })));
  await writeFile(path.join(runsDir, 'final-record.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Assembled ${result.shotIds.length} shot(s): ${result.outputVideoPath}`);
}
async function finalReview() {
  const runsDir = required('runs-dir');
  const finalPath = options.final ?? path.join(runsDir, 'final-record.json');
  const final = JSON.parse(await readFile(finalPath, 'utf8'));
  const generations = await readGenerationRecords(runsDir);
  if (generations.length !== 1 || generations[0].mode !== 'live') die('Final review requires exactly one live generation snapshot.');
  if (final.generationId !== generations[0].generationId) die('Final artifact generationId does not match generation snapshot.');
  const review = JSON.parse(await readFile(required('review'), 'utf8'));
  const errors = validateFinalReview(review);
  if (errors.length) die(errors.join('\n'));
  final.finalReview = review;
  final.usable = review.usable;
  await writeFile(finalPath, JSON.stringify(final, null, 2) + '\n');
  console.log(`Final review saved: ${finalPath}`);
}
async function resolvePlanFromManifest({ detect, checkTools = false }) {
  const manifest = await loadManifest(required('manifest'));
  const errors = validateShotManifest(manifest);
  if (errors.length) die(errors.join('\n'));
  if (checkTools) await assertVideoTools();
  const detectedShots = manifest.template.shots?.length || !detect ? [] : await detectScenes({ inputPath: manifest.template.localVideoPath, adaptiveThreshold: manifest.template.sceneDetection.adaptiveThreshold, minShotDurationSeconds: manifest.template.sceneDetection.minShotDurationSeconds });
  const sourceDuration = checkTools ? (await probeMedia({ inputPath: manifest.template.localVideoPath })).durationSeconds : undefined;
  return { manifest, plan: resolveShotPlan(manifest, detectedShots, { sourceDuration }) };
}
async function loadRunPlan(manifest) {
  if (options.plan) {
    const loaded = JSON.parse(await readFile(options.plan, 'utf8'));
    const errors = validateSavedShotPlan(loaded, manifest, { requireSourceDuration: options.mode !== 'live' });
    if (errors.length) die(errors.join('\n'));
    return loaded;
  }
  if (!manifest.template.shots?.length) die('Automatic shots need preparation first. Run prepare, upload clips, add publicVideoUrl values to the saved plan, then pass --plan.');
  return resolveShotPlan(manifest, []);
}
function mergeReviews(records, reviews) {
  const byRunId = new Map(reviews.map((entry) => [entry.runId, entry.qualityReview]));
  return records.filter((record) => record.runId).map((record) => ({ ...record, qualityReview: byRunId.get(record.runId) ?? record.qualityReview }));
}
function createClient() {
  return createKieClient({ apiKey: process.env.KIE_API_KEY, baseUrl: process.env.KIE_API_BASE_URL, pollIntervalMs: Number(process.env.KIE_POLL_INTERVAL_MS ?? 5000) });
}
function parseArgs(list) { const values = {}; for (let index = 0; index < list.length; index += 2) { const key = list[index]; if (!key?.startsWith('--')) die(`Unknown argument: ${key}`); values[key.slice(2)] = list[index + 1]; } return values; }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function outputProfile(manifest = {}) { const height = Number.parseInt(String(manifest.resolution ?? '480p'), 10) || 480; const [aw, ah] = String(manifest.aspectRatio ?? '16:9').split(':').map(Number); const ratio = aw > 0 && ah > 0 ? aw / ah : 16 / 9; const width = Math.max(2, Math.round((height * ratio) / 2) * 2); return { width, height: height % 2 ? height + 1 : height }; }
function required(name) { if (!options[name]) die(`--${name} is required.`); return options[name]; }
function timestamp() { return new Date().toISOString().replaceAll(':', '-').replace(/\..+/, ''); }
function die(message) { console.error(message); process.exit(1); }
