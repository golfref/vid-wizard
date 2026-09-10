import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShotKiePayload, buildShotPrompt, resolveShotPlan, validateSavedShotPlan, validateShotManifest } from '../poc/src/shot-plan.js';

const manifest = {
  pocName: 'solo-shot-poc',
  model: 'bytedance/seedance-2-5',
  resolution: '480p',
  aspectRatio: '16:9',
  durationSeconds: 5,
  reference: { slot: 1, imageUrl: 'https://assets.example/person.jpg' },
  template: {
    id: 'horse-riding',
    localVideoPath: '/tmp/horse-riding.mp4',
    basePrompt: 'Replace the entire person and preserve the horse.',
    sceneDetection: { mode: 'auto-with-override', minShotDurationSeconds: 1, adaptiveThreshold: 3 },
    shots: []
  }
};

test('uses detected cuts when no manual shots are declared', () => {
  const plan = resolveShotPlan(manifest, [
    { startSeconds: 0, endSeconds: 2 },
    { startSeconds: 2, endSeconds: 5 }
  ]);

  assert.deepEqual(plan.shots.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds })), [
    { id: 'shot-001', startSeconds: 0, endSeconds: 2 },
    { id: 'shot-002', startSeconds: 2, endSeconds: 5 }
  ]);
});

test('uses manual shots instead of detected cuts and joins the prompt context', () => {
  const withOverride = structuredClone(manifest);
  withOverride.template.shots = [{
    id: 'wide-riding',
    startSeconds: 0,
    endSeconds: 5,
    promptSuffix: 'Wide side view. Preserve the seated riding pose.',
    publicVideoUrl: 'https://assets.example/wide-riding.mp4'
  }];

  const plan = resolveShotPlan(withOverride, [{ startSeconds: 0, endSeconds: 1 }]);

  assert.equal(plan.shots[0].id, 'wide-riding');
  assert.equal(buildShotPrompt(withOverride.template.basePrompt, plan.shots[0].promptSuffix), 'Replace the entire person and preserve the horse. Wide side view. Preserve the seated riding pose.');
});

test('rejects overlapping manual shots', () => {
  const invalid = structuredClone(manifest);
  invalid.template.shots = [
    { id: 'one', startSeconds: 0, endSeconds: 3 },
    { id: 'two', startSeconds: 2.9, endSeconds: 5 }
  ];

  assert.match(validateShotManifest(invalid).join('\n'), /overlap/);
});

test('builds a one-slot Kie request for a public shot', () => {
  const shot = {
    id: 'shot-001',
    startSeconds: 0,
    endSeconds: 5,
    publicVideoUrl: 'https://assets.example/shot-001.mp4',
    promptSuffix: 'Keep the rider seated.'
  };

  const payload = buildShotKiePayload(manifest, shot);

  assert.deepEqual(payload.input.reference_image_urls, ['https://assets.example/person.jpg']);
  assert.deepEqual(payload.input.reference_video_urls, ['https://assets.example/shot-001.mp4']);
  assert.equal(payload.input.prompt, 'Replace the entire person and preserve the horse. Keep the rider seated.');
});

test('builds a two-slot Kie request in slot order', () => {
  const twoSlotManifest = structuredClone(manifest);
  delete twoSlotManifest.reference;
  twoSlotManifest.references = [
    { slot: 1, imageUrl: 'https://assets.example/fighter-a.jpg' },
    { slot: 2, imageUrl: 'https://assets.example/fighter-b.jpg' }
  ];
  const shot = { id: 'shot-001', startSeconds: 0, endSeconds: 15, publicVideoUrl: 'https://assets.example/fight.mp4' };

  assert.deepEqual(buildShotKiePayload(twoSlotManifest, shot).input.reference_image_urls, [
    'https://assets.example/fighter-a.jpg',
    'https://assets.example/fighter-b.jpg'
  ]);
  assert.deepEqual(validateShotManifest(twoSlotManifest), []);
});

test('rejects a mutated saved plan using its immutable hash', () => {
  const plan = resolveShotPlan(manifest, [{ startSeconds: 0, endSeconds: 5 }], { sourceDuration: 5 });
  plan.shots[0].endSeconds = 4;
  assert.match(validateSavedShotPlan(plan, manifest).join('\n'), /hash/i);
});

test('plan rejects gaps, lost head/tail and manifest identity mismatch',()=>{
 for(const shots of [[{startSeconds:1,endSeconds:5}],[{startSeconds:0,endSeconds:4}],[{startSeconds:0,endSeconds:2},{startSeconds:3,endSeconds:5}]]) assert.throws(()=>resolveShotPlan(manifest,shots,{sourceDuration:5}));
 const plan=resolveShotPlan(manifest,[{startSeconds:0,endSeconds:5}],{sourceDuration:5});
 assert.match(validateSavedShotPlan(plan,{...manifest,reference:{slot:1,imageUrl:'https://example.com/different.jpg'}}).join(' '),/reference/);
});
