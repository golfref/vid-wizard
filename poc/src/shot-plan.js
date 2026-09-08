import { createHash } from 'node:crypto';
import path from 'node:path';

const PUBLIC_URL_PATTERN = /^https:\/\/[^/]+/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateShotManifest(manifest) {
  const errors = [];
  if (!manifest?.template?.id) errors.push('template.id is required.');
  else if (!SAFE_ID.test(String(manifest.template.id))) errors.push('template.id is not a safe id.');
  if (!manifest?.template?.localVideoPath) errors.push('template.localVideoPath is required.');
  if (!manifest?.template?.basePrompt?.trim()) errors.push('template.basePrompt is required.');
  if (manifest?.reference?.slot !== 1) errors.push('reference.slot must be 1 for the one-slot POC.');
  if (!isPublicHttpsUrl(manifest?.reference?.imageUrl)) errors.push('reference.imageUrl must be a public HTTPS URL.');
  const settings = manifest?.template?.sceneDetection;
  if (settings?.mode !== 'auto-with-override') errors.push('template.sceneDetection.mode must be auto-with-override.');
  if (!isPositiveNumber(settings?.minShotDurationSeconds)) errors.push('template.sceneDetection.minShotDurationSeconds must be positive.');
  if (!isPositiveNumber(settings?.adaptiveThreshold)) errors.push('template.sceneDetection.adaptiveThreshold must be positive.');
  if (manifest?.providerDurationSeconds != null && !isPositiveNumber(manifest.providerDurationSeconds)) errors.push('providerDurationSeconds must be positive when provided.');
  errors.push(...validateBoundaries(manifest?.template?.shots ?? [], 'template.shots'));
  return errors;
}

export function resolveShotPlan(manifest, detectedShots, { sourceDuration } = {}) {
  const errors = validateShotManifest(manifest);
  if (errors.length) throw new Error(errors.join('\n'));
  const sourceShots = manifest.template.shots?.length ? manifest.template.shots : detectedShots;
  const normalized = normaliseShots(sourceShots);
  const boundaryErrors = validateBoundaries(normalized, 'resolved shots', { sourceDuration });
  if (!normalized.length) boundaryErrors.push('resolved shots must contain at least one shot.');
  if (boundaryErrors.length) throw new Error(boundaryErrors.join('\n'));
  const plan = {
    planVersion: 1,
    templateId: manifest.template.id,
    localVideoPath: manifest.template.localVideoPath,
    reference: manifest.reference,
    basePrompt: manifest.template.basePrompt.trim(),
    sceneDetection: manifest.template.sceneDetection,
    sourceDurationSeconds: sourceDuration ?? manifest.template.sourceDurationSeconds ?? null,
    shots: normalized
  };
  plan.planHash = hashPlan(plan);
  return plan;
}

export function hashPlan(plan) {
  const copy = structuredClone(plan);
  delete copy.planHash;
  delete copy.sourceMedia;
  for (const shot of copy.shots ?? []) {
    delete shot.localVideoPath;
    // CDN upload URLs are added after prepare; boundaries, prompts and order stay immutable.
    delete shot.publicVideoUrl;
  }
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

export function validateSavedShotPlan(plan, manifest, { requireSourceDuration = true } = {}) {
  const errors = [];
  if (plan?.planVersion !== 1) errors.push('saved plan has unsupported planVersion.');
  if (plan?.templateId !== manifest?.template?.id) errors.push('saved plan templateId does not match manifest template.id.');
  if (plan?.localVideoPath && manifest?.template?.localVideoPath && path.resolve(plan.localVideoPath) !== path.resolve(manifest.template.localVideoPath)) errors.push('saved plan localVideoPath does not match manifest.');
  if (stableJson(plan?.reference) !== stableJson(manifest?.reference)) errors.push('saved plan reference does not match manifest.');
  if (String(plan?.basePrompt ?? '').trim() !== String(manifest?.template?.basePrompt ?? '').trim()) errors.push('saved plan basePrompt does not match manifest.');
  if (!plan?.planHash || plan.planHash !== hashPlan(plan)) errors.push('saved plan hash does not match its contents; regenerate the plan.');
  if (!Array.isArray(plan?.shots) || !plan.shots.length) errors.push('saved plan must contain at least one shot.');
  if (requireSourceDuration && !isPositiveNumber(plan?.sourceDurationSeconds)) errors.push('saved plan sourceDurationSeconds must be positive.');
  errors.push(...validateBoundaries(plan?.shots ?? [], 'saved plan', { sourceDuration: plan?.sourceDurationSeconds }));
  return errors;
}

function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }

export function buildShotPrompt(basePrompt, promptSuffix = '') {
  return [basePrompt?.trim(), promptSuffix?.trim()].filter(Boolean).join(' ');
}

export function buildShotKiePayload(manifest, shot) {
  if (!isPublicHttpsUrl(shot?.publicVideoUrl) || isPlaceholderUrl(shot.publicVideoUrl)) {
    throw new Error(`${shot?.id ?? 'shot'}: publicVideoUrl must be a public HTTPS URL for Kie live generation.`);
  }
  return {
    model: manifest.model ?? 'bytedance/seedance-2-5',
    input: {
      prompt: buildShotPrompt(manifest.template.basePrompt, shot.promptSuffix),
      reference_image_urls: [manifest.reference.imageUrl],
      reference_video_urls: [shot.publicVideoUrl],
      generate_audio: false,
      return_last_frame: false,
      resolution: manifest.resolution ?? '480p',
      aspect_ratio: manifest.aspectRatio ?? '16:9',
      // Provider duration is explicit: default to the source shot duration,
      // unless the manifest declares a supported provider duration contract.
      duration: shot.requestedDurationSeconds ?? manifest.providerDurationSeconds ?? (shot.endSeconds - shot.startSeconds),
      output_format: 'mp4',
      web_search: false,
      nsfw_checker: true
    }
  };
}

export function isPublicHttpsUrl(value) {
  return typeof value === 'string' && PUBLIC_URL_PATTERN.test(value);
}

function normaliseShots(shots) {
  return shots.map((shot, index) => ({
    ...shot,
    id: shot.id ?? `shot-${String(index + 1).padStart(3, '0')}`,
    startSeconds: Number(shot.startSeconds),
    endSeconds: Number(shot.endSeconds),
    promptSuffix: shot.promptSuffix ?? '',
    requestedDurationSeconds: shot.requestedDurationSeconds == null ? undefined : Number(shot.requestedDurationSeconds)
  }));
}

export function validateBoundaries(shots, label, { sourceDuration } = {}) {
  const errors = [];
  let previousEnd = -Infinity;
  const ids = new Set();
  for (const shot of shots) {
    if (ids.has(shot.id)) errors.push(`${label}: duplicate shot id ${shot.id}.`);
    ids.add(shot.id);
    if (!shot.id) errors.push(`${label}: every shot needs an id.`);
    else if (!SAFE_ID.test(String(shot.id))) errors.push(`${label}: ${shot.id} is not a safe shot id.`);
    if (!Number.isFinite(Number(shot.startSeconds)) || !Number.isFinite(Number(shot.endSeconds)) || Number(shot.startSeconds) < 0 || Number(shot.endSeconds) <= Number(shot.startSeconds)) {
      errors.push(`${label}: ${shot.id ?? 'shot'} has invalid boundaries.`);
      continue;
    }
    if (Number(shot.startSeconds) < previousEnd) errors.push(`${label}: ${shot.id} overlaps the preceding shot.`);
    if (shots.indexOf(shot) > 0 && Number(shot.startSeconds) > previousEnd + 0.001) errors.push(`${label}: ${shot.id} leaves a timeline gap after ${previousEnd}s.`);
    if (sourceDuration != null && Number(shot.endSeconds) > Number(sourceDuration) + 0.001) errors.push(`${label}: ${shot.id} ends after source duration ${sourceDuration}s.`);
    if (shot.requestedDurationSeconds != null && !isPositiveNumber(shot.requestedDurationSeconds)) errors.push(`${label}: ${shot.id} requestedDurationSeconds must be positive.`);
    previousEnd = Number(shot.endSeconds);
  }
  if (shots.length && Number(shots[0].startSeconds) > 0.001) errors.push(`${label}: timeline must start at 0s.`);
  if (sourceDuration != null && shots.length && Math.abs(Number(shots.at(-1).endSeconds) - Number(sourceDuration)) > 0.001) errors.push(`${label}: timeline must end at source duration ${sourceDuration}s.`);
  return errors;
}

function isPositiveNumber(value) {
  return typeof value !== 'boolean' && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
}

function isPlaceholderUrl(value) {
  try { return new URL(value).hostname === 'replace-with-public-url.example'; } catch { return false; }
}
