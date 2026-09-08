# Shot-Based Kie POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-slot shot pipeline that detects/cuts scenes, calls Kie per shot, records manual review, and assembles only approved shots.

**Architecture:** Node modules keep scene detection, FFmpeg operations, shot planning, Kie orchestration, and review/assembly separate. Kie receives only public HTTPS URLs; upload remains an explicit operator checkpoint until a storage provider is selected.

**Tech Stack:** Node.js 22 ESM, node:test, PySceneDetect CLI, FFmpeg/ffprobe, Kie.ai Seedance 2.5 API.

**Spec:** `docs/superpowers/specs/2026-09-07-shot-based-kie-poc-design.md`

## Global Constraints

- One full-body reference image and one replacement slot only.
- Automatic PySceneDetect AdaptiveDetector plus explicit manual cut override.
- Never persist `KIE_API_KEY`.
- Quality review is report-only; no auto-retry or auto-reject.
- Assembly fails closed unless every shot has Kie success, output URL, and `qualityReview.usable: true`.
- Every production change starts with a failing node:test test.

---

### Task 1: Shot manifest and planning

**Files:**
- Create: `poc/src/shot-plan.js`
- Create: `test/shot-plan.test.js`
- Create: `poc/config/solo-shot-test.example.json`

**Interfaces:**
- `validateShotManifest(manifest)`
- `resolveShotPlan(manifest, detectedShots)`
- `buildShotPrompt(basePrompt, promptSuffix)`
- `buildShotKiePayload(manifest, shot)`

- [ ] **Step 1: Write a failing automatic-plan test**

```js
test('uses detected cuts when no manual shots are declared', () => {
  const plan = resolveShotPlan(manifest, [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 2, endSeconds: 5 }]);
  assert.deepEqual(plan.shots.map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds })), [
    { id: 'shot-001', startSeconds: 0, endSeconds: 2 },
    { id: 'shot-002', startSeconds: 2, endSeconds: 5 }
  ]);
});
```

- [ ] **Step 2: Run `node --test test/shot-plan.test.js`**

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement plan resolution**

Validate one reference, local source path, base prompt, ordered non-overlapping boundaries, and explicit manual overrides. Generate deterministic shot IDs. Require each public video URL only in live mode.

- [ ] **Step 4: Run `node --test test/shot-plan.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add poc/src/shot-plan.js poc/config/solo-shot-test.example.json test/shot-plan.test.js
git commit -m "feat: add shot manifest planning"
```

### Task 2: Scene detection and FFmpeg services

**Files:**
- Create: `poc/src/scene-service.js`
- Create: `poc/src/video-service.js`
- Create: `test/scene-service.test.js`
- Create: `test/video-service.test.js`

**Interfaces:**
- `assertVideoTools({ run })`
- `detectScenes({ inputPath, adaptiveThreshold, minShotDurationSeconds, run })`
- `cutShots({ inputPath, shots, outputDirectory, run })`

- [ ] **Step 1: Write failing service tests**

```js
test('filters short detected scenes', async () => {
  const shots = await detectScenes({ inputPath: '/tmp/source.mp4', adaptiveThreshold: 3, minShotDurationSeconds: 1, run: fakeSceneDetect });
  assert.deepEqual(shots, [{ startSeconds: 0, endSeconds: 2.5 }]);
});
test('creates deterministic FFmpeg output paths', async () => {
  const result = await cutShots({ inputPath: '/tmp/source.mp4', shots: [{ id: 'shot-001', startSeconds: 0, endSeconds: 2 }], outputDirectory: '/tmp/shots', run: fakeFfmpeg });
  assert.equal(result[0].localVideoPath, '/tmp/shots/shot-001.mp4');
});
```

- [ ] **Step 2: Run `node --test test/scene-service.test.js test/video-service.test.js`**

Expected: FAIL because service modules are absent.

- [ ] **Step 3: Implement services**

Use `spawn` with no shell. Run PySceneDetect AdaptiveDetector to a task CSV and parse seconds. Use FFmpeg `-ss` and `-t`, re-encoding H.264/AAC MP4 for reliable concat. Check `scenedetect`, `ffmpeg`, and `ffprobe` through `--version` with operator-friendly missing-tool errors.

- [ ] **Step 4: Run `node --test test/scene-service.test.js test/video-service.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add poc/src/scene-service.js poc/src/video-service.js test/scene-service.test.js test/video-service.test.js
git commit -m "feat: detect and cut template shots"
```

### Task 3: Per-shot Kie generation

**Files:**
- Create: `poc/src/shot-runner.js`
- Create: `test/shot-runner.test.js`
- Modify: `poc/src/core.js`

**Interfaces:**
- `runShots({ plan, manifest, mode, client, now, saveRecord })`
- One record per shot with source times, request, Kie task/result, credits, provider time, URL, and `qualityReview: null`.

- [ ] **Step 1: Write a failing per-shot test**

```js
test('builds one request for each shot using the same reference image', async () => {
  const records = await runShots({ plan: twoShotPlan, manifest, mode: 'dry-run', saveRecord: async () => {} });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].request.input.reference_image_urls, ['https://cdn.example/person.jpg']);
  assert.equal(records[1].request.input.reference_video_urls[0], 'https://cdn.example/shot-002.mp4');
});
```

- [ ] **Step 2: Run `node --test test/shot-runner.test.js`**

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Implement sequential runner**

Fail before any live Kie request if any shot lacks a valid public URL. Reuse the existing Kie client. Persist provider terminal failures with `provider_failure` instead of losing earlier records.

- [ ] **Step 4: Run `node --test test/shot-runner.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add poc/src/shot-runner.js poc/src/core.js test/shot-runner.test.js
git commit -m "feat: run Kie generation per shot"
```

### Task 4: Manual review and safe assembly

**Files:**
- Create: `poc/src/review-service.js`
- Create: `test/review-service.test.js`
- Modify: `poc/src/video-service.js`

**Interfaces:**
- `createReviewTemplate(records)`
- `validateQualityReview(review)`
- `canAssemble(records)`
- `assembleApprovedShots({ records, outputPath, download, run })`

- [ ] **Step 1: Write a failing fail-closed test**

```js
test('refuses assembly when a shot has no usable review', () => {
  assert.throws(() => canAssemble([
    { status: 'success', outputVideoUrl: 'https://x/1.mp4', qualityReview: { usable: true } },
    { status: 'success', outputVideoUrl: 'https://x/2.mp4', qualityReview: null }
  ]));
});
```

- [ ] **Step 2: Run `node --test test/review-service.test.js`**

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement review and concat**

Validate identity/background/motion/flicker booleans, nullable/boolean seam, controlled failure reasons, and notes. Download approved outputs to a temporary directory and use FFmpeg concat demuxer. Persist final output path, timestamp, and shot IDs only after success.

- [ ] **Step 4: Run `node --test test/review-service.test.js`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add poc/src/review-service.js poc/src/video-service.js test/review-service.test.js
git commit -m "feat: add review and safe shot assembly"
```

### Task 5: CLI, docs, and smoke tests

**Files:**
- Modify: `poc/src/cli.js`
- Modify: `poc/README.md`
- Create: `test/cli-shot-flow.test.js`
- Modify: `package.json`

**Interfaces:**
- CLI commands: `plan`, `prepare`, `run-shots`, `review-template`, and `assemble`.
- npm scripts: `poc:plan` and `poc:prepare`.

- [ ] **Step 1: Write failing CLI integration test**

```js
test('dry-run writes a record for every resolved shot', async () => {
  const result = await runCli(['run-shots', '--manifest', fixturePath, '--mode', 'dry-run', '--runs-dir', outputDirectory]);
  assert.equal(result.exitCode, 0);
  assert.equal((await readdir(outputDirectory, { recursive: true })).filter((file) => file.endsWith('.json')).length, 2);
});
```

- [ ] **Step 2: Run `node --test test/cli-shot-flow.test.js`**

Expected: FAIL because the CLI command is absent.

- [ ] **Step 3: Implement commands**

`prepare` detects/cuts and saves a resolved plan. `plan` displays boundaries. `run-shots` creates shot records. `review-template` emits review JSON. `assemble` validates then joins approved clips.

- [ ] **Step 4: Document one-slot workflow**

Document prerequisites, upload checkpoint, environment variables, dry-run, review, assembly, and no-credit local verification.

- [ ] **Step 5: Run full verification**

```bash
npm test
npm run poc:validate
npm run poc:dry-run
git diff --check
```

Expected: all tests pass, no whitespace errors, and no Kie API request.

- [ ] **Step 6: Commit**

```bash
git add poc/src/cli.js poc/README.md package.json test/cli-shot-flow.test.js
git commit -m "feat: expose shot-based POC workflow"
```

