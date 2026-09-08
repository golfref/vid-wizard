import assert from 'node:assert/strict';
import test from 'node:test';
import { runShots } from '../poc/src/shot-runner.js';

const manifest = {
  model: 'bytedance/seedance-2-5', resolution: '480p', aspectRatio: '16:9', durationSeconds: 5,
  reference: { slot: 1, imageUrl: 'https://assets.example/person.jpg' },
  template: { basePrompt: 'Replace the full person.' }
};
const plan = {
  templateId: 'horse-riding',
  reference: manifest.reference,
  basePrompt: manifest.template.basePrompt,
  shots: [
    { id: 'shot-001', startSeconds: 0, endSeconds: 2, publicVideoUrl: 'https://assets.example/shot-001.mp4', promptSuffix: 'Wide shot.' },
    { id: 'shot-002', startSeconds: 2, endSeconds: 5, publicVideoUrl: 'https://assets.example/shot-002.mp4', promptSuffix: 'Close shot.' }
  ]
};

test('creates one dry-run record for each shot with the shared reference image', async () => {
  const saved = [];
  const records = await runShots({ plan, manifest, mode: 'dry-run', saveRecord: async (_, record) => saved.push(record), now: (() => { let index = 0; return () => `2026-09-07T00:00:0${index++}.000Z`; })() });

  assert.equal(records.length, 2);
  assert.equal(saved.length, 2);
  assert.deepEqual(records[0].request.input.reference_image_urls, ['https://assets.example/person.jpg']);
  assert.equal(records[1].request.input.reference_video_urls[0], 'https://assets.example/shot-002.mp4');
  assert.equal(records[0].qualityReview, null);
});

test('refuses all live generation before creating a task when any shot lacks a public URL', async () => {
  const invalidPlan = structuredClone(plan);
  invalidPlan.shots[1].publicVideoUrl = '';
  let creates = 0;

  await assert.rejects(
    () => runShots({ plan: invalidPlan, manifest, mode: 'live', client: { create: async () => { creates += 1; } } }),
    /shot-002.*publicVideoUrl/i
  );
  assert.equal(creates, 0);
});

test('records a terminal Kie failure without discarding another successful shot', async () => {
  let call = 0;
  const records = await runShots({
    plan,
    manifest,
    mode: 'live',
    client: {
      create: async () => ({ data: { taskId: `task-${++call}` } }),
      waitForCompletion: async (taskId) => taskId === 'task-1'
        ? { data: { state: 'success', resultJson: '{"resultUrls":["https://output.example/one.mp4"]}', creditsConsumed: 3, costTime: 1000 } }
        : { data: { state: 'fail', creditsConsumed: 0, costTime: 50 } }
    }
  });

  assert.equal(records[0].status, 'success');
  assert.equal(records[0].outputVideoUrl, 'https://output.example/one.mp4');
  assert.equal(records[1].status, 'fail');
  assert.deepEqual(records[1].failureReasons, ['provider_failure']);
});

test('resumes a known task without creating or writing a taskless submitting checkpoint', async () => {
  const saved = [];
  let creates = 0;
  const existing = [{ ...baseRecord('shot-001'), status: 'processing', startedAt: '2026-09-07T00:00:00.000Z', provider: { taskId: 'known-task' }, request: undefined }];
  const records = await runShots({ plan: { ...plan, shots: [plan.shots[0]] }, manifest, mode: 'live', existingRecords: existing, saveRecord: async (_, record) => saved.push(record), client: { create: async () => { creates += 1; }, waitForCompletion: async () => ({ data: { state: 'success', resultJson: '{"resultUrls":["https://output.example/one.mp4"]}' } }) } });
  assert.equal(creates, 0);
  assert.equal(records[0].startedAt, '2026-09-07T00:00:00.000Z');
  assert.ok(saved.every((record) => record.status !== 'submitting'));
  assert.ok(saved.every((record) => record.provider.taskId === 'known-task'));
});

test('blocks every create when any existing taskless submission is unknown', async () => {
  let creates = 0;
  await assert.rejects(() => runShots({ plan, manifest, mode: 'live', existingRecords: [{ shotId: 'shot-002', status: 'unknown', provider: {} }], client: { create: async () => { creates += 1; } } }), /submission state is unknown/);
  assert.equal(creates, 0);
});

test('rejects recovery when the saved payload changed', async () => {
  await assert.rejects(() => runShots({ plan: { ...plan, shots: [plan.shots[0]] }, manifest, mode: 'live', existingRecords: [{ shotId: 'shot-001', status: 'processing', startedAt: 'x', provider: { taskId: 't' }, request: { changed: true } }], client: { create: async () => { throw new Error('must not create'); } } }), /request does not match/);
});

test('does not resubmit a terminal failure on resume', async () => {
  let creates = 0;
  const existing = [{ ...baseRecord('shot-001'), status: 'fail', provider: { taskId: 'failed-task' }, request: undefined }];
  const records = await runShots({ plan: { ...plan, shots: [plan.shots[0]] }, manifest, mode: 'live', existingRecords: existing, client: { create: async () => { creates += 1; } } });
  assert.equal(creates, 0);
  assert.equal(records[0].status, 'fail');
});

function baseRecord(shotId) {
  return { runId: `horse-${shotId}`, templateId: 'horse-riding', shotId, request: undefined, provider: {} };
}

test('poll errors retain task ID and checkpoint write errors stop the run', async()=>{
 const one={...plan,shots:[plan.shots[0]]};
 const rows=await runShots({plan:one,manifest,mode:'live',client:{create:async()=>({taskId:'paid'}),waitForCompletion:async()=>{throw Error('network')}}});
 assert.equal(rows[0].provider.taskId,'paid');
 assert.equal(rows[0].status,'unknown');
 let polls=0;
 await assert.rejects(()=>runShots({plan:one,manifest,mode:'live',saveRecord:async(_,r)=>{if(r.status==='processing') throw Error('disk full')},client:{create:async()=>({taskId:'paid'}),waitForCompletion:async()=>{polls++}}}),/disk full/);
 assert.equal(polls,0);
});
test('missing or boolean provider accounting is never converted to zero',async()=>{
 const rows=await runShots({plan:{...plan,shots:[plan.shots[0]]},manifest,mode:'live',client:{create:async()=>({taskId:'paid'}),waitForCompletion:async()=>({data:{state:'success',creditsConsumed:false,cost_usd:1.25}})}});
 assert.equal(rows[0].creditsConsumed,null);
 assert.equal(rows[0].costUsd,1.25);
});
