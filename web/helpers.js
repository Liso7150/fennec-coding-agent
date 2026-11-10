// Browser-independent protocol helpers. No storage, DOM, or logging side effects.
export const LIMITS = Object.freeze({ polls: 300, pollMs: 1000, runMs: 10 * 60 * 1000, responseBytes: 4 * 1024 * 1024, imageBytes: 6_000_000, audioBytes: 16 << 20 });
export const TERMINAL_STATUSES = new Set(['completed', 'complete', 'done', 'finished', 'cancelled', 'canceled', 'failed', 'error']);

export class ApiError extends Error {
  constructor(message, status = 0, code = 'API_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function redact(value, token = '') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  return token ? text.split(token).join('[redacted]') : text;
}

export function normalizePath(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f\x7f]/.test(value) || /^[~/]/.test(value) || /^[a-z]:/i.test(value) || /%[a-f\d]{2}/i.test(value)) {
    throw new Error('Use a root-relative path, not a host path, backslashes, or an encoded path.');
  }
  const parts = value.split('/');
  if (parts.includes('..')) throw new Error('Parent traversal is not allowed. Use the Parent button.');
  return parts.filter(part => part && part !== '.').join('/');
}

export function parentPath(path) {
  return normalizePath(path).split('/').slice(0, -1).join('/');
}

export function parseListing(data, directory = '') {
  const entries = Array.isArray(data) ? data : data?.entries ?? data?.files;
  if (!Array.isArray(entries)) throw new Error('The server returned an invalid directory listing.');
  if (entries.length > 2000) throw new Error('This directory exceeds the 2,000-entry browser limit. Open a smaller subdirectory.');
  const root = normalizePath(directory);
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid directory entry.');
    const path = normalizePath(entry.path ?? [root, entry.name].filter(Boolean).join('/'));
    if (!path || path === root || parentPath(path) !== root) throw new Error('The server returned a file outside the requested directory.');
    return { path, name: path.split('/').at(-1), directory: entry.is_dir === true || entry.is_directory === true || ['dir', 'directory'].includes(entry.type) };
  }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export function parseChat(data) {
  if (data?.message?.role !== 'assistant' || typeof data.message.content !== 'string' || !data.message.content.trim()) {
    throw new Error('The engine returned an empty or invalid assistant response. No answer was added.');
  }
  const reasoning = data.message.reasoning_content ?? data.message.reasoning ?? '';
  if (typeof reasoning !== 'string') throw new Error('The engine returned invalid reasoning text.');
  return reasoning ? { role: 'assistant', content: data.message.content, reasoning } : { role: 'assistant', content: data.message.content };
}

export function isImageDataUrl(value) {
  return typeof value === 'string' && value.length <= Math.ceil(LIMITS.imageBytes * 4 / 3) + 64
    && /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function parseStt(data) {
  if (!data || typeof data.text !== 'string' || data.text.length > 32000) {
    throw new Error('The speech service returned an invalid transcript.');
  }
  return {
    text: data.text.trim(),
    language: typeof data.language === 'string' ? data.language.slice(0, 32) : '',
    duration: Number.isFinite(data.duration_s) ? data.duration_s : 0,
  };
}

export function parsePoll(data, id, after) {
  if (!data || data.id !== id || !Array.isArray(data.steps) || typeof data.status !== 'string' || !data.status || data.status.length > 80 || !Number.isSafeInteger(data.total) || data.total < after + data.steps.length || data.total > 10000 || data.steps.length > 1000) {
    throw new Error('Invalid agent poll response. Monitoring stopped; cancellation will be requested.');
  }
  if (data.steps.some(step => !step || typeof step !== 'object' || !['assistant', 'final', 'tool', 'error'].includes(step.type))) {
    throw new Error('Unknown agent event. Monitoring stopped rather than inventing a result.');
  }
  const next = after + data.steps.length;
  return { events: data.steps, next, status: data.status, terminal: TERMINAL_STATUSES.has(data.status.toLowerCase()) && next >= data.total, usage: data.usage };
}

export function pollWithinBounds(count, startedAt, now = Date.now()) {
  return count < LIMITS.polls && now - startedAt < LIMITS.runMs;
}

export function canInstallSecurely(locationLike, secureContext) {
  const host = locationLike.hostname;
  return Boolean(secureContext && (locationLike.protocol === 'https:' || (locationLike.protocol === 'http:' && (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)))));
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError('Request stopped.', 0, 'ABORTED'));
    const abort = () => { clearTimeout(timer); reject(new ApiError('Request stopped.', 0, 'ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createApi({ origin, getToken = () => '', fetchImpl = globalThis.fetch }) {
  return async function api(path, { method = 'GET', body, signal, timeout = 20000, text = false, allowEmpty = false, raw = false, contentType = '' } = {}) {
    const url = new URL(path, origin);
    if (!path.startsWith('/api/') || url.origin !== origin || url.hash || url.username || url.password) throw new ApiError('Only same-origin API requests are allowed.');
    for (const key of url.searchParams.keys()) {
      if (!['id', 'after', 'path'].includes(key)) throw new ApiError('Unexpected API query parameter.');
    }
    const token = getToken();
    if (/[\r\n\x00-\x1f\x7f]/.test(token)) throw new ApiError('The token contains invalid characters.');
    if (raw && (typeof contentType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(contentType))) throw new ApiError('A valid content type is required for binary uploads.');
    const headers = { 'X-Colibri-Client': '1', Accept: text ? 'application/json, text/plain' : 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = raw ? contentType : 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetchImpl(url.href, {
        method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
      });
      if (Number(response.headers.get('content-length')) > LIMITS.responseBytes) throw new ApiError('Response exceeds the 4 MiB browser limit.');
      const rawText = await response.text();
      if (rawText.length > LIMITS.responseBytes) throw new ApiError('Response exceeds the 4 MiB browser limit.');
      let data;
      try { data = rawText ? JSON.parse(rawText) : null; } catch { data = null; }
      if (!response.ok) {
        const detail = typeof data?.detail === 'string' ? data.detail : typeof data?.error === 'string' ? data.error : '';
        const hint = response.status === 401 ? 'Token missing or rejected. Enter the server token and reconnect.' : response.status === 403 ? 'The server denied this request. Check its token and permissions.' : `Server request failed (HTTP ${response.status}).`;
        throw new ApiError(redact(`${hint}${detail ? ` ${detail.slice(0, 400)}` : ''}`, token), response.status);
      }
      if (allowEmpty && !rawText.trim()) return null;
      if (text && !response.headers.get('content-type')?.includes('application/json')) return rawText;
      if (data === null || typeof data !== 'object') throw new ApiError('The server returned empty or invalid JSON.');
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError('Request timed out. Check the server before retrying.', 0, 'TIMEOUT');
      if (controller.signal.aborted) throw new ApiError('Request stopped.', 0, 'ABORTED');
      if (error instanceof ApiError) throw error;
      throw new ApiError('Cannot reach this origin’s Colibri API. Check connection, trusted HTTPS, and server availability.', 0, 'NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
