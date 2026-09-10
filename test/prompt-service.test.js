import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptRequest, generateShotPrompts, parsePromptResponse } from '../poc/src/prompt-service.js';

const manifest = {
  template: { basePrompt: 'Replace only the visible person.' },
  promptGeneration: { enabled: true, model: 'gpt-5-6-luna', reasoningEffort: 'medium', sourceVideoUrl: 'https://assets.example/shot.mp4' }
};
const plan = { shots: [{ id: 'shot-001', startSeconds: 0, endSeconds: 4.5 }] };

test('creates a multimodal Kie prompt request with an uploaded shot video', () => {
  const request = buildPromptRequest({ manifest, shot: plan.shots[0], fileUrl: 'https://kie-files.example/temp-1-shot-001.mp4' });
  assert.equal(request.model, 'gpt-5-6-luna');
  assert.equal(request.input[0].content[1].file_url, 'https://kie-files.example/temp-1-shot-001.mp4');
  assert.equal(request.input[0].content[1].type, 'input_file');
  assert.match(request.input[0].content[0].text, /JSON only/);
});

test('stores a generated prompt and trace metadata in the plan', async () => {
  const result = await generateShotPrompts({ plan, manifest, now: () => '2026-09-09T00:00:00.000Z', client: { uploadFromUrl: async () => ({ downloadUrl: 'https://kie-files.example/temp-1-shot-001.mp4', expiresAt: '2026-09-10T00:00:00.000Z' }), generate: async () => ({ output: [{ content: [{ type: 'output_text', text: '{"promptSuffix":"Replace only the visible person. Preserve the lake.","negativePrompt":"No text or logos."}' }] }], credits_consumed: 0.2 }) } });
  assert.equal(result.shots[0].promptSuffix, 'Replace only the visible person. Preserve the lake.');
  assert.equal(result.shots[0].promptGeneration.sourceVideoUrl, manifest.promptGeneration.sourceVideoUrl);
  assert.equal(result.shots[0].promptGeneration.creditsConsumed, 0.2);
});

test('rejects malformed LLM output', () => assert.throws(() => parsePromptResponse({ output: [{ content: [{ type: 'output_text', text: 'not json' }] }] }), /valid JSON/));
