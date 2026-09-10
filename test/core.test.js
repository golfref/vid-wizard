import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildGenerationReport, buildKieTaskPayload, buildReport, buildSeedanceRequest, executeRun, readRecords, saveRecord, validateManifest } from '../poc/src/core.js';
import { createKieClient, retryTransient } from '../poc/src/provider-client.js';

const validRun = {
  id: 'solo', templateId: 'solo-template', slotCount: 1,
  templateVideoUrl: 'https://assets.example/template.mp4',
  references: [{ slot: 1, imageUrl: 'https://assets.example/person.jpg' }],
  prompt: 'Replace the full person.'
};

test('validates slot-to-reference mapping', () => {
  const errors = validateManifest({ runs: [{ ...validRun, slotCount: 2 }] });
  assert.ok(errors.some((error) => error.includes('references length')));
});

test('builds full-person reference-to-video request', () => {
  const request = buildSeedanceRequest(validRun, { model: 'seedance-2-5', durationSeconds: 15, resolution: '720p' });
  assert.deepEqual(request.input.video_urls, ['https://assets.example/template.mp4']);
  assert.deepEqual(request.input.image_urls, ['https://assets.example/person.jpg']);
  assert.equal(request.input.generation_type, 'reference-to-video');
});

test('reports success rate, latency and cost by slot count', () => {
  const rows = buildReport([
    { slotCount: 1, status: 'completed', startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:01:00.000Z', costUsd: 1.25, qualityReview: { usable: true } },
    { slotCount: 1, status: 'failed', startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:00:10.000Z', costUsd: null, qualityReview: null }
  ]);
  assert.equal(rows[0].successRate, 0.5);
  assert.equal(rows[0].medianLatencyMs, 60000);
  assert.equal(rows[0].averageCostUsd, 1.25);
  assert.equal(rows[0].qualityPassRate, 1);
});

test('builds the Kie Seedance 2.5 multimodal reference payload', () => {
  const payload = buildKieTaskPayload(validRun, {
    model: 'bytedance/seedance-2-5',
    durationSeconds: 5,
    resolution: '480p',
    aspectRatio: '16:9'
  });
  assert.deepEqual(payload, {
    model: 'bytedance/seedance-2-5',
    input: {
      prompt: 'Replace the full person.',
      reference_image_urls: ['https://assets.example/person.jpg'],
      reference_video_urls: ['https://assets.example/template.mp4'],
      generate_audio: false,
      return_last_frame: false,
      resolution: '480p',
      aspect_ratio: '16:9',
      duration: 5,
      output_format: 'mp4',
      web_search: false,
      nsfw_checker: true
    }
  });
});

test('Kie client submits a task and returns terminal task details', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/createTask')) {
      return response({ code: 200, msg: 'success', data: { taskId: 'task_123' } });
    }
    return response({ code: 200, msg: 'success', data: { state: 'success', resultJson: '{"resultUrls":["https://output.example/video.mp4"]}', costTime: 12000, creditsConsumed: 9 } });
  };
  const client = createKieClient({ apiKey: 'test-key', pollIntervalMs: 0, fetchImpl });
  const created = await client.create({ model: 'bytedance/seedance-2-5', input: {} });
  const result = await client.waitForCompletion(created.data.taskId);

  assert.equal(calls[0].url, 'https://api.kie.ai/api/v1/jobs/createTask');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
  assert.equal(calls[1].url, 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_123');
  assert.equal(result.data.state, 'success');
});

test('retries transient failures five times with one-second gaps', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(
    () => retryTransient(async () => { calls += 1; const error = new Error('maintenance'); error.transient = true; throw error; }, { sleepFn: async (ms) => delays.push(ms) }),
    /maintenance/
  );
  assert.equal(calls, 5);
  assert.deepEqual(delays, [1000, 1000, 1000, 1000]);
});

test('aborts a pending Kie status request at the polling deadline', async () => {
  let aborted = false;
  const client = createKieClient({ apiKey: 'test-key', pollIntervalMs: 0, requestTimeoutMs: 20, fetchImpl: async (_url, options = {}) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  await assert.rejects(() => client.waitForCompletion('pending', { timeoutMs: 20 }), /aborted|timed out/i);
  assert.equal(aborted, true);
});

test('stores successful Kie state, output URL, credits, and provider time in a live record', async () => {
  const record = await executeRun({
    run: validRun,
    manifest: { model: 'bytedance/seedance-2-5', durationSeconds: 5, resolution: '480p', aspectRatio: '16:9' },
    mode: 'live',
    requestBuilder: buildKieTaskPayload,
    now: (() => { const times = ['2026-09-07T00:00:00.000Z', '2026-09-07T00:00:12.000Z']; return () => times.shift(); })(),
    client: {
      create: async () => ({ data: { taskId: 'task_123' } }),
      waitForCompletion: async () => ({ data: { state: 'success', resultJson: '{"resultUrls":["https://output.example/video.mp4"]}', creditsConsumed: 9, costTime: 11800 } })
    }
  });
  assert.equal(record.status, 'success');
  assert.equal(record.outputVideoUrl, 'https://output.example/video.mp4');
  assert.equal(record.creditsConsumed, 9);
  assert.equal(record.providerCostTimeMs, 11800);
});

test('reads only run records and ignores review/final JSON artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-records-'));
  await writeFile(path.join(directory, 'shot.json'), JSON.stringify({ runId: 'shot-001', status: 'success' }));
  await writeFile(path.join(directory, 'review-template.json'), JSON.stringify([{ runId: 'shot-001', qualityReview: {} }]));
  await writeFile(path.join(directory, 'final-record.json'), JSON.stringify({ outputVideoPath: '/tmp/final.mp4' }));

  assert.deepEqual(await readRecords(directory), [{ runId: 'shot-001', status: 'success' }]);
});

test('saves records through an atomic rename without leaving temp files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidwizard-atomic-'));
  await saveRecord(directory, { runId: 'atomic', status: 'processing' });
  assert.deepEqual(await (await import('node:fs/promises')).readdir(directory), ['atomic.json']);
});

test('reports generation totals across all attempts and leaves unknown cost unknown', () => {
  const rows = buildGenerationReport(
    [{ generationId: 'g-1', templateId: 'horse', startedAt: '2026-09-07T00:00:00.000Z' }],
    [
      { generationId: 'g-1', status: 'success', costUsd: 1.2, creditsConsumed: 4 },
      { generationId: 'g-1', status: 'failed', costUsd: null, creditsConsumed: null }
    ], []
  );
  assert.equal(rows[0].totalAttempts, 2);
  assert.equal(rows[0].knownCostUsd, 1.2);
  assert.equal(rows[0].knownCredits, 4);
});

function response(body) {
  return { ok: true, json: async () => body };
}

test('per-request timeout remains bounded when polling deadline is longer', async()=>{
 const client=createKieClient({apiKey:'test',requestTimeoutMs:10,fetchImpl:async(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))});
 await assert.rejects(()=>client.waitForCompletion('pending',{timeoutMs:100}),/after 10ms/);
});
