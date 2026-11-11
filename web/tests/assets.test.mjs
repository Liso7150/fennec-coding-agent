import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LIMITS, ApiError, redact, normalizePath, parentPath, parseChat, parseStt, parsePoll,
  parseOutlets, outletSummary, pollWithinBounds, canInstallSecurely, createApi, isImageDataUrl,
} from '../helpers.js';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(resolve(WEB, name), 'utf8');

function pngSize(file) {
  const bytes = readFileSync(resolve(WEB, file));
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('manifest icons exist at the declared sizes', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.ok(manifest.icons.length >= 4);
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, '').replace(/\?.*$/, '');
    assert.ok(existsSync(resolve(WEB, file)), `${icon.src} is missing`);
    if (icon.type === 'image/png') {
      const [width, height] = icon.sizes.split('x').map(Number);
      assert.deepEqual(pngSize(file), { width, height }, `${file} dimensions`);
    }
  }
});

test('every local asset referenced by index.html exists', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="\.\/([^"?#]+)/g)].map(match => match[1]);
  assert.ok(refs.length >= 5);
  for (const file of new Set(refs)) assert.ok(existsSync(resolve(WEB, file)), `${file} is missing`);
});

test('service worker caches only the static shell', () => {
  const source = read('service-worker.js');
  const shell = source.slice(source.indexOf('const SHELL'), source.indexOf('];', source.indexOf('const SHELL')));
  assert.ok(!/\/api/.test(shell), 'the precache list must not include API routes');
  assert.match(source, /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(source, /if \(request\.method !== 'GET'\) return;/);
});

test('the shell reports the app version', () => {
  assert.match(read('index.html'), /id="app-version"/);
  assert.match(read('app.js'), /const VERSION = '1\.9\.0'/);
  assert.match(read('app.js'), /\$\('app-version'\)\.textContent/);
});

test('normalizePath rejects traversal, absolute and encoded input', () => {
  assert.equal(normalizePath('src/app.ts'), 'src/app.ts');
  assert.equal(normalizePath('./src//app.ts'), 'src/app.ts');
  assert.throws(() => normalizePath('../escape'));
  assert.throws(() => normalizePath('/etc/passwd'));
  assert.throws(() => normalizePath('C:/Windows'));
  assert.throws(() => normalizePath('%2e%2e/escape'));
  assert.equal(parentPath('src/lib/app.ts'), 'src/lib');
  assert.equal(parentPath('src'), '');
});

test('redact removes the bearer token from rendered text', () => {
  const token = 'secret-token-1234';
  assert.ok(!redact(`failed with ${token}`, token).includes(token));
  assert.equal(redact('plain text'), 'plain text');
});

test('poll bounds stay inside the documented limits', () => {
  const start = 1000;
  assert.equal(pollWithinBounds(0, start, start + 10), true);
  assert.equal(pollWithinBounds(LIMITS.polls, start, start + 10), false);
  assert.equal(pollWithinBounds(0, start, start + LIMITS.runMs + 1), false);
});

test('canInstallSecurely only accepts https or loopback http', () => {
  assert.equal(canInstallSecurely({ protocol: 'https:', hostname: 'fennec.example' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: '127.0.0.1' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: 'localhost' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: '192.168.1.20' }, true), false);
  assert.equal(canInstallSecurely({ protocol: 'https:', hostname: 'fennec.example' }, false), false);
});

test('parseChat and parsePoll tolerate only the documented shapes', () => {
  assert.deepEqual(parseChat({ message: { role: 'assistant', content: 'hi' }, usage: { total_tokens: 3 } }),
    { role: 'assistant', content: 'hi' });
  assert.deepEqual(parseChat({ message: { role: 'assistant', content: 'hi', reasoning_content: 'why' } }),
    { role: 'assistant', content: 'hi', reasoning: 'why' });
  assert.throws(() => parseChat({ message: { role: 'assistant', content: 'hi', reasoning_content: 5 } }));
  assert.throws(() => parseChat({ message: { role: 'assistant', content: 5 } }));
  assert.throws(() => parseChat({ message: { role: 'assistant', content: '   ' } }));
  const poll = parsePoll({ id: 'abc', status: 'running', total: 4,
    steps: [{ type: 'assistant' }, { type: 'tool' }] }, 'abc', 2);
  assert.equal(poll.next, 4);
  assert.equal(poll.status, 'running');
  assert.equal(poll.terminal, false);
  assert.equal(poll.events.length, 2);
  assert.throws(() => parsePoll({ id: 'other', status: 'running', total: 4, steps: [] }, 'abc', 0));
  assert.throws(() => parsePoll({ id: 'abc', status: 'running', total: 1, steps: [{ type: 'mystery' }] }, 'abc', 0));
});

test('image data URLs and speech transcripts are validated before use', () => {
  assert.equal(isImageDataUrl('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isImageDataUrl('data:image/webp;base64,AAAA'), true);
  assert.equal(isImageDataUrl('data:image/svg+xml;base64,AAAA'), false);
  assert.equal(isImageDataUrl('https://example.com/x.png'), false);
  assert.equal(isImageDataUrl(`data:image/png;base64,${'A'.repeat(Math.ceil(LIMITS.imageBytes * 4 / 3) + 65)}`), false);
  assert.deepEqual(parseStt({ text: '  hello world ', language: 'en', duration_s: 1.5 }),
    { text: 'hello world', language: 'en', duration: 1.5 });
  assert.throws(() => parseStt({ text: 7 }));
  assert.throws(() => parseStt(null));
});

test('createApi sends raw audio bodies with the declared content type', async () => {
  const calls = [];
  const api = createApi({
    origin: 'http://127.0.0.1:8787',
    getToken: () => '',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const audio = new Uint8Array([1, 2, 3]);
  await api('/api/stt', { method: 'POST', body: audio, raw: true, contentType: 'audio/webm' });
  assert.equal(calls[0].options.headers['Content-Type'], 'audio/webm');
  assert.equal(calls[0].options.body, audio);
  await assert.rejects(() => api('/api/stt', { method: 'POST', body: audio, raw: true, contentType: 'not a type' }), ApiError);
});

test('createApi enforces same-origin, documented query keys and the client header', async () => {
  const calls = [];
  const api = createApi({
    origin: 'http://127.0.0.1:8787',
    getToken: () => 'tok',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await api('/api/health');
  assert.equal(calls[0].options.headers['X-Fennec-Client'], '1');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  await assert.rejects(() => api('http://evil.example/api/health'), ApiError);
  await assert.rejects(() => api('/api/files?cmd=rm'), ApiError);
});

test('parseOutlets reads only the documented outlet shapes', () => {
  const status = parseOutlets({
    jev: { present: true, root: '/x/jev-ultrafast', note: 'TypeSafe policy key set' },
    openbot: { present: false, url: 'http://127.0.0.1:3001', error: 'no OpenBot workspace answering' },
  });
  assert.deepEqual(status, {
    jev: { present: true, note: 'TypeSafe policy key set' },
    openbot: { present: false, note: 'no OpenBot workspace answering' },
  });
  assert.equal(parseOutlets({ jev: {}, openbot: {} }).jev.present, false);
  assert.throws(() => parseOutlets(null), /Invalid browser outlet response/);
  assert.throws(() => parseOutlets({ jev: { present: true } }), /no OpenBot outlet/);
  assert.throws(() => parseOutlets({ jev: 'yes', openbot: {} }), /no Jev outlet/);
});

test('the outlet summary names both outlets and never invents one', () => {
  assert.equal(outletSummary(null), 'Browser outlet: status not loaded yet.');
  assert.equal(
    outletSummary({ jev: { present: true }, openbot: { present: false } }),
    'Browser outlet: Jev ready · OpenBot not answering.',
  );
});

test('the browser outlet is offered only through the documented wiring', () => {
  const html = read('index.html');
  assert.match(html, /<input id="allow-web" type="checkbox">/);
  assert.match(html, /<p id="outlet-status" class="hint">/);
  const app = read('app.js');
  assert.match(app, /allow_web: \$\('allow-web'\)\.checked/);
  assert.match(app, /\$\('allow-web'\)\.disabled = busy \|\| !outletReady\(\)/);
  assert.match(app, /api\('\/api\/outlets'/);
  assert.match(app, /browser outlet: \$\{browser\}/);
  // Nothing about the outlet may be cached or fetched cross-origin.
  assert.match(read('service-worker.js'), /url\.pathname === '\/api' \|\| url\.pathname\.startsWith\('\/api\/'\)/);
});
