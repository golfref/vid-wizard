const DEFAULT_MODEL = 'gpt-5-6-luna';

export async function generateShotPrompts({ plan, manifest, client, now = () => new Date().toISOString() }) {
  const settings = manifest.promptGeneration;
  if (!settings?.enabled) return plan;
  if (!client) throw new Error('A Kie prompt client is required when promptGeneration.enabled is true.');

  const shots = [];
  for (const shot of plan.shots) {
    const sourceVideoUrl = resolveSourceVideoUrl(settings, manifest, shot);
    if (!isPublicHttpsUrl(sourceVideoUrl)) throw new Error(`${shot.id}: promptGeneration requires a public HTTPS sourceVideoUrl or publicVideoUrl.`);
    const uploadedFile = await client.uploadFromUrl({ sourceVideoUrl, fileName: `${plan.templateId}-${shot.id}.mp4` });
    const fileUrl = uploadedFile.downloadUrl ?? uploadedFile.fileUrl;
    if (!isPublicHttpsUrl(fileUrl)) throw new Error(`${shot.id}: Kie file upload returned no HTTPS file URL.`);
    const request = buildPromptRequest({ manifest, shot, fileUrl });
    const response = await client.generate(request);
    const generated = parsePromptResponse(response);
    shots.push({
      ...shot,
      promptSuffix: generated.promptSuffix,
      negativePrompt: generated.negativePrompt,
      promptGeneration: {
        provider: 'kie.ai',
        model: settings.model ?? DEFAULT_MODEL,
        reasoningEffort: settings.reasoningEffort ?? 'medium',
        sourceVideoUrl,
        uploadedFileUrl: fileUrl,
        uploadedFileExpiresAt: uploadedFile.expiresAt ?? null,
        generatedAt: now(),
        usage: response.usage ?? null,
        creditsConsumed: numberOrNull(response.credits_consumed)
      }
    });
  }
  return { ...plan, shots };
}

export function buildPromptRequest({ manifest, shot, fileUrl }) {
  const settings = manifest.promptGeneration ?? {};
  return {
    model: settings.model ?? DEFAULT_MODEL,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: promptInstruction({ manifest, shot }) },
        { type: 'input_file', file_url: fileUrl }
      ]
    }],
    reasoning: { effort: settings.reasoningEffort ?? 'medium' }
  };
}

function promptInstruction({ manifest, shot }) {
  return `You are writing a precise video-to-video editing prompt for Seedance. Analyze the entire supplied MP4 video for shot ${shot.id} (${shot.startSeconds}s to ${shot.endSeconds}s), from beginning to end. Return JSON only, with exactly two non-empty string keys: promptSuffix and negativePrompt. promptSuffix must describe the visible subject, full action and motion, composition, setting, lighting, camera framing and motion that should be preserved. It must begin with an instruction to replace only the visible person with reference image slot 1, while preserving all other elements and the shot timing. negativePrompt must prohibit new people, text, logos, cuts, zooms, changed environment, changed camera, changed timing, and changed lighting. Do not invent details that are not visible. The shared project instruction is: ${manifest.template.basePrompt}`;
}

export function parsePromptResponse(response) {
  const text = extractOutputText(response).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Kie prompt model did not return valid JSON.'); }
  if (!value?.promptSuffix?.trim() || !value?.negativePrompt?.trim()) throw new Error('Kie prompt model response must contain non-empty promptSuffix and negativePrompt.');
  return { promptSuffix: value.promptSuffix.trim(), negativePrompt: value.negativePrompt.trim() };
}

function extractOutputText(response) {
  const content = response?.output?.flatMap((item) => item?.content ?? []).find((item) => item?.type === 'output_text');
  if (typeof content?.text === 'string') return content.text;
  if (typeof response?.output_text === 'string') return response.output_text;
  throw new Error('Kie prompt model response contains no output_text.');
}

function resolveSourceVideoUrl(settings, manifest, shot) {
  return shot.promptGeneration?.sourceVideoUrl ?? settings.shotVideoUrls?.[shot.id] ?? settings.sourceVideoUrl ?? shot.publicVideoUrl ?? manifest.template.publicVideoUrl;
}

function isPublicHttpsUrl(value) { return typeof value === 'string' && /^https:\/\/[^/]+/.test(value); }
function numberOrNull(value) { return value == null || typeof value === 'boolean' || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
