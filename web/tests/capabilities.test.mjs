import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

/* Behavioural checks for the capability boundary.

   app.js is a classic script with no exports, so the functions under test are
   lifted into a VM exactly as progress.test.mjs lifts applyCoreStep. Fetch and
   the few DOM surfaces are fakes: these tests assert routes and state changes,
   not rendering, and an unexpected coding request fails the route assertion. */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(resolve(WEB, 'app.js'), 'utf8');
const CODING_FEATURES = [
  'supervised-agent', 'tool-execution', 'per-call-approvals', 'agent-polling',
];
const RUST_FEATURES = [
  'chat-only', 'tasks', 'agents', 'repositories', 'events-sse', 'events-websocket',
  'copilotkit-ag-ui', 'native-nod-stdio', 'native-antigravity',
  'obsidian-local-vault-write', 'speech-transcription', 'static-web-assets',
];

function extractFn(name) {
  let start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone - the code changed shape`);
  if (APP.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  let i = APP.indexOf('{', start);
  for (; i < APP.length; i += 1) {
    const c = APP[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(APP, i); continue; }
    if (c === '/' && APP[i + 1] === '/') { i = skipLine(APP, i); continue; }
    if (c === '/' && APP[i + 1] === '*') { i = skipBlock(APP, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }
  assert.equal(depth, 0, `${name} never closes - the brace scan lost the plot`);
  return APP.slice(start, i + 1);
}

function skipString(src, at) {
  const quote = src[at];
  for (let i = at + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
  }
  return at;
}

function skipLine(src, at) {
  const end = src.indexOf('\n', at);
  return end === -1 ? src.length : end;
}

function skipBlock(src, at) {
  const end = src.indexOf('*/', at + 2);
  return end === -1 ? src.length : end + 1;
}

function contract(backend, features) {
  return {
    backend,
    implementation: backend === 'fennec-core' ? 'python-core' : 'rust-axum',
    protocol_version: 1,
    version: '1.0.0',
    features: features.slice(),
  };
}

const RUST = contract('fennec-coding-agent', RUST_FEATURES);
const CORE = contract('fennec-core', CODING_FEATURES);

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function task(overrides = {}) {
  return {
    id: 1,
    title: 'Saved task',
    status: 'Running',
    msgs: [],
    backendId: 'session-1',
    core: true,
    approvals: [],
    ...overrides,
  };
}

function pendingApproval(t) {
  const approval = { id: 'approval-1', action: 'run_shell', status: 'pending', decision: null };
  t.approvals.push(approval);
  t.msgs.push({ id: 10, kind: 'approval', meta: { approvalId: approval.id, status: 'pending' } });
  t.status = 'WaitingForApproval';
  return approval;
}

const CAPABILITY_FUNCTIONS = [
  'apiFetch', 'parseCapabilities', 'capabilityBackendKind', 'backendSupports',
  'supportsCoding', 'isCoreTask', 'supportsRepositoryControls',
  'supportsGithubControls', 'supportsObsidianControls', 'supportsWorkControls',
  'codingUnavailableReason', 'probeCapabilities',
];
const STATE_FUNCTIONS = [
  'queueEntry', 'normalizeQueue', 'isAgentQueueItem', 'queueText', 'expireApprovals',
  'activeTask', 'isWorking', 'pushMsg', 'noteEnd', 'markTaskDisconnected',
];
const SEND_FUNCTIONS = [
  'runFolder', 'startCoreTask', 'sendMessage', 'drainQueue',
];
const GATE_FUNCTIONS = ['gateControl', 'applyCapabilityGates'];
const AUXILIARY_FUNCTIONS = [
  'loadFmDir', 'openFmFile', 'brNavigate', 'syncBackendRepositories',
  'syncWorkspaceRepositories', 'refreshGithub', 'refreshObsidian',
  'openRepositoryDialog', 'bindRepository', 'createRepository',
  'createRepositoryInline', 'writeObsidianNote',
];

function harness(options = {}) {
  const requests = [];
  const toasts = [];
  const polls = [];
  const steps = [];
  const controls = new Map();
  const eventSources = [];

  function control(id) {
    if (!controls.has(id)) {
      controls.set(id, {
        id, value: '', title: `${id} title`, textContent: '', hidden: false,
        disabled: false, dataset: {}, style: {}, children: [],
        setAttribute() {}, addEventListener() {}, appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; }, click() {}, focus() {},
        classList: { toggle() {}, add() {}, remove() {} },
      });
    }
    return controls.get(id);
  }

  const settingsTabs = ['appearance', 'github', 'obsidian'].map((name) => {
    const tab = control(`settings-tab-${name}`);
    tab.dataset.tab = name;
    return tab;
  });
  const permissionOptions = [control('permission-ask'), control('permission-auto')];
  const composer = control('composer-input');
  composer.value = options.composer || '';

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      eventSources.push(this);
    }
    close() { this.closed = true; }
  }

  const context = {
    console, Date, JSON, Promise, Math, Number, String, Array, Object, Error, TypeError,
    CAPABILITY_PROTOCOL_VERSION: 1,
    CODING_FEATURES,
    POLL_INTERVAL_MS: 1,
    POLL_MAX_ATTEMPTS: 3,
    LIVE_STATUSES: ['Running', 'Planning', 'WaitingForApproval'],
    EXPIRED_ENDED: 'the run ended before an answer arrived',
    EXPIRED_GONE: 'the loop no longer holds this question',
    EXPIRED_DISCONNECTED: 'the backend disconnected before an answer arrived',
    EXPIRED_UNSUPERVISED: 'this backend does not provide supervised approvals',
    apiBase: '',
    state: options.state || {
      tasks: [], activeId: null, queued: [], attachments: [], nextId: 1,
      backendConnected: false, capabilities: null, backendKind: 'unknown',
    },
    settings: { autoSave: true, notifications: false, debug: false },
    permissionMode: 'ask',
    currentEffort: 'medium',
    composerInput: composer,
    $: control,
    document: {
      getElementById: control,
      querySelectorAll(selector) {
        if (selector === '.settings-tab') return settingsTabs;
        if (selector === '.permission-option') return permissionOptions;
        return [];
      },
    },
    window: { console, EventSource: FakeEventSource },
    EventSource: FakeEventSource,
    localStorage: options.localStorage || {
      getItem() { return null; }, setItem() {}, removeItem() {},
    },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    async fetch(path, opts = {}) {
      requests.push({
        path,
        method: (opts.method || 'GET').toUpperCase(),
        body: opts.body ? JSON.parse(opts.body) : null,
        headers: { ...(opts.headers || {}) },
      });
      if (options.fetch) return options.fetch(path, opts, requests);
      return reply({}, 404);
    },
    activeWorkspace() { return options.workspace || null; },
    buildPrompt(text) { return text; },
    formatFileSize(size) { return `${size} B`; },
    now() { return '12:00'; },
    saveState() {}, saveWorkspaces() {}, renderAll() {}, renderQueue() {},
    updateSendButton() {}, renderAttachmentChips() {}, renderCapabilities() {},
    updateBackendStatus() {}, updateWorkspaceDisplay() {}, scheduleRender() {},
    connectEvents() {},
    renderWsBrowser() {}, fmNote() {}, setGithubAccountButton() {},
    setObsidianAccountButton() {}, repositoryHint() {}, debugLog() {},
    finalizeTask(t) { t.finalized = true; },
    pollCore(t) { polls.push(t); },
    drainQueue() {},
    applyCoreStep(t, step) { steps.push({ task: t, step }); },
    toast(text, kind) { toasts.push({ text, kind }); },
    setInspTab(name) { context.inspTab = name; },
  };

  vm.createContext(context);
  vm.runInContext(`
    var capabilityProbe = null;
    var drainingQueue = false;
    var eventSource = null;
    var inspTab = 'overview';
    var permDropdown = { hidden: false };
  `, context);
  const functions = options.functions || [
    ...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, ...SEND_FUNCTIONS, ...GATE_FUNCTIONS,
  ];
  vm.runInContext(functions.map(extractFn).join('\n\n'), context);
  return { context, requests, toasts, polls, steps, controls, eventSources, composer };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const taskPosts = (requests) => requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/tasks'));

function unavailableFetch(handler) {
  return async (path) => {
    assert.equal(path, '/api/capabilities', 'an unavailable backend must not receive a coding request');
    return handler();
  };
}

test('capability parsing rejects partial, malformed and contradictory contracts', () => {
  const { context } = harness({ functions: CAPABILITY_FUNCTIONS });
  assert.equal(context.parseCapabilities(null), null);
  assert.equal(context.parseCapabilities([]), null);
  assert.equal(context.parseCapabilities({ ...CORE, protocol_version: 2 }), null);
  assert.equal(context.parseCapabilities({ ...CORE, version: '' }), null);
  assert.equal(context.parseCapabilities({ ...CORE, features: ['supervised-agent', 42] }), null);
  assert.equal(context.parseCapabilities(contract('fennec-core', CODING_FEATURES.slice(1))), null);
  assert.equal(context.parseCapabilities(contract('fennec-coding-agent', RUST_FEATURES.filter((f) => f !== 'chat-only'))), null);
  assert.equal(context.parseCapabilities(contract('fennec-coding-agent', [...RUST_FEATURES, 'agent-polling'])), null);
  assert.equal(context.capabilityBackendKind(context.parseCapabilities(RUST)), 'rust');
  assert.equal(context.capabilityBackendKind(context.parseCapabilities(CORE)), 'core');
  assert.equal(context.capabilityBackendKind(context.parseCapabilities(contract('other', CODING_FEATURES))), 'unknown');
});

const unavailableCases = [
  ['verified Rust chat-only', async () => reply(RUST), 'rust'],
  ['network failure', async () => { throw new TypeError('Failed to fetch'); }, 'unknown'],
  ['HTTP failure', async () => reply({}, 503), 'unknown'],
  ['malformed JSON', async () => reply(new SyntaxError('bad JSON')), 'unknown'],
  ['core missing a coding feature', async () => reply(contract('fennec-core', CODING_FEATURES.slice(0, 3))), 'unknown'],
  ['unsupported backend identity', async () => reply(contract('other', CODING_FEATURES)), 'unknown'],
];

for (const [name, handler, expectedKind] of unavailableCases) {
  test(`${name} keeps the prompt and never POSTs /api/tasks`, async () => {
    const h = harness({ composer: 'Keep this prompt', fetch: unavailableFetch(handler) });
    assert.equal(await h.context.sendMessage(), false);
    assert.equal(h.context.state.backendKind, expectedKind);
    assert.equal(h.composer.value, 'Keep this prompt');
    assert.equal(h.context.state.tasks.length, 0);
    assert.deepEqual(taskPosts(h.requests), []);
    assert.deepEqual(h.requests.map((request) => request.path), ['/api/capabilities']);
    assert.match(h.toasts[0].text, /Coding is unavailable:.*your prompt has been kept\./);
  });
}

test('queue drain refuses Rust and unknown backends without dropping its head', async () => {
  for (const backendKind of ['rust', 'unknown']) {
    const queued = h_queued();
    const h = harness({
      state: {
        ...queued.state,
        backendKind,
        capabilities: backendKind === 'rust' ? RUST : null,
      },
    });
    await h.context.drainQueue();
    assert.equal(h.context.state.queued.length, 1);
    assert.equal(h.context.state.queued[0].text, 'Queued work');
    assert.deepEqual(h.requests, []);
    assert.match(h.toasts[0].text, /Coding is unavailable/);
  }
});

function h_queued() {
  const state = {
    tasks: [], activeId: null, queued: [{ text: 'Queued work', owner: 'user' }],
    attachments: [], nextId: 1, backendConnected: false, capabilities: null, backendKind: 'unknown',
  };
  return { state };
}

test('a complete core contract starts and polls through /api/agent without relabelling Rust history', async () => {
  const old = task({ id: 1, core: false, backendId: 'rust-history', status: 'Complete',
    msgs: [{ id: 1, kind: 'user', content: 'Old Rust chat' }] });
  const h = harness({
    composer: 'Inspect the repository',
    state: {
      tasks: [old], activeId: 1, queued: [], attachments: [], nextId: 2,
      backendConnected: false, capabilities: null, backendKind: 'unknown',
    },
    fetch: async (path, opts) => {
      if (path === '/api/capabilities') return reply(CORE);
      if (path === '/api/agent/start' && opts.method === 'POST') return reply({ id: 'core/new', workspace: '/work' });
      return reply({}, 500);
    },
  });

  assert.equal(await h.context.sendMessage(), true);
  assert.equal(old.core, false);
  assert.equal(old.backendId, 'rust-history');
  const started = h.context.activeTask();
  assert.notEqual(started, old);
  assert.equal(started.core, true);
  assert.equal(started.backendId, 'core/new');
  assert.equal(started.backendWs, '/work');
  assert.equal(h.composer.value, '');
  assert.deepEqual(h.polls, [started]);
  assert.deepEqual(h.requests.map((request) => [request.method, request.path]), [
    ['GET', '/api/capabilities'], ['POST', '/api/agent/start'],
  ]);
  assert.equal(h.requests[1].body.task, 'Inspect the repository');
  assert.equal(h.requests[1].body.require_approval, true);
  assert.equal(h.requests[1].headers['X-Fennec-Client'], '1');
  assert.deepEqual(taskPosts(h.requests), []);
});

test('a refused core start retains both composer text and the queue head', async () => {
  const queued = h_queued();
  const h = harness({
    composer: 'Retry this later',
    state: queued.state,
    fetch: async (path) => {
      if (path === '/api/capabilities') return reply(CORE);
      if (path === '/api/agent/start') return reply({}, 503);
      return reply({}, 500);
    },
  });
  assert.equal(await h.context.sendMessage(), false);
  assert.equal(h.composer.value, 'Retry this later');
  await h.context.drainQueue();
  assert.equal(h.context.state.queued.length, 1);
  assert.equal(h.context.state.queued[0].text, 'Queued work');
  assert.equal(h.polls.length, 0);
  assert.deepEqual(taskPosts(h.requests), []);
});

test('a successful core queue drain removes only the accepted head', async () => {
  const state = h_queued().state;
  state.capabilities = CORE;
  state.backendKind = 'core';
  const h = harness({
    state,
    fetch: async (path) => {
      if (path === '/api/capabilities') return reply(CORE);
      if (path === '/api/agent/start') return reply({ id: 'core/queued' });
      return reply({}, 500);
    },
  });
  await h.context.drainQueue();
  assert.equal(h.context.state.queued.length, 0);
  assert.equal(h.context.activeTask().backendId, 'core/queued');
  assert.equal(h.polls.length, 1);
  assert.deepEqual(taskPosts(h.requests), []);
});

test('loading history never turns a Rust task into a supervised task', () => {
  const saved = task({ core: undefined, status: 'Complete', msgs: [{ id: 1, kind: 'user', content: 'Rust' }] });
  pendingApproval(saved);
  const h = harness({
    functions: [...STATE_FUNCTIONS, 'normalizeQueue', 'loadState'],
    localStorage: {
      getItem() { return JSON.stringify({ tasks: [saved], activeId: 1, queued: [] }); },
      setItem() {}, removeItem() {},
    },
  });
  h.context.STORAGE_KEY = 'history';
  h.context.TERMINAL_NOTES = [];
  h.context.stripCallBlobs = (messages) => messages;
  h.context.stripDeliveryProse = (messages) => messages;
  h.context.collapseDeliveries = (messages) => messages;
  h.context.loadState();
  assert.equal(h.context.state.tasks[0].core, false);
  assert.equal(h.context.state.tasks[0].approvals[0].status, 'expired');
  assert.equal(h.context.state.tasks[0].approvals[0].note, h.context.EXPIRED_UNSUPERVISED);
});

test('approval and cancel require strict core identity', async () => {
  for (const invalid of [task({ core: false }), task({ backendId: '' }), task({ backendId: null })]) {
    pendingApproval(invalid);
    const h = harness({
      functions: [...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, 'answerApproval', 'stopTask'],
      state: {
        tasks: [invalid], activeId: invalid.id, queued: [], attachments: [], nextId: 2,
        backendConnected: true, capabilities: CORE, backendKind: 'core',
      },
    });
    h.context.answerApproval(invalid, 'approval-1', 'allow_once');
    await settle();
    await h.context.stopTask();
    assert.equal(invalid.approvals[0].status, 'expired');
    assert.deepEqual(h.requests, [], 'a task without core=true and a session id must not reach /api/agent');
  }
});

test('a core approval posts its decision to /api/agent/approve', async () => {
  const coreTask = task();
  pendingApproval(coreTask);
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, 'answerApproval'],
    state: {
      tasks: [coreTask], activeId: 1, queued: [], attachments: [], nextId: 2,
      backendConnected: true, capabilities: CORE, backendKind: 'core',
    },
    fetch: async (path, opts) => {
      assert.equal(path, '/api/agent/approve');
      assert.equal(opts.method, 'POST');
      return reply({});
    },
  });
  h.context.answerApproval(coreTask, 'approval-1', 'allow_once');
  await settle();
  assert.deepEqual(h.requests.map((request) => [request.method, request.path]), [['POST', '/api/agent/approve']]);
  assert.deepEqual(h.requests[0].body, { id: 'session-1', approval_id: 'approval-1', decision: 'allow_once' });
  assert.equal(coreTask.approvals[0].status, 'resolved');
  assert.equal(coreTask.msgs[0].meta.status, 'resolved');
});

test('a core cancellation posts to /api/agent/cancel, never the Rust stop route', async () => {
  const coreTask = task();
  pendingApproval(coreTask);
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, 'stopTask', 'finalizeTask'],
    state: {
      tasks: [coreTask], activeId: 1, queued: [], attachments: [], nextId: 2,
      backendConnected: true, capabilities: CORE, backendKind: 'core',
    },
    fetch: async (path, opts) => {
      assert.equal(path, '/api/agent/cancel');
      assert.equal(opts.method, 'POST');
      return reply({});
    },
  });
  await h.context.stopTask();
  assert.deepEqual(h.requests.map((request) => [request.method, request.path]), [['POST', '/api/agent/cancel']]);
  assert.deepEqual(h.requests[0].body, { id: 'session-1' });
  assert.equal(coreTask.status, 'Cancelled');
  assert.equal(coreTask.approvals[0].status, 'expired');
});

for (const [name, handler, note] of [
  ['poll 404', async () => reply({}, 404), 'the loop no longer holds this question'],
  ['poll network failure', async () => { throw new TypeError('Failed to fetch'); }, 'the backend disconnected before an answer arrived'],
]) {
  test(`${name} expires approvals and marks the backend disconnected`, async () => {
    const coreTask = task();
    const approval = pendingApproval(coreTask);
    const h = harness({
      functions: [...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, 'pollCore'],
      state: {
        tasks: [coreTask], activeId: 1, queued: [], attachments: [], nextId: 2,
        backendConnected: true, capabilities: CORE, backendKind: 'core',
      },
      fetch: async (path) => {
        assert.equal(path, '/api/agent/poll?id=session-1&after=0');
        return handler();
      },
    });
    await h.context.pollCore(coreTask);
    assert.equal(coreTask.status, 'Failed');
    assert.equal(coreTask.polling, false);
    assert.equal(h.context.state.backendConnected, false);
    assert.equal(approval.status, 'expired');
    assert.equal(approval.decision, null);
    assert.equal(approval.note, note);
    assert.equal(coreTask.msgs[0].meta.status, 'expired');
    assert.deepEqual(taskPosts(h.requests), []);
  });
}

test('a successful core poll applies steps and finalizes without reading Rust tasks', async () => {
  const coreTask = task();
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...STATE_FUNCTIONS, 'pollCore'],
    state: {
      tasks: [coreTask], activeId: 1, queued: [], attachments: [], nextId: 2,
      backendConnected: true, capabilities: CORE, backendKind: 'core',
    },
    fetch: async (path) => {
      assert.equal(path, '/api/agent/poll?id=session-1&after=0');
      return reply({ total: 1, status: 'done', pending: [], steps: [{ type: 'final', content: 'Done' }] });
    },
  });
  await h.context.pollCore(coreTask);
  assert.deepEqual(h.steps, [{ task: coreTask, step: { type: 'final', content: 'Done' } }]);
  assert.equal(coreTask.status, 'Complete');
  assert.equal(coreTask.finalized, true);
  assert.equal(h.requests.some((request) => request.path.startsWith('/api/tasks')), false);
});

test('core-hosted capabilities disable Rust-only and permission controls', () => {
  const h = harness({ functions: [...CAPABILITY_FUNCTIONS, ...GATE_FUNCTIONS] });
  h.context.state.capabilities = CORE;
  h.context.state.backendKind = 'core';
  h.context.inspTab = 'files';
  let sendButtonUpdates = 0;
  h.context.updateSendButton = () => { sendButtonUpdates += 1; };
  h.context.applyCapabilityGates();
  assert.equal(sendButtonUpdates, 1, 'a verified contract must refresh the composer send state');
  for (const id of ['change-repository', 'connect-repository', 'repository-create',
    'github-account-button', 'github-refresh', 'obsidian-account-button', 'obsidian-write',
    'insp-tab-files', 'insp-tab-browser', 'fm-refresh', 'browser-go']) {
    assert.equal(h.controls.get(id)?.disabled, true, `${id} stayed enabled on core`);
    assert.match(h.controls.get(id).title, /Available only/);
  }
  assert.equal(h.controls.get('working-in').hidden, true);
  assert.equal(h.controls.get('settings-tab-github').disabled, true);
  assert.equal(h.controls.get('settings-tab-obsidian').disabled, true);
  assert.equal(h.controls.get('permission-trigger').disabled, false,
    'a complete core contract must keep permission controls available');
  assert.equal(h.context.inspTab, 'overview');
  assert.equal(h.context.permDropdown.hidden, false);
});

test('verified Rust restores its auxiliary controls but never coding permissions', async () => {
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...GATE_FUNCTIONS],
    fetch: async () => reply(RUST),
  });
  await h.context.probeCapabilities();
  assert.equal(h.context.state.backendKind, 'rust');
  assert.equal(h.controls.get('working-in').hidden, false);
  for (const id of ['change-repository', 'connect-repository', 'github-account-button',
    'obsidian-account-button', 'insp-tab-files', 'insp-tab-browser', 'fm-refresh', 'browser-go']) {
    assert.equal(h.controls.get(id)?.disabled, false, `${id} did not recover on verified Rust`);
  }
  assert.equal(h.controls.get('permission-trigger').disabled, true);
  assert.equal(h.context.supportsCoding(), false);
});

test('missing Rust auxiliary features keep those controls disabled', () => {
  const h = harness({ functions: [...CAPABILITY_FUNCTIONS, ...GATE_FUNCTIONS] });
  h.context.state.capabilities = contract('fennec-coding-agent', ['chat-only']);
  h.context.state.backendKind = 'rust';
  h.context.applyCapabilityGates();
  assert.equal(h.controls.get('change-repository').disabled, true);
  assert.equal(h.controls.get('obsidian-account-button').disabled, true);
  assert.equal(h.controls.get('github-account-button').disabled, false);
  assert.equal(h.controls.get('insp-tab-files').disabled, false);
});

test('guarded auxiliary handlers issue no requests when core hosts the PWA', async () => {
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...AUXILIARY_FUNCTIONS],
    state: {
      tasks: [], activeId: null, queued: [], attachments: [], nextId: 1,
      backendConnected: true, capabilities: CORE, backendKind: 'core',
    },
  });
  h.context.loadFmDir('.');
  await h.context.openFmFile('README.md', 'README.md');
  h.context.brNavigate('https://example.com');
  await h.context.syncBackendRepositories();
  await h.context.syncWorkspaceRepositories();
  await h.context.refreshGithub();
  await h.context.refreshObsidian();
  h.context.openRepositoryDialog();
  h.context.bindRepository('owner/repo');
  h.context.createRepository();
  h.context.createRepositoryInline();
  await h.context.writeObsidianNote();
  assert.deepEqual(h.requests, []);
});

test('EventSource opens only for an advertised events-sse feature and only once', () => {
  const h = harness({ functions: [...CAPABILITY_FUNCTIONS, ...GATE_FUNCTIONS, 'connectEvents'] });
  h.context.state.capabilities = CORE;
  h.context.state.backendKind = 'core';
  h.context.connectEvents();
  assert.equal(h.eventSources.length, 0);

  h.context.state.capabilities = contract('fennec-core', [...CODING_FEATURES, 'events-sse']);
  h.context.connectEvents();
  h.context.connectEvents();
  assert.equal(h.eventSources.length, 1);
  assert.equal(h.eventSources[0].url, '/api/events');
});

test('a refreshed capability contract closes SSE when events-sse is revoked', async () => {
  let probes = 0;
  const h = harness({
    functions: [...CAPABILITY_FUNCTIONS, ...GATE_FUNCTIONS, 'connectEvents'],
    fetch: async () => reply(++probes === 1
      ? contract('fennec-core', [...CODING_FEATURES, 'events-sse'])
      : CORE),
  });
  await h.context.probeCapabilities();
  assert.equal(h.eventSources.length, 1);
  await h.context.probeCapabilities();
  assert.equal(h.eventSources[0].closed, true);
  assert.equal(h.context.eventSource, null);
});
