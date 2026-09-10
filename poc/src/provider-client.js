const terminalSuccess = new Set(['completed', 'succeeded', 'success']);
const terminalFailure = new Set(['failed', 'error', 'cancelled', 'canceled']);
const kieTerminalSuccess = new Set(['success']);
const kieTerminalFailure = new Set(['fail']);

export function createSeedanceClient({ baseUrl, apiKey, createPath = '/v1/videos/generations', statusPath = '/v1/videos/generations/{id}', pollIntervalMs = 5000, requestTimeoutMs = 30000, fetchImpl = fetch }) {
  if (!baseUrl || !apiKey) throw new Error('SEEDANCE_API_BASE_URL and SEEDANCE_API_KEY are required for live mode.');
  async function request(url, options, { timeoutMs = requestTimeoutMs, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Seedance API ${response.status}: ${JSON.stringify(body)}`);
      return body;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  return {
    create(payload) {
      return request(new URL(createPath, baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },
    async waitForCompletion(taskId, { timeoutMs } = {}) {
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
      while (true) {
        if (deadline && Date.now() >= deadline) throw new Error(`Polling timed out after ${timeoutMs}ms for task ${taskId}.`);
        const remaining = deadline ? Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())) : requestTimeoutMs;
        const result = await request(new URL(statusPath.replace('{id}', encodeURIComponent(taskId)), baseUrl), { headers: { authorization: `Bearer ${apiKey}` } }, { timeoutMs: remaining });
        const status = String(result.status ?? result.data?.status ?? '').toLowerCase();
        if (terminalSuccess.has(status) || terminalFailure.has(status)) return result;
        if (deadline && Date.now() >= deadline) throw new Error(`Polling timed out after ${timeoutMs}ms for task ${taskId}.`);
        await sleep(Math.min(pollIntervalMs, Math.max(1, deadline ? deadline - Date.now() : pollIntervalMs)));
      }
    }
  };
}

export function createKieClient({ apiKey, baseUrl = 'https://api.kie.ai/', pollIntervalMs = 5000, requestTimeoutMs = 30000, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('KIE_API_KEY is required for live mode.');
  async function request(url, options, { timeoutMs = requestTimeoutMs, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms.`)), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || (body.code !== undefined && body.code !== 200)) throw new Error(`Kie API ${response.status}: ${JSON.stringify(body)}`);
      return body;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  const headers = { authorization: `Bearer ${apiKey}` };
  return {
    create(payload) {
      return request(new URL('/api/v1/jobs/createTask', baseUrl), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    },
    async waitForCompletion(taskId, { timeoutMs } = {}) {
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null;
      while (true) {
        const url = new URL('/api/v1/jobs/recordInfo', baseUrl);
        url.searchParams.set('taskId', taskId);
        if (deadline && Date.now() >= deadline) throw new Error(`Polling timed out after ${timeoutMs}ms for task ${taskId}.`);
        const remaining = deadline ? Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())) : requestTimeoutMs;
        const result = await request(url, { headers }, { timeoutMs: remaining });
        const state = String(result.data?.state ?? '').toLowerCase();
        if (kieTerminalSuccess.has(state) || kieTerminalFailure.has(state)) return result;
        if (deadline && Date.now() >= deadline) throw new Error(`Polling timed out after ${timeoutMs}ms for task ${taskId}.`);
        await sleep(Math.min(pollIntervalMs, Math.max(1, deadline ? deadline - Date.now() : pollIntervalMs)));
      }
    }
  };
}

export function createKiePromptClient({ apiKey, baseUrl = 'https://api.kie.ai/', requestTimeoutMs = 30000, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('KIE_API_KEY is required for prompt generation.');
  return {
    async uploadFromUrl({ sourceVideoUrl, fileName }) {
      return retryTransient(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetchImpl('https://kieai.redpandaai.co/api/file-url-upload', {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ fileUrl: sourceVideoUrl, uploadPath: 'vidwizard/prompt-inputs', fileName }),
            signal: controller.signal
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.success === false || body.code !== 200) throw httpError(`Kie file upload ${response.status}: ${JSON.stringify(body)}`, response.status);
          return body.data ?? {};
        } catch (error) {
          if (error.name === 'AbortError') throw transientError(`Kie file upload timed out after ${requestTimeoutMs}ms.`);
          throw error;
        } finally { clearTimeout(timer); }
      });
    },
    async generate(payload) {
      return retryTransient(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetchImpl(new URL('/codex/v1/responses', baseUrl), {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload), signal: controller.signal
          });
          const text = await response.text();
          if (!response.ok) throw httpError(`Kie prompt API ${response.status}: ${text}`, response.status);
          return parseResponsePayload(text);
        } catch (error) {
          if (error.name === 'AbortError') throw transientError(`Kie prompt API timed out after ${requestTimeoutMs}ms.`);
          throw error;
        } finally { clearTimeout(timer); }
      });
    }
  };
}

export async function retryTransient(operation, { attempts = 5, delayMs = 1000, sleepFn = sleep } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!error.transient || attempt === attempts) throw error;
      await sleepFn(delayMs);
    }
  }
}

function httpError(message, status) { const error = new Error(message); error.transient = status === 429 || status >= 500; return error; }
function transientError(message) { const error = new Error(message); error.transient = true; return error; }

function parseResponsePayload(text) {
  try { return JSON.parse(text); } catch {}
  const events = text.split(/\n\n+/).map((event) => event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')).filter(Boolean);
  const payloads = events.filter((event) => event !== '[DONE]').map((event) => JSON.parse(event));
  const completed = payloads.findLast((payload) => Array.isArray(payload.output));
  if (!completed) throw new Error('Kie prompt API returned an unreadable response.');
  return completed;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
