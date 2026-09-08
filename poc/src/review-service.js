import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './video-service.js';

const FAILURE_REASONS = new Set(['identity_mismatch', 'body_artifact', 'background_changed', 'motion_changed', 'flicker', 'seam', 'provider_failure', 'other']);

export function createReviewTemplate(records) {
  return records.filter((record) => record.status === 'success' && record.outputVideoUrl).map((record) => ({
    runId: record.runId,
    shotId: record.shotId,
    qualityReview: {
      usable: null,
      identityMappingPass: null,
      backgroundPreserved: null,
      motionPreserved: null,
      flickerAcceptable: null,
      seamAcceptable: null,
      failureReasons: [],
      notes: ''
    }
  }));
}

export function validateQualityReview(review) {
  const errors = [];
  for (const field of ['usable', 'identityMappingPass', 'backgroundPreserved', 'motionPreserved', 'flickerAcceptable']) {
    if (typeof review?.[field] !== 'boolean') errors.push(`${field} must be boolean.`);
  }
  if (review?.seamAcceptable !== null && typeof review?.seamAcceptable !== 'boolean') errors.push('seamAcceptable must be boolean or null.');
  if (!Array.isArray(review?.failureReasons) || review.failureReasons.some((reason) => !FAILURE_REASONS.has(reason))) errors.push('failureReasons must use supported reason codes.');
  if (!review?.notes?.trim()) errors.push('notes are required.');
  return errors;
}

export function validateFinalReview(review) {
  const errors = [];
  if (typeof review?.usable !== 'boolean') errors.push('final review usable must be boolean.');
  if (!review?.notes?.trim()) errors.push('final review notes are required.');
  return errors;
}

export function canAssemble(records, { expectedShotIds } = {}) {
  if (!records.length) throw new Error('No shot records are available for assembly.');
  if (!Array.isArray(expectedShotIds) || !expectedShotIds.length) throw new Error('Immutable expected shot order is required for assembly.');
  {
    const actual = records.map((record) => record.shotId);
    if (new Set(actual).size !== actual.length) throw new Error('Assembly contains duplicate shot records.');
    if (new Set(expectedShotIds).size !== expectedShotIds.length || actual.length !== expectedShotIds.length || expectedShotIds.some((id) => !actual.includes(id))) throw new Error(`Assembly must contain expected shots in plan order: ${expectedShotIds.join(', ')}.`);
  }
  for (const record of records) {
    if (record.status !== 'success') throw new Error(`${record.shotId}: status must be success before assembly.`);
    if (!record.outputVideoUrl) throw new Error(`${record.shotId}: outputVideoUrl is required before assembly.`);
    if (!record.qualityReview) throw new Error(`${record.shotId}: manual review is required before assembly.`);
    const errors = validateQualityReview(record.qualityReview);
    if (errors.length) throw new Error(`${record.shotId}: invalid manual review: ${errors.join(' ')}`);
    if (!record.qualityReview.usable) throw new Error(`${record.shotId}: review marked this shot unusable.`);
  }
  return true;
}

export async function assembleApprovedShots({ records, expectedShotIds, planSnapshot = null, templateId = null, outputPath, tempDirectory, download = downloadFile, run = runProcess, probe = null, normalize = false, sourceAudioPath = null, generationId = null, expectedDurationSeconds = null, width = 854, height = 480, atomic = true, finalize = rename, now = () => new Date().toISOString() }) {
  if (!Array.isArray(expectedShotIds) || !expectedShotIds.length) throw new Error('Immutable expected shot order is required for assembly.');
  if (typeof probe !== 'function') throw new Error('Media probe is required for assembly.');
  if (normalize !== true) throw new Error('Assembly requires normalization to the fixed video profile.');
  canAssemble(records, { expectedShotIds });
  const byId = new Map((planSnapshot?.shots ?? []).map((shot) => [shot.id, shot]));
  if (planSnapshot && expectedShotIds.some((id) => !byId.has(id))) throw new Error('Generation plan is missing an expected shot.');
  for (const record of records) {
    if (generationId && record.generationId !== generationId) throw new Error(`${record.shotId}: generationId does not match snapshot.`);
    if (templateId && record.templateId !== templateId) throw new Error(`${record.shotId}: templateId does not match snapshot.`);
    const shot = byId.get(record.shotId);
    if (shot && (!Number.isFinite(record.source?.startSeconds) || !Number.isFinite(record.source?.endSeconds) || Math.abs(Number(record.source?.startSeconds) - shot.startSeconds) > 0.001 || Math.abs(Number(record.source?.endSeconds) - shot.endSeconds) > 0.001)) throw new Error(`${record.shotId}: source interval does not match snapshot.`);
  }
  records = [...records].sort((a, b) => expectedShotIds.indexOf(a.shotId) - expectedShotIds.indexOf(b.shotId));
  await mkdir(tempDirectory, { recursive: true });
  const localPaths = [];
  const actualDurations = {};
  for (const record of records) {
    const localPath = path.join(tempDirectory, `${record.shotId}.mp4`);
    await download(record.outputVideoUrl, localPath);
    const sourceMedia = await probe(localPath);
    actualDurations[record.shotId] = sourceMedia.durationSeconds;
    const snapshotShot = byId.get(record.shotId);
    const expectedShotDuration = snapshotShot ? snapshotShot.endSeconds - snapshotShot.startSeconds : Number(record.source?.durationSeconds);
    if (Number.isFinite(expectedShotDuration) && Math.abs(sourceMedia.durationSeconds - expectedShotDuration) > (1 / 30 + 0.05)) throw new Error(`${record.shotId}: downloaded duration ${sourceMedia.durationSeconds.toFixed(3)}s does not match source interval ${expectedShotDuration}s.`);
    const normalizedPath = path.join(tempDirectory, `normalized-${record.shotId}.mp4`);
    await run('ffmpeg', ['-y', '-i', localPath, '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-f', 'mp4', normalizedPath]);
    const clipMedia = await probe(normalizedPath);
    if (!clipMedia.streams?.some((stream) => stream.codec_type === 'video')) throw new Error(`${record.shotId}: normalized output has no video stream.`);
    localPaths.push(normalizedPath);
  }
  const concatPath = path.join(tempDirectory, 'concat.txt');
  await writeFile(concatPath, `${localPaths.map((filePath) => `file '${path.resolve(filePath).replaceAll("'", "'\\\\''")}'`).join('\n')}\n`);
  const finalTempPath = atomic ? `${outputPath}.tmp-${process.pid}.mp4` : outputPath;
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath];
  if (sourceAudioPath) args.push('-i', sourceAudioPath, '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'libx264', '-c:a', 'aac');
  else args.push('-c', 'copy');
  if (sourceAudioPath && expectedDurationSeconds != null) args.push('-t', String(expectedDurationSeconds));
  args.push(finalTempPath);
  await run('ffmpeg', args);
  const artifact = { outputVideoPath: outputPath, assembledAt: now(), generationId, shotIds: records.map((record) => record.shotId), actualDurationSeconds: actualDurations, finalReview: null, usable: false };
  if (probe) {
    artifact.media = await probe(finalTempPath);
    artifact.finalDurationSeconds = artifact.media.durationSeconds;
    if (expectedDurationSeconds != null && Math.abs(artifact.media.durationSeconds - expectedDurationSeconds) > 0.1) {
      throw new Error(`Final video duration ${artifact.media.durationSeconds.toFixed(3)}s does not match expected ${expectedDurationSeconds}s.`);
    }
  }
  if (atomic) await finalize(finalTempPath, outputPath);
  return artifact;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot download generated video: HTTP ${response.status}.`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}
