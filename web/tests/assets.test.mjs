import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LIMITS, ApiError, redact, normalizePath, parentPath, parseChat, parsePoll,
  pollWithinBounds, canInstallSecurely, createApi,
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
  assert.equal(canInstallSecurely({ protocol: 'https:', hostname: 'colibri.example' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: '127.0.0.1' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: 'localhost' }, true), true);
  assert.equal(canInstallSecurely({ protocol: 'http:', hostname: '192.168.1.20' }, true), false);
  assert.equal(canInstallSecurely({ protocol: 'https:', hostname: 'colibri.example' }, false), false);
});

test('parseChat and parsePoll tolerate only the documented shapes', () => {
  assert.deepEqual(parseChat({ message: { role: 'assistant', content: 'hi' }, usage: { total_tokens: 3 } }),
    { role: 'assistant', content: 'hi' });
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
  assert.equal(calls[0].options.headers['X-Colibri-Client'], '1');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
  await assert.rejects(() => api('http://evil.example/api/health'), ApiError);
  await assert.rejects(() => api('/api/files?cmd=rm'), ApiError);
});
