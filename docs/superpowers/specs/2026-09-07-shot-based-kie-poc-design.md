# Shot-Based Kie POC Design

## Goal

Extend the existing Kie Seedance POC from one whole-video request into a one-slot, shot-based pipeline that detects scene cuts automatically, generates each shot independently, records operational metrics, and supports manual quality review before the final video is assembled.

## Scope

The first implementation supports one visible replacement person and one full-body reference image. It accepts a local template MP4 for analysis/cutting and public HTTPS URLs for Kie inputs. Multi-person replacement, automatic visual-description generation, automatic pass/reject, automatic retry, and a provider-specific cloud upload implementation are explicitly out of scope.

## Product decisions

- Scene detection is automatic via PySceneDetect's `AdaptiveDetector`.
- A reviewer can replace automatic cuts with exact shot boundaries in the manifest.
- A template-level prompt provides non-negotiable preservation constraints; each shot appends reviewer-authored context.
- Quality evaluation is report-only in this POC. A human reviewer chooses whether a completed shot is usable.
- The final concat is allowed only when every expected shot has a successful Kie output and a manual `usable: true` review.
- Kie API keys remain environment variables. Source code, manifests, records, and documentation must never contain an API key.

## Pipeline

```text
local template MP4
  -> detect automatic shot boundaries
  -> use manual boundaries when supplied
  -> reject shots shorter than the configured minimum
  -> cut local MP4 files with FFmpeg
  -> resolve a public URL for every cut shot
  -> create/poll one Kie task per shot
  -> save one immutable record per shot
  -> reviewer supplies quality review per completed shot
  -> verify all shots are successful and usable
  -> download output clips and concatenate them with FFmpeg
  -> save final template record and report
```

## Manifest contract

`poc/config/solo-shot-test.json` is the one-slot POC manifest. Its root fields are:

```json
{
  "pocName": "solo-shot-poc",
  "model": "bytedance/seedance-2-5",
  "resolution": "480p",
  "aspectRatio": "16:9",
  "durationSeconds": 5,
  "reference": {
    "slot": 1,
    "imageUrl": "https://public.example/reference-full-body.jpg"
  },
  "template": {
    "id": "horse-riding",
    "localVideoPath": "/absolute/path/template.mp4",
    "basePrompt": "Replace the entire visible person with the person from reference image 1. Preserve the horse, background, action, pose, framing, camera motion, timing, and lighting.",
    "sceneDetection": {
      "mode": "auto-with-override",
      "minShotDurationSeconds": 1.0,
      "adaptiveThreshold": 3.0
    },
    "shots": []
  }
}
```

When `template.shots` is empty, the detector's valid boundaries become the source of truth. When it contains entries, those entries replace the detector output and must be contiguous, ordered, non-overlapping, and within source duration:

```json
{
  "id": "shot-001",
  "startSeconds": 0,
  "endSeconds": 4.2,
  "promptSuffix": "Medium-wide side view. Preserve the seated riding pose and the rider's position in the left third of the frame.",
  "publicVideoUrl": "https://public.example/poc/horse-riding/shot-001.mp4"
}
```

`publicVideoUrl` is mandatory for live Kie generation. The pipeline creates the matching local shot at `poc/assets/<template-id>/shots/<shot-id>.mp4`; the user or a future storage adapter uploads it. The runner refuses live execution if the configured public URL is absent or not HTTPS.

## Components

### Scene service

A focused module executes PySceneDetect against the local template, parses scene boundaries, normalizes them to seconds, removes shots below `minShotDurationSeconds`, and assigns deterministic IDs (`shot-001`, `shot-002`, ...). It returns boundaries only; it does not write manifests or call Kie.

### Video service

A focused module probes duration with `ffprobe`, cuts each approved boundary with FFmpeg, and concatenates only an ordered set of local downloaded Kie outputs. It validates that all clips exist before FFmpeg is called.

### Shot planning

A module resolves automatic versus manual boundaries, validates their timeline, and creates a Kie run per shot. It combines `basePrompt` and trimmed `promptSuffix` into one prompt. Each task receives exactly one `reference_image_urls` entry and one `reference_video_urls` entry.

### Kie orchestration

The existing Kie client remains responsible only for create/poll API calls. The runner stores Kie task ID, provider state, output URL, consumed credits, provider processing time, timestamps, and raw response per shot.

### Manual quality review

A new review record schema is required for completed shots:

```json
{
  "usable": true,
  "identityMappingPass": true,
  "backgroundPreserved": true,
  "motionPreserved": true,
  "flickerAcceptable": true,
  "seamAcceptable": null,
  "failureReasons": [],
  "notes": "Rider identity is consistent; horse and background are preserved."
}
```

`seamAcceptable` is `null` for the only shot and a boolean for every transition after manual inspection. `failureReasons` uses controlled values: `identity_mismatch`, `body_artifact`, `background_changed`, `motion_changed`, `flicker`, `seam`, `provider_failure`, and `other`.

## Commands

The CLI adds these commands:

```bash
# Detect, validate and cut local source shots. No Kie request.
node poc/src/cli.js prepare --manifest poc/config/solo-shot-test.json

# Inspect resolved automatic/manual shot plan.
node poc/src/cli.js plan --manifest poc/config/solo-shot-test.json

# Call Kie once per shot with preconfigured publicVideoUrl values.
node poc/src/cli.js run-shots --manifest poc/config/solo-shot-test.json --mode live

# Create a review template from completed records, then review it manually.
node poc/src/cli.js review-template --runs-dir poc/runs/<run-id>

# Download approved output clips, concatenate them, and produce final record.
node poc/src/cli.js assemble --runs-dir poc/runs/<run-id>
```

`run-shots --mode dry-run` validates the full request plan without calling Kie. `assemble` fails closed if a shot is missing, is not a Kie success, lacks an output URL, lacks review, or is marked unusable.

## Error handling

- Missing `scenedetect`, `ffmpeg`, or `ffprobe`: fail before processing with install guidance.
- No cut found: create one boundary covering the complete video if it meets minimum duration.
- Manual boundaries invalid: report the exact boundary ID and rule violation; do not cut or call Kie.
- Missing/invalid public URL for live run: list affected shot IDs; do not create any Kie task.
- Kie terminal failure: record it with `provider_failure`; continue other independent shots, then make assembly unavailable.
- Expired output URL/download failure: preserve records and fail assembly; do not resubmit a paid task automatically.

## Testing and verification

- Unit tests cover automatic-boundary normalization, manual-boundary validation, prompt construction, request generation, review validation, and final-assembly eligibility.
- Command tests stub scene/FFmpeg/Kie boundaries so no real video, API key, or credit is required.
- A local integration smoke test uses a generated short MP4, verifies cut clips and concat output exist, and never calls Kie.
- A real Kie run remains opt-in and is verified manually against the one-slot horse-riding template.

## Success criteria

- A local MP4 becomes a deterministic sequence of valid shot clips automatically, with manual override support.
- A live one-slot run creates one Kie task and record per shot using the same reference image.
- The reviewer can record all six agreed quality dimensions and failure reasons.
- Assembly cannot create a final video from unreviewed, failed, or rejected shots.
- The report shows template/shot success, usable rate, latency, credits, and failure-reason counts.
