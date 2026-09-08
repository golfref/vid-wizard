import { buildShotKiePayload, isPublicHttpsUrl } from './shot-plan.js';

export async function runShots({ plan, manifest, mode, client = null, now = () => new Date().toISOString(), saveRecord = async () => {}, saveGeneration = async () => {}, existingRecords = [], pollTimeoutMs = 15 * 60 * 1000, generationId = `${plan.templateId}-${Date.now()}` }) {
  if (!['dry-run', 'live'].includes(mode)) throw new Error('mode must be dry-run or live.');
  if (mode === 'live') {
    const missing = plan.shots.filter((shot) => !isPublicHttpsUrl(shot.publicVideoUrl));
    if (missing.length) throw new Error(`${missing.map((shot) => shot.id).join(', ')}: publicVideoUrl must be a public HTTPS URL before live generation.`);
    if (!client) throw new Error('A Kie client is required in live mode.');
    // Validate every payload and recovery intent before the first paid call.
    const intents = new Map(existingRecords.filter((record) => record.shotId).map((record) => [record.shotId, record]));
    for (const shot of plan.shots) {
      const request = buildShotKiePayload(manifest, shot);
      const prior = intents.get(shot.id);
      if (prior?.request && stableJson(prior.request) !== stableJson(request)) throw new Error(`${shot.id}: recovery request does not match the saved request.`);
      if (prior && ['submitting', 'unknown', 'processing'].includes(prior.status) && !prior.provider?.taskId) throw new Error(`${shot.id}: submission state is unknown; reconcile before retrying.`);
    }
  }

  const generation = { generationId, templateId: plan.templateId, planHash: plan.planHash ?? null, model: manifest.model, mode, startedAt: now(), sourceDurationSeconds: plan.sourceDurationSeconds ?? null, expectedShotIds: plan.shots.map((shot) => shot.id), planSnapshot: structuredClone(plan), manifestSnapshot: structuredClone(manifest) };
  await saveGeneration(generation);
  const records = [];
  for (const shot of plan.shots) {
    const record = mode === 'dry-run'
      ? buildDryRunRecord({ plan, manifest, shot, now, generationId })
      : await buildLiveRecord({ plan, manifest, shot, client, now, saveRecord, existingRecords, pollTimeoutMs, generationId });
    records.push(record);
    await saveRecord(null, record);
  }
  return records;
}

function buildDryRunRecord({ plan, manifest, shot, now, generationId }) {
  const startedAt = now();
  return baseRecord({ plan, manifest, shot, startedAt, completedAt: now(), status: 'dry-run', generationId });
}

async function buildLiveRecord({ plan, manifest, shot, client, now, saveRecord, existingRecords, pollTimeoutMs, generationId }) {
  const priorAny = existingRecords.find((record) => record.shotId === shot.id);
  const prior = existingRecords.find((record) => record.shotId === shot.id && record.provider?.taskId);
  const startedAt = priorAny?.startedAt ?? now();
  const intent = existingRecords.find((record) => record.shotId === shot.id && ['submitting', 'unknown', 'processing'].includes(record.status));
  if (prior && ['success', 'completed', 'fail', 'failed', 'error', 'cancelled', 'canceled'].includes(prior.status)) return prior;
  if (intent && !prior) throw new Error(`${shot.id}: submission state is unknown; reconcile before retrying to avoid a duplicate paid task.`);
  let taskId = prior?.provider?.taskId ?? null;
  const request = buildShotKiePayload(manifest, shot);
  if (priorAny?.request && stableJson(priorAny.request) !== stableJson(request)) throw new Error(`${shot.id}: recovery request does not match the saved request.`);
  const submitting = baseRecord({ plan, manifest, shot, startedAt, completedAt: null, status: 'submitting', request, generationId });
  submitting.provider = { model: manifest.model, submissionPending: true };
  // A known task resumes directly; never write a taskless submitting record.
  if (!taskId) await saveRecord(null, submitting);
  let result;
  try {
    if (!taskId) {
      const created = await client.create(request);
      taskId = created?.data?.taskId ?? created?.taskId ?? created?.data?.id ?? created?.id;
      if (!taskId) throw new Error('Kie createTask returned no task ID; submission outcome is unknown.');
    }
  } catch (error) {
    const record = baseRecord({ plan, manifest, shot, startedAt, completedAt: now(), status: 'unknown', generationId });
    record.failureReasons = ['provider_failure'];
    record.provider = { model: manifest.model, taskId, error: error.message, reconciliationRequired: true };
    await saveRecord(null, record);
    return record;
  }
  const checkpoint = { ...submitting, status: 'processing', provider: { model: manifest.model, taskId }, startedAt };
  await saveRecord(null, checkpoint);
  try {
    result = await waitWithTimeout(client, taskId, pollTimeoutMs);
  } catch (error) {
    const record = baseRecord({ plan, manifest, shot, startedAt, completedAt: now(), status: 'unknown', request, generationId });
    record.failureReasons = ['provider_failure'];
    record.provider = { model: manifest.model, taskId, error: error.message, reconciliationRequired: true };
    await saveRecord(null, record);
    return record;
  }
  const status = String(result?.data?.state ?? result?.status ?? 'unknown').toLowerCase();
  const record = baseRecord({ plan, manifest, shot, startedAt, completedAt: now(), status, request, generationId });
  record.provider = { model: manifest.model, taskId, rawResult: result };
  record.costUsd = numberOrNull(result?.cost_usd ?? result?.data?.cost_usd ?? result?.usage?.cost_usd);
  record.creditsConsumed = numberOrNull(result?.data?.creditsConsumed ?? result?.creditsConsumed);
  record.providerCostTimeMs = numberOrNull(result?.data?.costTime ?? result?.costTime);
  record.outputVideoUrl = extractOutputUrl(result);
  if (status !== 'success') record.failureReasons = ['provider_failure'];
  await saveRecord(null, record);
  return record;
}

async function waitWithTimeout(client, taskId, timeoutMs) {
  return client.waitForCompletion(taskId, { timeoutMs });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function baseRecord({ plan, manifest, shot, startedAt, completedAt, status, request = buildShotKiePayload(manifest, shot), generationId = null }) {
  return {
    runId: `${plan.templateId}-${shot.id}`,
    templateId: plan.templateId,
    generationId,
    shotId: shot.id,
    slotCount: 1,
    source: { startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, durationSeconds: shot.endSeconds - shot.startSeconds },
    requestedDurationSeconds: shot.requestedDurationSeconds ?? manifest.providerDurationSeconds ?? (shot.endSeconds - shot.startSeconds),
    actualDurationSeconds: null,
    status,
    startedAt,
    completedAt,
    request,
    provider: { model: manifest.model },
    costUsd: null,
    creditsConsumed: null,
    providerCostTimeMs: null,
    outputVideoUrl: null,
    qualityReview: null,
    failureReasons: []
  };
}

function extractOutputUrl(result) {
  const value = result?.data?.resultJson ?? result?.resultJson;
  try {
    return (typeof value === 'string' ? JSON.parse(value) : value)?.resultUrls?.[0] ?? result?.data?.outputVideoUrl ?? null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  return value == null || typeof value === 'boolean' || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
}
