import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { assembleApprovedShots, canAssemble, createReviewTemplate, validateFinalReview, validateQualityReview } from '../poc/src/review-service.js';

const review = {
  usable: true,
  identityMappingPass: true,
  backgroundPreserved: true,
  motionPreserved: true,
  flickerAcceptable: true,
  seamAcceptable: null,
  failureReasons: [],
  notes: 'Identity and background are stable.'
};

test('creates a manual review template for every completed shot', () => {
  const template = createReviewTemplate([{ runId: 'horse-shot-001', shotId: 'shot-001', status: 'success', outputVideoUrl: 'https://output.example/one.mp4' }]);

  assert.deepEqual(template, [{ runId: 'horse-shot-001', shotId: 'shot-001', qualityReview: { ...review, usable: null, identityMappingPass: null, backgroundPreserved: null, motionPreserved: null, flickerAcceptable: null, notes: '' } }]);
});

test('rejects a review with an unknown failure reason', () => {
  assert.match(validateQualityReview({ ...review, failureReasons: ['invented_failure'] }).join('\n'), /failureReasons/);
});

test('requires a separate final video review with notes', () => {
  assert.deepEqual(validateFinalReview({ usable: true, notes: '' }), ['final review notes are required.']);
  assert.deepEqual(validateFinalReview({ usable: true, notes: 'Reviewed final seams.' }), []);
});

test('refuses assembly when a shot has no usable review', () => {
  assert.throws(() => canAssemble([
    { shotId: 'shot-001', status: 'success', outputVideoUrl: 'https://output.example/one.mp4', qualityReview: review },
    { shotId: 'shot-002', status: 'success', outputVideoUrl: 'https://output.example/two.mp4', qualityReview: null }
  ], { expectedShotIds: ['shot-001', 'shot-002'] }), /shot-002.*review/i);
});

test('allows assembly only when every shot is successful and usable', () => {
  assert.equal(canAssemble([{ shotId: 'shot-001', status: 'success', outputVideoUrl: 'https://output.example/one.mp4', qualityReview: review }], { expectedShotIds: ['shot-001'] }), true);
});

test('downloads approved clips and invokes FFmpeg concat', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-review-'));
  const calls = [];
  const result = await assembleApprovedShots({
    records: [{ shotId: 'shot-001', status: 'success', outputVideoUrl: 'https://output.example/one.mp4', qualityReview: review }],
    expectedShotIds: ['shot-001'],
    outputPath: path.join(directory, 'final.mp4'),
    tempDirectory: directory,
    download: async (_url, destination) => { await import('node:fs/promises').then(({ writeFile }) => writeFile(destination, 'clip')); },
    run: async (command, args) => { calls.push({ command, args }); },
    normalize: true,
    probe: async () => ({ durationSeconds: 1, streams: [{ codec_type: 'video' }] }),
    atomic: false
  });

  assert.equal(result.outputVideoPath, path.join(directory, 'final.mp4'));
  assert.equal(calls[0].command, 'ffmpeg');
  assert.match(await readFile(path.join(directory, 'concat.txt'), 'utf8'), /shot-001.mp4/);
});
