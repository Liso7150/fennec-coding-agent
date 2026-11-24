// Fennec Workspace — full client: persistence, backend API, SSE events, dynamic UI.
// Endpoints used (same origin):
//   GET  /api/capabilities      (backend identity, protocol and advertised features)
//   GET  /api/models            (optional; falls back to the desktop model list)
//   POST /api/agent/start       (supervised core run)
//   GET  /api/agent/poll        (supervised core steps and pending approvals)
//   POST /api/agent/approve     (answer a core approval)
//   POST /api/agent/cancel      (cancel a core run)
//   GET  /api/tasks/:id         (read persisted Rust chat tasks only)
//   DELETE /api/tasks/:id       (remove a persisted Rust chat task)
//   GET  /api/events            (SSE, only when events-sse is advertised)
//   GET  /api/repositories      (Rust auxiliary panels)
(function () {
  'use strict';

  const STORAGE_KEY = 'fennec-coding-agent-history';
  const MAX_INLINE_BYTES = 200 * 1024; // per attached text file
  const POLL_INTERVAL_MS = 1000;
  // How long a run may say nothing at all before the shell calls it lost. Not a
  // cap on the run: `pollCore` and `pollTask` both reset it on news, because a
  // complex task legitimately runs for many minutes. One local turn can itself
  // run silent for minutes on a cold model, so the ceiling matches the one the
  // core gives a single engine request (engine.py `timeout=600`) —
  // the shell must not abandon a run earlier than the layer below it does.
  const POLL_MAX_ATTEMPTS = 600;

  // The only statuses with a run still behind them; anything else on disk is
  // finished, so a question it still holds is dead, not unanswered.
  const LIVE_STATUSES = ['Running', 'Planning', 'WaitingForApproval'];
  // The two reasons a question stops being answerable, worded as the native
  // surfaces word them (fennec-ui/src/attention.rs renders "not used · <note>").
  const EXPIRED_ENDED = 'the run ended before an answer arrived';
  const EXPIRED_GONE = 'the loop no longer holds this question';
  const EXPIRED_DISCONNECTED = 'the backend disconnected before an answer arrived';
  const EXPIRED_UNSUPERVISED = 'this backend does not provide supervised approvals';
  const CAPABILITY_PROTOCOL_VERSION = 1;
  const CODING_FEATURES = [
    'supervised-agent',
    'tool-execution',
    'per-call-approvals',
    'agent-polling',
  ];

  // ── Settings (persisted) ───────────────────────────────────────────────────
  function readSetting(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  }

  // The page is served by the Rust backend it talks to, so same-origin is the
  // only truth here; the native shell keeps a Connection tab because it is a
  // separate client that must find the backend.
  const apiBase = '';
  // Core refuses /api/* without the loopback client header; send it on every call.
  function apiFetch(path, opts) {
    const o = opts || {};
    o.headers = Object.assign({ 'X-Fennec-Client': '1' }, o.headers || {});
    return fetch(apiBase + path, o);
  }

  function parseCapabilities(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.backend !== 'string' || !value.backend.trim()) return null;
    if (typeof value.implementation !== 'string' || !value.implementation.trim()) return null;
    if (value.protocol_version !== CAPABILITY_PROTOCOL_VERSION) return null;
    if (typeof value.version !== 'string' || !value.version.trim()) return null;
    if (!Array.isArray(value.features) || value.features.some((f) => typeof f !== 'string' || !f.trim())) return null;
    const features = value.features.slice();
    // A partial core contract is not a weaker core: the PWA cannot safely mix
    // unsupervised starts, polling or approval buttons. Rust is recognized by
    // its own identity and chat-only marker instead.
    if (value.backend === 'fennec-core' && !CODING_FEATURES.every((feature) => features.indexOf(feature) !== -1)) return null;
    if (value.backend === 'fennec-coding-agent'
      && (!features.includes('chat-only') || CODING_FEATURES.some((feature) => features.includes(feature)))) return null;
    return {
      backend: value.backend,
      implementation: value.implementation,
      protocol_version: value.protocol_version,
      version: value.version,
      features,
    };
  }

  function capabilityBackendKind(contract) {
    if (!contract) return 'unknown';
    if (contract.backend === 'fennec-coding-agent' && contract.implementation === 'rust-axum') return 'rust';
    if (contract.backend === 'fennec-core') return 'core';
    return 'unknown';
  }

  function backendSupports(feature) {
    return !!(state.capabilities && state.capabilities.features.indexOf(feature) !== -1);
  }

  function supportsCoding() {
    return CODING_FEATURES.every(backendSupports);
  }

  function isCoreTask(task) {
    return !!(task && task.core === true && typeof task.backendId === 'string' && task.backendId);
  }

  function supportsRepositoryControls() {
    return state.backendKind === 'rust' && backendSupports('repositories');
  }

  function supportsGithubControls() {
    return state.backendKind === 'rust';
  }

  function supportsObsidianControls() {
    return state.backendKind === 'rust' && backendSupports('obsidian-local-vault-write');
  }

  function supportsWorkControls() {
    return state.backendKind === 'rust';
  }

  function codingUnavailableReason() {
    if (state.backendKind === 'unknown') {
      return 'Coding is unavailable: backend capabilities could not be verified. Check the backend connection and reload; your prompt has been kept.';
    }
    if (state.backendKind === 'rust') {
      return 'Coding is unavailable: the Rust backend is chat-only and cannot supervise tools. Start fennec-core on 127.0.0.1:8787 and reload; your prompt has been kept.';
    }
    const missing = CODING_FEATURES.filter((feature) => !backendSupports(feature));
    return 'Coding is unavailable: the backend does not advertise ' + missing.join(', ')
      + '. Start a fennec-core build with all four coding capabilities and reload; your prompt has been kept.';
  }

  let capabilityProbe = null;
  async function probeCapabilities() {
    if (capabilityProbe) return capabilityProbe;
    capabilityProbe = (async () => {
      let reachable = false;
      let contract = null;
      try {
        const response = await apiFetch('/api/capabilities', { cache: 'no-store' });
        reachable = response.ok;
        if (response.ok) {
          const parsed = parseCapabilities(await response.json());
          if (capabilityBackendKind(parsed) !== 'unknown') contract = parsed;
        }
      } catch (_) { /* no verified capability contract */ }
      state.capabilities = contract;
      state.backendKind = capabilityBackendKind(contract);
      state.backendConnected = reachable;
      applyCapabilityGates();
      updateBackendStatus();
      renderCapabilities();
      // A refreshed contract can revoke SSE just as it can revoke a panel. Do
      // not wait for the next health tick to close a stream we can no longer
      // justify, and let the initial verified contract open one immediately.
      connectEvents();
      return contract;
    })();
    try {
      return await capabilityProbe;
    } finally {
      capabilityProbe = null;
    }
  }

  const settings = {
    autoSave: readSetting('fennec-auto-save', 'true') !== 'false',
    notifications: readSetting('fennec-notifications', 'true') !== 'false',
    debug: readSetting('fennec-debug', 'false') === 'true',
    fontSize: parseInt(readSetting('fennec-font-size', '14'), 10) || 14,
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    tasks: [],
    activeId: null,
    queued: [],
    inspectorOpen: readSetting('fennec-inspector-open', 'true') !== 'false',
    backendConnected: false,
    capabilities: null,
    backendKind: 'unknown',
    // Rendered outlet rows from /api/outlets, or null while the server has not
    // told us. Never persisted: it describes this machine, not this conversation.
    outlets: null,
    nextId: 1,
    searchQuery: '',
    attentionOnly: false,
    attachments: [], // pending composer attachments (not persisted)
  };

  const UI_ICON_PATHS = {
    settings: '<path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42M7.06 16.94l-1.42 1.42"/><circle cx="12" cy="12" r="3.5"/>',
    panel: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 4v16"/>',
    list: '<path d="M6 6h12M6 12h12M6 18h12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
    paperclip: '<path d="m8 12 5.5-5.5a3 3 0 0 1 4.24 4.24l-6.36 6.36a4 4 0 0 1-5.66-5.66l6.01-6.01"/>',
    mic: '<rect x="9" y="4" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6"/>',
    github: '<path d="M12 3a9 9 0 0 0-2.84 17.54c.45.08.62-.2.62-.43v-1.52c-2.52.55-3.05-1.06-3.05-1.06-.41-1.05-1-1.33-1-1.33-.82-.56.06-.55.06-.55.91.06 1.39.94 1.39.94.8 1.39 2.1.99 2.61.76.08-.59.31-.99.57-1.22-2.01-.23-4.12-1-4.12-4.46 0-.99.35-1.8.93-2.44-.09-.23-.4-1.15.09-2.4 0 0 .76-.24 2.48.93a8.6 8.6 0 0 1 4.52 0c1.72-1.17 2.48-.93 2.48-.93.49 1.25.18 2.17.09 2.4.58.64.93 1.45.93 2.44 0 3.47-2.11 4.23-4.12 4.46.32.28.61.83.61 1.68v2.49c0 .24.16.52.62.43A9 9 0 0 0 12 3Z"/>',
    vault: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v18H7.5A2.5 2.5 0 0 1 5 18.5v-13Z"/><path d="M5 7h10M9 11h6M9 15h6"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 4-4 3 3 2-2 5 4"/>',
    download: '<path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"/>',
    queue: '<path d="M6 6h12M6 12h12M6 18h8"/><circle cx="4" cy="6" r=".7" fill="currentColor"/><circle cx="4" cy="12" r=".7" fill="currentColor"/><circle cx="4" cy="18" r=".7" fill="currentColor"/>',
    workspace: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2H18a2 2 0 0 1 2 2v7.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    thought: '<path d="M7 17.5A5.5 5.5 0 1 1 17 14l2 3-3.5-.5A5.5 5.5 0 0 1 7 17.5Z"/>',
    tool: '<path d="m14 6 4 4M5 19l6.5-6.5M13 7a4 4 0 0 0 5 5l-7 7H6v-5l7-7Z"/>',
    volume: '<path d="M5 10v4h3l4 3V7l-4 3H5Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  };

  function iconSvg(name, className = 'ui-icon') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${UI_ICON_PATHS[name] || UI_ICON_PATHS.tool}</svg>`;
  }

  const FALLBACK_MODELS = [
    { id: 'qwen3_5_moe', name: 'Qwen3.5-MoE' },
    { id: 'edge0_145b', name: 'Edge0-145B' },
    { id: 'qwen36_35b', name: 'Qwen36-35B' },
  ];
  let models = FALLBACK_MODELS.slice();
  let currentModel = readSetting('fennec-model', 'qwen3_5_moe');

  // Every step type the loop can put in `/api/agent/poll`, mirrored from
  // fennec-core/loop.py STEP_TYPES. A type missing here is dropped by
  // applyCoreStep's open-ended chain rather than stopping the watch, but the list
  // is what tells a reader which steps the timeline is expected to speak for.
  const STEP_TYPES = ['plan', 'reasoning', 'assistant', 'partial', 'tool_start', 'progress', 'tool',
    'queue', 'final', 'error', 'cancelled', 'approval_required'];

  // The reasoning levels are core's vocabulary (loop.py
  // EFFORT_LEVELS) and the native dropdown's labels (fennec-ui controls.rs
  // REASONING_LEVELS) — the same four rows on both surfaces.
  const EFFORT_LEVELS = [
    { id: 'auto', name: 'Auto' },
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ];
  let currentEffort = readSetting('fennec-effort', 'auto');
  if (!EFFORT_LEVELS.some((l) => l.id === currentEffort)) currentEffort = 'auto';

  // Permission modes mirror the native shell (fennec-desktop/src/gui_main.rs set_access_mode).
  const PERM_MODES = {
    ask: {
      icon: '•', label: 'Ask every time', colorClass: 'perm-ask',
      flags: { allow_write: false, allow_shell: false, allow_web: false, ask_each: true },
    },
    auto: {
      icon: '•', label: 'Auto approve', colorClass: 'perm-auto',
      flags: { allow_write: true, allow_shell: true, allow_web: true, ask_each: false },
    },
    full: {
      icon: '•', label: 'Full access', colorClass: 'perm-full',
      flags: { allow_write: true, allow_shell: true, allow_web: true, ask_each: false },
    },
  };
  let permissionMode = readSetting('fennec-permission-mode', 'ask');
  if (!PERM_MODES[permissionMode]) permissionMode = 'ask';

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const timeline = $('timeline');
  const taskQueue = $('task-queue');
  const taskQueueList = $('task-queue-list');
  const taskQueueCount = $('task-queue-count');
  const composerInput = $('composer-input');
  const sendButton = $('send-button');
  const sendButtonIcon = $('send-button-icon');
  const rightPanel = $('right-panel');
  const appLayout = $('app-layout');
  const backendStatus = $('backend-status');
  const statusDot = document.querySelector('.status-dot');
  const agentCount = $('agent-count');
  const agentList = $('agent-list');
  const attentionBadge = $('attention-badge');
  const timelineHeader = $('timeline-header');
  const timelineTitle = $('timeline-title');
  const timelineStatusText = $('timeline-status-text');
  const timelineStatus = $('timeline-status');
  const timelineRepo = $('timeline-repo');
  const taskSearch = $('task-search');
  const attachmentChips = $('attachment-chips');
  const fileInput = $('file-input');
  const toastStack = $('toast-stack');

  function queueEntry(text, owner = 'user') {
    return { text: String(text || ''), owner: owner === 'ai' ? 'ai' : 'user' };
  }

  function normalizeQueue(items) {
    const entries = (Array.isArray(items) ? items : []).map((item) => {
      if (typeof item === 'string') return queueEntry(item);
      if (!item || typeof item.text !== 'string' || !item.text.trim()) return null;
      return queueEntry(item.text, item.owner);
    }).filter(Boolean);
    return entries.filter((item) => item.owner === 'ai').concat(entries.filter((item) => item.owner === 'user'));
  }

  function isAgentQueueItem(item) {
    return item && item.owner === 'ai';
  }

  function queueText(item) {
    return typeof item === 'string' ? item : item.text;
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Only restore real conversations — never empty drafts.
        state.tasks = (parsed.tasks || []).filter((t) => t && Array.isArray(t.msgs) && t.msgs.length > 0);
        state.activeId = parsed.activeId || null;
        state.queued = normalizeQueue(parsed.queued);
        if (state.activeId !== null && !state.tasks.some((t) => t.id === state.activeId)) {
          state.activeId = null;
        }
        state.nextId = (state.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0) || 0) + 1;
        for (const t of state.tasks) {
          // Only a run started by startCoreTask is supervised. A saved Rust chat
          // must never inherit the current backend's identity after a reload.
          t.core = t.core === true;
          if (!t.core) expireApprovals(t, EXPIRED_UNSUPERVISED);
          // Runtime-only flags must never survive a reload.
          t.polling = false;
          t.finalized = false;
          // A run that already said how it ended must not say it again after a
          // reload, so the flag is rebuilt from the card rather than dropped
          // along with the other runtime-only flags.
          t.endNoted = (t.msgs || []).some((m) => m.kind === 'result' && TERMINAL_NOTES.indexOf(m.content) !== -1);
          t.msgs = stripCallBlobs(stripDeliveryProse(collapseDeliveries(t.msgs)));
          // A finished conversation cannot still be holding a live question, so
          // reloads of older history do not pin a dead one in My Attention.
          if (LIVE_STATUSES.indexOf(t.status) === -1) expireApprovals(t, EXPIRED_ENDED);
          const maxMsg = (t.msgs || []).reduce((m, x) => Math.max(m, x.id || 0), 0);
          state.nextId = Math.max(state.nextId, maxMsg + 1);
        }
      }
    } catch (_) { /* corrupt storage — start fresh */ }
  }

  // One delivered file, one card: keep the last card of each path. History saved
  // while deliveries were keyed per call holds several cards for a file the run
  // rewrote, and only the last matches what is on disk now.
  function collapseDeliveries(msgs) {
    const lastOf = new Map();
    for (const m of msgs || []) {
      const mt = m.meta;
      if (m.kind === 'attach' && mt && mt.verb && mt.path) lastOf.set(mt.path, m);
    }
    return (msgs || []).filter((m) => {
      const mt = m.meta;
      return !(m.kind === 'attach' && mt && mt.verb && mt.path && lastOf.get(mt.path) !== m);
    });
  }

  // Conversations saved before the delivery chip carried the verb and size hold
  // the file list in the answer text. The chip is the report now, so the old
  // paragraph is trimmed off on load instead of showing the same file twice —
  // and an answer that was nothing but that paragraph goes with it.
  function stripDeliveryProse(msgs) {
    const out = [];
    for (const m of msgs || []) {
      if (typeof m.content === 'string' && m.kind !== 'user' && m.kind !== 'attach') {
        const at = m.content.indexOf('**Delivered ');
        if (at > -1) m.content = m.content.slice(0, at).replace(/\s+$/, '');
        if (!m.content.trim() && at > -1) continue;
      }
      out.push(m);
    }
    return out;
  }

  // A turn that wrote the call down instead of answering kept the call object
  // as its own answer card. Live, the step's call list filters it; restored
  // history has no call list, so the shape is read from the text — otherwise
  // the same `{"name": …}` fence is shown over and over as an answer.
  function stripCallBlobs(msgs) {
    return (msgs || []).filter((m) => m.kind !== 'result' || !callBlob(m.content));
  }

  // The words a gated call gets, from whichever half of the record this client
  // holds: the loop's own description when it has one, the tool table's phrase
  // when it only has the name. A raw `run_shell` is never shown to the user —
  // it is the loop's word for the call, not what the call does.
  // `fennec-ui/src/attention.rs::gate_title` is the source.
  function gateTitle(name, described) {
    const n = String(name || '').trim();
    const t = String(described || '').trim();
    if (t && t !== n) return t;
    return String(describeCall(n, {}).title || n).trim();
  }

  // An answer the user already sent is not a question: the card leaves the run
  // and My Attention keeps it in the answered list. An expired one stays — the
  // run stopped with nothing to click, which has to be said.
  // `fennec-ui/src/attention.rs::card_shows` is the source.
  function cardShows(status) {
    return status !== 'resolved';
  }

  // A question with no live run behind it stops being answerable: expired, not
  // pending, so it leaves the attention count instead of pinning the task.
  function expireApprovals(task, note, live) {
    for (const a of (task.approvals || [])) {
      if (a.status !== 'pending') continue;
      if (live && live.indexOf(a.id) !== -1) continue;
      a.status = 'expired';
      a.note = note;
      const m = (task.msgs || []).find((x) => x.meta && x.meta.approvalId === a.id);
      if (m) { m.meta.status = 'expired'; m.meta.note = note; }
    }
  }

  function markTaskDisconnected(task, note) {
    expireApprovals(task, note);
    state.backendConnected = false;
    updateBackendStatus();
  }

  function saveState() {
    if (!settings.autoSave) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tasks: state.tasks.filter((t) => t.msgs && t.msgs.length > 0),
        activeId: state.activeId,
        queued: state.queued,
      }));
    } catch (_) { /* quota exceeded — silently drop */ }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function now() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // An answer is Markdown: the loop writes `**bold**`, `- ` bullets and `code`
  // spans, and the timeline showing the asterisks verbatim reads as broken.
  // Every line is escaped first, so this only ever adds the markup the loop
  // itself wrote — a `<script>` in an answer stays text.
  function inlineMd(line) {
    return escapeHtml(line)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // Mirrors fennec-ui/src/markdown.rs:rich_blocks — the fences come out of the
  // text before any inline markup is applied, so a shell prompt inside one stays
  // literal code and never shows the backticks it was written with.
  function mdBody(text) {
    const out = [];
    let para = [];
    let list = null;
    let code = null;
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      if (list) out.push('<ul class="md-list">' + list.join('') + '</ul>');
      list = null;
    };
    const flushCode = () => {
      if (!code) return;
      const label = code.lang
        ? '<div class="md-code-lang">' + escapeHtml(code.lang) + '</div>'
        : '';
      out.push('<div class="md-code">' + label + '<pre><code>'
        + escapeHtml(code.lines.join('\n')) + '</code></pre></div>');
      code = null;
    };
    // A fence's first line is a language only when it looks like one; anything
    // else is the code itself, which is what the native renderer assumes.
    const looksLikeLang = (s) => /^[A-Za-z0-9_+\-.]{1,16}$/.test(s);
    for (const line of String(text || '').split('\n')) {
      const fence = line.match(/^ {0,3}(`{3,})(.*)$/);
      if (code) {
        if (fence && !fence[2].trim() && fence[1].length >= code.ticks) flushCode();
        else code.lines.push(line);
        continue;
      }
      if (fence) {
        flushPara(); flushList();
        const info = fence[2].trim();
        code = { ticks: fence[1].length, lang: '', lines: [] };
        if (looksLikeLang(info)) code.lang = info;
        else if (info) code.lines.push(info);
        continue;
      }
      const item = line.match(/^\s*[-*]\s+(.*)$/);
      if (item) {
        flushPara();
        (list = list || []).push('<li>' + inlineMd(item[1]) + '</li>');
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line.trim());
    }
    flushCode();
    flushPara();
    flushList();
    return out.join('');
  }

  // Speech reads prose, not markup: the Markdown that formats a bubble would be
  // spoken out loud as "asterisk asterisk".
  function stripMd(text) {
    return String(text == null ? '' : text)
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '');
  }

  function activeTask() {
    return state.tasks.find((t) => t.id === state.activeId) || null;
  }

  function isWorking() {
    const t = activeTask();
    return !!t && LIVE_STATUSES.indexOf(t.status) !== -1;
  }

  function formatElapsed(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function toast(text, kind) {
    if (!toastStack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = text;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function debugLog() {
    if (settings.debug && window.console) console.debug.apply(console, arguments);
  }

  function msgText(content) {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      if (typeof content.Text === 'string') return content.Text;
      if (content.Reasoning && typeof content.Reasoning.summary === 'string') return content.Reasoning.summary;
      if (content.Code && typeof content.Code.code === 'string') return content.Code.code;
      if (Array.isArray(content.Mixed)) return content.Mixed.map(msgText).join('\n');
      return JSON.stringify(content);
    }
    return '';
  }

  function pushMsg(task, msg) {
    msg.id = state.nextId++;
    if (!msg.ts) msg.ts = Date.now();
    if (!msg.time) msg.time = now();
    task.msgs.push(msg);
    return msg;
  }

  // The words that end a run. Both the local stop and the backend's `cancelled`
  // step describe the same ending, and the poll timeout can land on a run the
  // user already stopped, so only the first of them reaches the timeline.
  const TERMINAL_NOTES = [
    'Task stopped by user.', 'Task cancelled.', 'Response timed out.', 'Task error.',
    'Lost contact with the backend while waiting for the response.',
  ];

  function noteEnd(task, content) {
    if (task.endNoted) return;
    task.endNoted = true;
    pushMsg(task, { author: 'Fennec', content, kind: 'result', collapsed: false });
  }

  // The tool names the loop advertises (tools.py:TOOLS) and the
  // fence languages that mean "run this in a shell" (loop.py:_SHELL_LANGS).
  // Same tables the native shell reads, so both surfaces call the same text a
  // blob.
  const TOOL_NAMES = new Set([
    'list_dir', 'read_file', 'write_file', 'edit_file', 'grep', 'semantic_search',
    'run_python', 'run_shell', 'git_status', 'git_diff', 'web_task', 'coworker_task',
    'propose_queue', 'summarise',
  ]);
  const SHELL_LANGS = new Set([
    'bash', 'sh', 'shell', 'zsh', 'ksh', 'powershell', 'pwsh', 'cmd', 'bat',
  ]);

  function fenceBlocks(text) {
    const out = [];
    const re = /```([^\n]*)\n([\s\S]*?)(?:```|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ lang: m[1].trim().toLowerCase(), body: m[2] });
    return out;
  }

  function jsonNamesTool(s) {
    const t = String(s || '').trim();
    if (t[0] !== '{' && t[0] !== '[') return false;
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.some(walk);
        if (n && typeof n === 'object') {
          for (const k of ['name', 'tool', 'type', 'command']) {
            if (typeof n[k] === 'string' && TOOL_NAMES.has(n[k])) return true;
          }
          return Object.values(n).some(walk);
        }
        return false;
      };
      if (walk(JSON.parse(t))) return true;
    } catch (_) { /* a call that ran out of room has no parseable JSON */ }
    const head = t.match(/"(?:name|tool|type|command)"\s*:\s*"([a-z_][a-z0-9_]*)"/);
    return !!(head && TOOL_NAMES.has(head[1]));
  }

  // Text that is a tool call the model spelled out rather than an answer: the
  // bare object, the <tool_code> tag, the same shapes inside a code fence, a
  // fence named after a tool, or a reply that is nothing but shell blocks.
  // Read from the text alone, so it also works on restored history, where the
  // step's call list is gone. A fence holding ordinary code, and any prose
  // around it, is formatted output and stays on screen.
  function callBlob(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (t[0] === '<') return true;
    if (t[0] === '{' || t[0] === '[') return jsonNamesTool(t);
    const blocks = fenceBlocks(t);
    if (!blocks.length) return t.includes('<tool_code>');
    for (const b of blocks) {
      if (TOOL_NAMES.has(b.lang.replace(/^tool:/, '').trim())) return true;
      const body = b.body.trim();
      if (jsonNamesTool(body)) return true;
      if (body.startsWith('<tool_code>')) return true;
      const head = (body.split('\n')[0] || '').trim().replace(/^tool_/, '').split(/[\s(=]/)[0];
      if (TOOL_NAMES.has(head)) return true;
    }
    return t.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '').trim() === ''
      && blocks.some((b) => SHELL_LANGS.has(b.lang) && b.body.trim());
  }

  // What the model writes when it is answering a tool prompt rather than the
  // user: the call object, or the tagged/fenced form of one. Prose starts with a
  // word. A fence or a call key beside prose counts only when the loop read a
  // call out of that same step — the same fence with no call in it is the model
  // answering with formatted code, which belongs on screen.
  function looksLikeCall(text, madeCall) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (callBlob(t)) return true;
    if (t.charAt(0) === '{' || t.charAt(0) === '[' || t.charAt(0) === '<') return true;
    if (t.charAt(0) === '`') return t.slice(0, 3) === '```' && !!madeCall;
    return !!madeCall && /"(tool|name|command|args|arguments)"\s*:/.test(t);
  }

  // ── Tool kind → display mapping (events.rs ToolEventKind) ─────────────────
  const TOOL_KINDS = {
    InspectRepository: { label: 'Inspect repository', icon: 'search', category: 'source' },
    ReadFile: { label: 'Read file', icon: 'file', category: 'source' },
    SearchCode: { label: 'Search code', icon: 'search', category: 'source' },
    CreateFile: { label: 'Create file', icon: 'file', category: 'edit' },
    EditFile: { label: 'Edit file', icon: 'file', category: 'edit' },
    DeleteFile: { label: 'Delete file', icon: 'tool', category: 'edit' },
    ReviewDiff: { label: 'Review diff', icon: 'panel', category: 'edit' },
    RunCommand: { label: 'Run command', icon: 'tool', category: 'command' },
    RunTestSuite: { label: 'Run tests', icon: 'tool', category: 'command' },
    BuildProject: { label: 'Build project', icon: 'tool', category: 'command' },
    LintProject: { label: 'Lint project', icon: 'tool', category: 'command' },
    FormatProject: { label: 'Format project', icon: 'tool', category: 'command' },
    SearchDocumentation: { label: 'Search documentation', icon: 'search', category: 'web' },
    OpenUrl: { label: 'Open URL', icon: 'search', category: 'web' },
    AnalyzeImage: { label: 'Analyze image', icon: 'image', category: 'other' },
    GenerateArtifact: { label: 'Generate artifact', icon: 'file', category: 'edit' },
    VerifyImplementation: { label: 'Verify implementation', icon: 'check', category: 'other' },
    GitFetch: { label: 'Git fetch', icon: 'tool', category: 'command' },
    GitPull: { label: 'Git pull', icon: 'tool', category: 'command' },
    GitCommit: { label: 'Git commit', icon: 'tool', category: 'command' },
    GitPush: { label: 'Git push', icon: 'tool', category: 'command' },
    PullRequestOperation: { label: 'Pull request', icon: 'tool', category: 'other' },
    FineTuneModel: { label: 'Fine-tune model', icon: 'tool', category: 'other' },
    EvaluateFineTunedModel: { label: 'Evaluate model', icon: 'tool', category: 'other' },
  };

  // The core loop's own registry (tools.py) names calls in snake
  // case; the Rust table above names the same actions in enum form. Both arrive
  // here so a card never falls back to a bare "🔧 write_file".
  const CORE_TOOL_KINDS = {
    write_file: { label: 'Write file', icon: 'file', category: 'edit' },
    edit_file: { label: 'Edit file', icon: 'file', category: 'edit' },
    read_file: { label: 'Read file', icon: 'file', category: 'source' },
    list_dir: { label: 'Inspect repository', icon: 'workspace', category: 'source' },
    grep: { label: 'Search code', icon: 'search', category: 'source' },
    semantic_search: { label: 'Semantic search', icon: 'search', category: 'source' },
    run_shell: { label: 'Run command', icon: 'tool', category: 'command' },
    run_python: { label: 'Run python', icon: 'tool', category: 'command' },
    git_status: { label: 'Repository status', icon: 'tool', category: 'command' },
    git_diff: { label: 'Review diff', icon: 'panel', category: 'edit' },
    web_task: { label: 'Web research', icon: 'search', category: 'web' },
    coworker_task: { label: 'Delegate to coworker', icon: 'workspace', category: 'other' },
    summarise: { label: 'Summarise the run', icon: 'check', category: 'other' },
  };

  // Mirrors fennec-ui/src/inspector.rs. Reading, writing, searching and running
  // a command are on from the first token of every run, so they are not skills
  // the user reached for; and a command is only a process while its process is
  // still alive, which is why Processes empties itself when the call returns.
  const DEFAULT_TOOLS = ['read_file', 'write_file', 'edit_file', 'run_shell', 'grep', 'semantic_search'];
  const COMMAND_TOOLS = ['run_shell', 'run_python', 'git_status', 'git_diff'];
  const isDefaultTool = (kind) => DEFAULT_TOOLS.includes(kind);
  const isCommandTool = (kind) => COMMAND_TOOLS.includes(kind);

  // What a call is about, worded the way fennec-ui/src/attention.rs:describe_call
  // words it, so the native shells and this one title the same call alike.
  function describeCall(name, args) {
    const a = args || {};
    const s = (k) => (typeof a[k] === 'string' ? a[k] : '');
    switch (name) {
      case 'list_dir': return { title: 'Inspect repository ' + (s('path') || s('dir') || '.'), path: '' };
      case 'read_file': return { title: 'Read file ' + (s('path') || s('file')), path: s('path') || s('file') };
      case 'write_file': return { title: 'Write file ' + s('path'), path: s('path') };
      case 'edit_file': return { title: 'Edit file ' + s('path'), path: s('path') };
      case 'grep': return { title: 'Search code ' + (s('pattern') || s('query')), path: '' };
      case 'semantic_search': return { title: 'Semantic search ' + s('query'), path: '' };
      case 'run_python': return { title: 'Run python ' + s('code').slice(0, 48), path: '' };
      case 'run_shell': return { title: 'Run command ' + (s('cmd') || s('command')), path: '' };
      case 'git_status': return { title: 'Repository status', path: '' };
      case 'git_diff': return { title: 'Review diff', path: '' };
      case 'web_task': return { title: 'Web research task', path: '' };
      case 'coworker_task': return { title: 'Delegate to OpenBot coworker', path: '' };
      case 'summarise': return { title: 'Summarise the run', path: '' };
      default: return { title: name || 'Action', path: '' };
    }
  }

  // The two calls that touch the disk. Delivery is keyed on the tool, not on a
  // category, so a read that mentions a path never shows up as a written file.
  const WRITE_TOOLS = { write_file: 'created', edit_file: 'updated' };

  // Mirrors fennec-ui/src/attention.rs:write_of_title. A path may hold spaces
  // (and even the separator), so only a leading `EDIT · ` badge is stripped and
  // the file is everything after the word `file`.
  function writeOfTitle(title) {
    let t = String(title || '');
    if (t.startsWith('EDIT · ')) t = t.slice('EDIT · '.length);
    const verb = /^write\b/i.test(t) ? 'created' : /^edit\b/i.test(t) ? 'updated' : '';
    if (!verb) return null;
    const at = t.indexOf(' file ');
    const path = at < 0 ? '' : t.slice(at + 6).trim();
    return path ? { verb, path } : null;
  }

  // The verb a message's call used on a file, or '' when the call wrote nothing.
  // A failed write wrote nothing, so it counts with the calls that merely ran.
  function writeVerb(m) {
    const d = m.meta || {};
    if (m.kind === 'attach') return d.verb || '';
    if (m.kind === 'edit') return d.verb || 'updated';
    if (m.kind !== 'action') return '';
    if (d.status === 'Running' || d.status === 'Failed') return '';
    return WRITE_TOOLS[d.toolKind] || (writeOfTitle(d.title) || {}).verb || '';
  }

  // The file a message is about, from the delivery card first and the call's own
  // words after, because a row is keyed on the file it names.
  function writtenPath(m) {
    const d = (m && m.meta) || {};
    return d.path || (writeOfTitle(d.title) || {}).path || '';
  }

  function extOf(name) {
    const dot = (name || '').lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  }

  // Mirrors fennec-ui/src/markdown.rs:artifact_kind / artifact_badge.
  const ARTIFACT_KINDS = {
    md: 'Markdown attachment', rs: 'Rust source', py: 'Python source',
    json: 'Config file', toml: 'Config file', yaml: 'Config file', yml: 'Config file',
    txt: 'Text file', js: 'Script', ts: 'Script', tsx: 'Script', jsx: 'Script',
    html: 'HTML', htm: 'HTML', css: 'CSS',
  };
  function artifactKind(name) { return ARTIFACT_KINDS[extOf(name)] || 'File attachment'; }
  function artifactBadge(name) { return (extOf(name) || 'file').toUpperCase().slice(0, 4); }

  function baseName(p) {
    const segs = String(p || '').split(/[\\/]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : (p || 'file');
  }

  // Mirrors fennec-ui/src/timeline.rs: the row-shortening rule the three surfaces
  // share. A call that names a file is shown by the file's name, a command by its
  // first ROW_WORDS words, and the whole path or command comes back when the user
  // opens the row.
  const ROW_WORDS = 7;
  const FILE_VERBS = ['read file ', 'write file ', 'edit file ', 'delete file '];

  // The category badge some surfaces put in front of a call's own words is already
  // the row icon, so it is not part of the count.
  function stripBadge(title) {
    const at = title.indexOf(' · ');
    if (at < 0) return title;
    const badge = title.slice(0, at);
    return badge.length <= 6 && /^[A-Z_]+$/.test(badge) ? title.slice(at + 3) : title;
  }

  function calledFile(title) {
    const body = stripBadge(String(title || ''));
    const lower = body.toLowerCase();
    for (const verb of FILE_VERBS) {
      if (lower.startsWith(verb)) return body.slice(verb.length).trim() || null;
    }
    return null;
  }

  function shortText(path, title) {
    const p = String(path || '').trim();
    const file = p || calledFile(title);
    if (file) return baseName(file);
    const words = stripBadge(String(title || '')).split(/\s+/).filter(Boolean);
    return words.length <= ROW_WORDS ? words.join(' ') : words.slice(0, ROW_WORDS).join(' ') + ' …';
  }

  // Mirrors fennec-ui/src/timeline.rs `unique_actions`: which of a block's calls
  // get a row, in call order — every call that did not write a file, and for each
  // file the last write of it, so a model that rewrote one file six times is
  // reported as one file. An empty path names no file and so never collapses.
  function uniqueActions(shapes, paths) {
    const lastOf = new Map();
    shapes.forEach((s, i) => {
      if (s.wrote && paths[i]) lastOf.set(paths[i], i);
    });
    return shapes.map((s, i) => i).filter((i) => !shapes[i].wrote || !paths[i] || lastOf.get(paths[i]) === i);
  }

  function revealText(short, full, body) {
    if (short === full) return body;
    if (!String(body || '').trim()) return full;
    return full + '\n\n' + body;
  }

  // Mirrors fennec_ui::timeline::fold_words: the folded words of a thought. A
  // paragraph of reasoning reads as one line among the calls it happened
  // between, with the same ellipsis a cut command carries; the whole thing comes
  // back when the user opens the row.
  function thoughtPreview(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    return words.length <= ROW_WORDS ? words.join(' ') : words.slice(0, ROW_WORDS).join(' ') + ' …';
  }

  // Mirrors fennec-ui/src/markdown.rs:attachment_subtitle — a file at the
  // workspace root has no directory to name, so it shows the kind alone.
  function attachmentSubtitle(relPath, name) {
    const segs = String(relPath || '').split(/[\\/]/).filter(Boolean);
    segs.pop();
    const dir = segs.join('/');
    const kind = artifactKind(name);
    return dir ? dir + ' · ' + kind : kind;
  }

  function toolMeta(kind) {
    return TOOL_KINDS[kind] || CORE_TOOL_KINDS[kind]
      || { label: kind || 'Action', icon: 'tool', category: 'other' };
  }

  function toolContent(te) {
    const parts = [];
    if (te.input != null) parts.push(typeof te.input === 'string' ? te.input : JSON.stringify(te.input, null, 2));
    if (te.output && te.output.summary) parts.push(te.output.summary);
    if (te.output && te.output.exit_code != null) parts.push('exit code: ' + te.output.exit_code);
    if (te.error && te.error.message) parts.push('error: ' + te.error.message);
    return parts.join('\n\n') || '(no details)';
  }

  // ── Render: left panel — workspace tree with tasks indented ────────────────
  function buildTaskRow(tk) {
    const li = document.createElement('li');
    li.className = 'task-item' + (tk.id === state.activeId ? ' active' : '');
    const dotClass = tk.status === 'Running' || tk.status === 'Planning' ? 'running'
      : tk.status === 'Complete' ? 'complete'
      : tk.status === 'Failed' ? 'failed' : 'waiting';
    li.innerHTML = `
      <div class="task-item-main">
        <div class="task-item-title">${escapeHtml(tk.title)}</div>
        <div class="task-item-meta">
          <span class="task-status-dot ${dotClass}"></span>
          <span>${escapeHtml(tk.status)}</span>
          <span>·</span>
          <span>${escapeHtml(tk.repo || '')}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn" type="button" data-act="rename" title="Rename task" aria-label="Rename task">✎</button>
        <button class="task-action-btn" type="button" data-act="delete" title="Delete task" aria-label="Delete task">×</button>
      </div>`;
    li.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : null;
      if (act === 'rename') { renameTask(tk.id); return; }
      if (act === 'delete') { deleteTask(tk.id); return; }
      switchTask(tk.id);
    });
    return li;
  }

  function filteredTasks() {
    const q = state.searchQuery.trim().toLowerCase();
    let shown = state.tasks.slice().reverse(); // newest first
    if (q) {
      shown = shown.filter((t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.msgs || []).some((m) => (m.content || '').toLowerCase().includes(q)));
    }
    return shown;
  }

  function renderTaskList() {
    // Tasks live inside their workspace node; the tree is the single left list.
    renderWorkspaces();
  }

  function renameTask(id) {
    const tk = state.tasks.find((t) => t.id === id);
    if (!tk) return;
    const name = prompt('Rename task:', tk.title);
    if (!name || !name.trim()) return;
    tk.title = name.trim();
    saveState();
    renderAll();
  }

  // Mirrors fennec-ui/src/confirm.rs: heading, what is lost, the subject in a
  // mono inset, then Cancel and the colored action. The browser's own confirm()
  // can't be themed, so destructive actions go through this instead.
  function showConfirm(opts) {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = opts.title;
    $('confirm-detail').textContent = opts.detail;
    const subject = $('confirm-subject');
    subject.textContent = opts.subject || '';
    subject.hidden = !opts.subject;
    const action = $('confirm-action');
    action.textContent = opts.action || 'Confirm';
    action.className = 'button ' + (opts.danger === false ? 'primary' : 'danger');
    return new Promise((resolve) => {
      const settle = (answer) => {
        action.removeEventListener('click', onAction);
        $('confirm-cancel').removeEventListener('click', onCancel);
        $('confirm-cancel-x').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        resolve(answer);
      };
      const onAction = () => { dlg.close(); settle(true); };
      const onCancel = () => { dlg.close(); settle(false); };
      // Escape and the backdrop both close without a click handler of their own.
      const onClose = () => settle(false);
      action.addEventListener('click', onAction);
      $('confirm-cancel').addEventListener('click', onCancel);
      $('confirm-cancel-x').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }

  async function deleteTask(id) {
    const tk = state.tasks.find((t) => t.id === id);
    if (!tk) return;
    const ok = await showConfirm({
      title: 'Delete Task',
      detail: 'The task and everything it did are removed from this device. This can’t be undone.',
      subject: tk.title,
      action: 'Delete',
    });
    if (!ok) return;
    if (isCoreTask(tk)) {
      apiFetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tk.backendId }),
      }).catch(() => {});
    } else if (tk.backendId) {
      apiFetch('/api/tasks/' + encodeURIComponent(tk.backendId), { method: 'DELETE' }).catch(() => {});
    }
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      state.queued = [];
    }
    saveState();
    renderAll();
  }

  function switchTask(id) {
    state.activeId = id;
    saveState();
    renderAll();
    const tk = activeTask();
    if (tk && LIVE_STATUSES.indexOf(tk.status) !== -1 && !tk.polling) {
      if (isCoreTask(tk) && state.backendKind === 'core' && supportsCoding()) pollCore(tk);
      else if (tk.core !== true && state.backendKind === 'rust' && tk.backendId) pollTask(tk);
    }
  }

  // ── Render: center — timeline ──────────────────────────────────────────────
  // Polling re-renders on every tick. Rebuilding unconditionally detaches the
  // node under the pointer, so an approval button can vanish mid-click, and
  // forcing the scroll makes the timeline unscrollable while a task runs.
  function timelineKey(task) {
    if (!task) return 'none';
    let key = task.id + '#' + task.status + '#' + (task.title || '');
    for (const m of (task.msgs || [])) {
      const d = m.meta || {};
      key += '|' + m.id + ':' + m.kind + ':' + (m.collapsed ? 1 : 0) + ':' + (m.content || '') +
        ':' + (d.status || '') + (d.decision || '') + (d.note || '') + ':' + (d.chunks || 0) +
        ':' + (d.duration || '') + ':' + (d.toolKind || '') + ':' + (d.stream ? 1 : 0);
    }
    // Which blocks and rows are open lives in JS, not in the DOM this rebuild
    // throws away, so it has to be part of the key — otherwise opening a block
    // would compute the same timeline and paint nothing.
    key += '#g' + Array.from(groupState.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, open]) => id + (open ? '1' : '0')).join(',');
    key += '#r' + Array.from(openGroupRows).sort().join(',');
    return key;
  }

  let lastTimelineKey = '';

  function renderTimeline() {
    const task = activeTask();
    const key = timelineKey(task);
    if (key === lastTimelineKey) return;
    lastTimelineKey = key;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
    const previousTop = timeline.scrollTop;
    timeline.innerHTML = '';
    if (!task) {
      timelineHeader.hidden = true;
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.innerHTML = '<div class="timeline-empty-title">What would you like to do?</div><div class="muted">Start with a small, concrete ask. Your work will stay here.</div>';
      timeline.appendChild(empty);
      return;
    }

    timelineHeader.hidden = false;
    timelineTitle.textContent = task.title || 'New task';
    timelineRepo.textContent = (task.repo || 'local') + ' · ' + (task.branch || 'main');
    timelineStatusText.textContent = task.status;
    timelineStatus.className = 'status-badge status-' + String(task.status || '').toLowerCase();

    const ordered = task.msgs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const folds = foldCalls(ordered, task.id, isWorking());
    // The clock the running block carries, read once for the whole draw.
    const runSecs = task.startedAt ? Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000)) : 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const block = folds.at.get(i);
      if (block) timeline.appendChild(renderGroup(block.id, block.rows, block.live, runSecs));
      if (folds.hidden.has(i)) continue;
      const shown = ordered[i];
      // The block above is emitted whatever happens to this message: a folded
      // run of tool calls must not vanish because the card after it did.
      if (shown.kind === 'approval' && !cardShows((shown.meta || {}).status)) continue;
      timeline.appendChild(renderMessage(shown));
    }
    // The running block follows its own tail, so the rows the user is watching
    // are the ones on screen. Pinned after the insert, where the height is real.
    timeline.querySelectorAll('.tool-group-body[data-live]').forEach((b) => {
      b.scrollTop = b.scrollHeight;
    });
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
    else timeline.scrollTop = previousTop;
  }

  // A tick moves one number, and the running block holds the only copy of it.
  // Rebuilding the whole timeline for that would throw away the scroll position
  // inside the block — the rows the user just read would jump back under the cap.
  function tickTimer() {
    const task = activeTask();
    if (!task || !task.startedAt || !isWorking()) return;
    const secs = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
    timeline.querySelectorAll('.tool-group-header[data-live] .group-title').forEach((el) => {
      el.textContent = 'Running · ' + clock(secs);
    });
  }

  function chevron(m) {
    return m.collapsed ? '▸' : '▾';
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + m.kind;
    if (m.collapsed) wrap.classList.add('collapsed');
    const time = m.time || now();
    const meta = m.meta || {};

    switch (m.kind) {
      case 'user':
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-body">${escapeHtml(m.content)}</div>
            <div class="message-footer"><span class="message-time">${time}</span></div>
          </div>`;
        break;

      case 'think': {
        const chunks = meta.chunks || 0;
        const hint = chunks > 0 ? chunks + ' chunk' + (chunks !== 1 ? 's' : '') : 'waiting';
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1" role="button" tabindex="0" aria-expanded="${!m.collapsed}">
              <span class="action-label think-label">Thinking</span>
              <span class="chunk-hint">${escapeHtml(hint)}</span>
              <span class="message-time">${time}</span>
              <span class="collapse-indicator">${chevron(m)}</span>
            </div>
            <div class="message-body think-body">${escapeHtml(m.content)}</div>
          </div>`;
        break;
      }

      case 'action': {
        const tm = toolMeta(meta.toolKind);
        const title = meta.title || tm.label;
        // The header keeps the file's name or the command's first words; opening
        // the card prints the whole call above whatever it has returned.
        const short = shortText(meta.path || '', title);
        const status = meta.status || 'Complete';
        const dur = meta.duration ? ' · ' + meta.duration : '';
        const statusClass = status === 'Failed' ? 'failed' : status === 'Running' ? 'running' : 'complete';
        const lines = (m.content || '').split('\n').length;
        // The live progress line replaces the "running…" hint and the "No output
        // yet." body for exactly as long as the call is in flight. Its text is the
        // loop's, shown verbatim: never truncated, never re-cased, never rebuilt
        // from step/of.
        const prog = status === 'Running' ? meta.progress : null;
        const hint = prog ? prog.text + (prog.meter ? ' · ' + prog.meter : '')
          : status === 'Running' ? 'running…' : lines + ' line' + (lines !== 1 ? 's' : '');
        // Same placeholder the shared `action_card` draws: the running call is
        // kept out of the folded blocks so it can be watched, and an empty body
        // would make that toggle look dead.
        const bodyText = revealText(short, title, m.content)
          || (status === 'Running' ? 'No output yet.' : 'This call returned no output.');
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1" role="button" tabindex="0" aria-expanded="${!m.collapsed}">
              <span class="action-label">${escapeHtml(short)}</span>
              <span class="chunk-hint${prog ? ' call-progress' : ''}">${escapeHtml(hint)}</span>
              <span class="message-status ${statusClass}">${escapeHtml(status)}${escapeHtml(dur)}</span>
              <span class="message-time">${time}</span>
              <span class="collapse-indicator">${chevron(m)}</span>
            </div>
            <div class="message-body mono-body">${escapeHtml(prog ? prog.text : bodyText)}</div>
          </div>`;
        break;
      }

      case 'attach': {
        const fn = meta.title || 'file';
        const badge = meta.badge || (meta.isImage ? 'IMG' : artifactBadge(fn));
        // The chip says everything the old "Delivered N files" paragraph said:
        // where the file is, what the run did to it, and how big it came out.
        const said = [meta.subtitle || attachmentSubtitle(meta.path || '', fn)];
        if (meta.verb) said.push(meta.verb);
        if (meta.size) said.push(meta.size);
        if (meta.replaced != null && meta.verb && meta.verb !== 'created') {
          said.push(meta.replaced + ' replacement' + (meta.replaced === 1 ? '' : 's'));
        }
        wrap.innerHTML = `
          <div class="message-card">
            <div class="file-chip" role="button" tabindex="0" aria-label="Open ${escapeHtml(fn)}">
              <span class="file-chip-badge" aria-hidden="true">${escapeHtml(badge)}</span>
              <span class="file-chip-text">
                <span class="file-chip-name">${escapeHtml(fn)}</span>
                <span class="file-chip-sub">${escapeHtml(said.join(' · '))}</span>
              </span>
              <button class="file-chip-menu" type="button" aria-label="Actions for ${escapeHtml(fn)}">⋯</button>
            </div>
          </div>`;
        break;
      }

      case 'edit': {
        const fn = meta.title || 'file';
        const add = meta.add || 0;
        const del = meta.del || 0;
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <span class="action-label">${escapeHtml(meta.label || 'Edited 1 file')}</span>
              <button class="quiet-button review-btn" type="button">Review</button>
            </div>
            <div class="edit-row">
              <span class="mono">${escapeHtml(fn)}</span>
              <span><span class="ok">+${add}</span> <span class="err-text">-${del}</span></span>
            </div>
          </div>`;
        break;
      }

      case 'approval': {
        const pending = meta.status === 'pending';
        const expired = meta.status === 'expired';
        const risk = meta.risk || 'medium';
        const riskClass = risk === 'high' ? 'failed' : risk === 'medium' ? 'running' : 'complete';
        // The header asks in the loop's own words, never with a tool name: an
        // unknown tool is all its name has to offer, a known one gets the phrase.
        const ask = gateTitle(meta.action, meta.command);
        const cmd = String(meta.command || '').trim();
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <span class="action-label">${escapeHtml(ask)}</span>
              <span class="message-status ${riskClass}">${escapeHtml(risk)} risk</span>
              <span class="message-time">${time}</span>
            </div>
            ${cmd && cmd !== ask ? `<div class="message-body mono-body">${escapeHtml(cmd)}</div>` : ''}
            ${meta.reason ? `<div class="message-body muted">${escapeHtml(meta.reason)}</div>` : ''}
            <div class="approval-actions">
              ${pending ? APPROVAL_DECISIONS.map(([key, label]) => `<button class="quiet-button approval-btn${key.startsWith('reject') ? ' reject' : ''}" type="button" data-decision="${key}">${label}</button>`).join('') : `<span class="message-status ${expired ? 'failed' : (String(meta.decision || '').startsWith('allow') ? 'complete' : 'failed')}">${escapeHtml(expired ? 'not used · ' + (meta.note || EXPIRED_ENDED) : 'answer sent · ' + decisionLabel(meta.decision))}</span>`}
            </div>
          </div>`;
        break;
      }

      case 'result':
      default: {
        // The answer and the user's own words end with their time on the left,
        // where the line of type actually finished; no header row is left above
        // them holding nothing but a clock.
        const streaming = !!meta.stream;
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-body md">${mdBody(m.content)}</div>
            <div class="message-footer">
              ${streaming ? '<span class="message-status running">Streaming…</span>' : ''}
              <span class="message-time">${time}</span>
              <button class="tts-btn" type="button" title="Read aloud" aria-label="Read aloud">${iconSvg('volume')}</button>
            </div>
          </div>`;
        break;
      }
    }

    // Collapse / expand on header click (thoughts + actions, collapsed by default)
    const header = wrap.querySelector('[data-toggle]');
    if (header) {
      const toggle = () => {
        m.collapsed = !m.collapsed;
        wrap.classList.toggle('collapsed', m.collapsed);
        header.setAttribute('aria-expanded', String(!m.collapsed));
        const ind = header.querySelector('.collapse-indicator');
        if (ind) ind.textContent = chevron(m);
        saveState();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    }

    // Per-message text-to-speech
    const ttsBtn = wrap.querySelector('.tts-btn');
    if (ttsBtn) {
      ttsBtn.addEventListener('click', () => speakMessage(m, ttsBtn));
    }

    // Diff review
    const reviewBtn = wrap.querySelector('.review-btn');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', () => openDiff(m));
    }

    // Delivered file: the chip opens it, the menu holds the rest.
    const chip = wrap.querySelector('.file-chip');
    if (chip) {
      chip.addEventListener('click', (e) => {
        if (e.target.closest('.file-chip-menu')) return;
        openDeliveredFile(m);
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDeliveredFile(m); }
      });
      chip.querySelector('.file-chip-menu').addEventListener('click', (e) => {
        e.stopPropagation();
        openChipMenu(e.currentTarget, m);
      });
    }

    // Approval answers
    wrap.querySelectorAll('.approval-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = activeTask();
        if (t) answerApproval(t, meta.approvalId, btn.dataset.decision);
      });
    });

    return wrap;
  }

  // ── Folded tool calls ──────────────────────────────────────────────────────
  // Mirrors fennec-ui/src/timeline.rs. Everything one run does between two
  // answers — its thoughts, its reads, its writes, its commands — folds into one
  // block, and only the call the run is still inside stays on its own, where its
  // output can be watched. While the run is inside the stretch the block is the
  // present tense: open, with a ticking timer. The answer ends it: the timer goes,
  // the block says how many of each kind of call there were, and it closes.
  function foldsUp(m) {
    const d = m.meta || {};
    // A thought belongs to the stretch it was thought in, so it never starts a new
    // block of its own. Where it is drawn is the block's business.
    if (m.kind === 'think') return true;
    if (m.kind === 'action') return !!d.status && d.status !== 'Running';
    if (m.kind === 'attach') return !!d.verb;
    return m.kind === 'edit';
  }

  // Mirrors fennec_ui::timeline::clock: MM:SS, and H:MM:SS once it passes an hour.
  function clock(secs) {
    const n = Math.max(0, Math.floor(secs));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    const two = (v) => v.toString().padStart(2, '0');
    return h > 0 ? h + ':' + two(m) + ':' + two(s) : two(m) + ':' + two(s);
  }

  // The three buckets a settled block counts, in the order the line reads them:
  // disjoint, so a read or a write is not also counted as a tool. A thought is in
  // none of them. Mirrors fennec_ui::timeline::block_title.
  const COUNT_BUCKETS = [
    ['tools', 'ran', 'tool'],
    ['reads', 'read', 'file'],
    ['writes', 'wrote', 'file'],
  ];

  // Mirrors fennec_ui::timeline::kind_of: the call's own words decide, after the
  // category badge comes off, so a read is a read on either surface.
  function kindOf(m) {
    if (m.kind === 'think') return null;
    const d = m.meta || {};
    if (writeVerb(m)) return 'edit';
    const body = String(d.title || toolMeta(d.toolKind).label || '')
      .replace(/^[A-Z]+ · /, '').trim().split(/\s+/)[0].toLowerCase();
    if (body === 'read') return 'read';
    if (body === 'write' || body === 'edit' || body === 'delete') return 'edit';
    if (body === 'run') return 'run';
    if (body === 'search' || body === 'semantic' || body === 'inspect') return 'search';
    return 'action';
  }

  function blockTitle(rows, live, secs) {
    if (live) return 'Running · ' + clock(secs);
    const n = { tools: 0, reads: 0, writes: 0, thoughts: 0 };
    for (const r of rows) {
      // A row with no kind is a thought: what the run was thinking, not work it
      // delivered, so it belongs to no bucket.
      if (!r.kind) { n.thoughts += 1; continue; }
      if (r.kind === 'read') n.reads += 1;
      else if (r.kind === 'edit') n.writes += 1;
      else n.tools += 1;
    }
    const parts = [];
    for (const [bucket, verb, noun] of COUNT_BUCKETS) {
      const count = n[bucket];
      if (!count) continue;
      const object = count === 1 ? noun : noun + 's';
      // Only the phrase that comes first carries the line, so it takes the
      // capital — the first kept one, not the first of the table.
      const said = parts.length ? verb : verb[0].toUpperCase() + verb.slice(1);
      parts.push(said + ' ' + count + ' ' + object);
    }
    // Nothing counted, but the stretch was not empty: the run thought without
    // acting, and the block holds that.
    return parts.length ? parts.join(' · ') : (n.thoughts ? 'Thinking' : 'No calls');
  }

  function foldCalls(msgs, taskId, working) {
    const hidden = new Set();
    const at = new Map();
    let i = 0;
    while (i < msgs.length) {
      if (!foldsUp(msgs[i])) { i += 1; continue; }
      const start = i;
      let end = i;
      while (end < msgs.length && foldsUp(msgs[end])) end += 1;
      // Mirrors `live_stretch`: only the last stretch ticks, so a second run in the
      // same task can't put a live clock back on the first run's block.
      const live = working && end === msgs.length;
      const calls = [];
      for (let k = start; k < end; k += 1) {
        // A delivered file is its own card below the block, and a thought is not a
        // call, so the rows the counts come from are only the calls.
        if (msgs[k].kind !== 'attach' && msgs[k].kind !== 'think') calls.push(k);
      }
      const shapes = calls.map((k) => ({ wrote: !!writeVerb(msgs[k]) }));
      const paths = calls.map((k) => writtenPath(msgs[k]));
      // Mirrors `unique_actions`: the calls the block keeps, in the order the run
      // made them, with one row per file it rewrote.
      const kept = new Set(uniqueActions(shapes, paths));
      const slot = new Map();
      calls.forEach((k, j) => slot.set(k, j));
      // Walked in the stretch's own order, so a thought sits where the run thought
      // it instead of gathering at the end.
      const rows = [];
      const thought = new Set();
      for (let k = start; k < end; k += 1) {
        const j = slot.get(k);
        if (j !== undefined) { if (kept.has(j)) rows.push(msgs[k]); continue; }
        // The reasoning is a row of the block it was thought in, and it stays
        // after the answer lands: the block is where the thinking happened.
        if (msgs[k].kind === 'think' && String(msgs[k].content || '').trim()) {
          rows.push(msgs[k]);
          thought.add(k);
        }
      }
      // A delivered file stays a card of its own, so the block that absorbed the
      // call that wrote it does not hide it. A thought leaves the timeline only
      // where its own block took it as a row.
      for (let k = start; k < end; k += 1) {
        const m = msgs[k];
        if (m.kind === 'attach') continue;
        if (m.kind !== 'think' || thought.has(k)) hidden.add(k);
      }
      // The key is the message the stretch answers, not the one it starts with:
      // while the run is inside, the first message is the "Thinking…" placeholder,
      // and it is retired as soon as real text arrives. A block keyed on it would
      // change identity halfway through, so an open click made before the swap
      // would be orphaned and the block would fold itself back.
      const anchor = (start > 0 ? msgs[start - 1].id : msgs[start].id);
      if (rows.length) at.set(start, { id: taskId + ':' + anchor, rows, live });
      i = end;
    }
    return { hidden, at };
  }

  // Open blocks survive the per-tick rebuild, which keeps no DOM. The map holds
  // only what the user's own click said, and that outranks the rule the blocks
  // follow by themselves: open while the run is inside the stretch, folded once
  // its answer lands.
  const groupState = new Map();
  const openGroupRows = new Set();

  // Mirrors fennec_ui::timeline::block_open.
  function isGroupOpen(blockId, live) {
    const chosen = groupState.get(blockId);
    return chosen === undefined ? live : chosen;
  }

  function groupRowOf(m) {
    const d = m.meta || {};
    // The run's own reasoning, as a row of the block it was thought in. It folded
    // to seven words like any other row, and its click prints the whole thought.
    if (m.kind === 'think') {
      return { icon: 'thought', label: thoughtPreview(m.content), status: '', adds: 0, dels: 0, failed: false, msg: m, opens: 'text', kind: null };
    }
    if (writeVerb(m)) {
      const path = writtenPath(m);
      const name = baseName(d.title || path || 'file');
      return {
        icon: d.badge || artifactBadge(name),
        label: shortText(path, d.title || ''),
        status: writeVerb(m) || 'changed',
        adds: d.add || 0,
        dels: d.del || 0,
        failed: false,
        msg: m,
        kind: kindOf(m),
        // Only a delivered card knows how to read the file off disk; the call
        // that made it has its result text, which is what the row shows inline.
        opens: m.kind === 'attach' ? 'file' : 'text',
      };
    }
    const failed = d.status === 'Failed';
    // A call still in flight carries the loop's live line. foldsUp keeps a Running
    // card out of every block, so this is the belt to case 'action's braces — if the
    // fold rule ever lets one in, its row says what the call is doing rather than
    // the bare "Complete" the field would otherwise fall back to.
    const running = d.status === 'Running';
    const prog = running ? d.progress : null;
    return {
      icon: toolMeta(d.toolKind).icon,
      label: shortText(d.path || '', d.title || toolMeta(d.toolKind).label),
      status: prog ? prog.text + (prog.meter ? ' · ' + prog.meter : '')
        : failed ? 'Failed' : running ? 'running…' : (d.duration ? 'Complete · ' + d.duration : 'Complete'),
      adds: 0, dels: 0, failed,
      msg: m,
      kind: kindOf(m),
      opens: 'text',
    };
  }

  function renderGroup(blockId, msgs, live, secs) {
    const rows = msgs.map((m) => groupRowOf(m));
    const failed = rows.filter((r) => r.failed).length;
    const title = blockTitle(rows, live, secs);
    const open = isGroupOpen(blockId, live);
    const box = document.createElement('div');
    box.className = 'tool-group';
    box.innerHTML = `
      <div class="tool-group-header" role="button" tabindex="0" aria-expanded="${open}">
        <span class="group-chev">${open ? '▾' : '▸'}</span>
        <span class="group-icon">${iconSvg('tool')}</span>
        <span class="group-title">${escapeHtml(title)}</span>
        ${failed ? `<span class="group-failed">${failed} failed</span>` : ''}
      </div>`;
    const head = box.querySelector('.tool-group-header');
    if (live) head.dataset.live = '1';
    const toggle = () => {
      // The click records the opposite of what was on screen, so a live block the
      // user folded stays folded and a settled one they opened stays open — both
      // outrank the default that would otherwise re-fold or re-open it next tick.
      groupState.set(blockId, !open);
      renderTimeline();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    if (!open) return box;
    const body = document.createElement('div');
    body.className = 'tool-group-body';
    // The mark renderTimeline pins the scroll by: a block the run is still inside
    // shows its newest rows, and the answer that ends the run takes the mark off.
    if (live) body.dataset.live = '1';
    for (const r of rows) {
      const rowKey = blockId + ':' + r.msg.id;
      const rowOpen = openGroupRows.has(rowKey);
      const row = document.createElement('div');
      row.className = 'group-row' + (r.failed ? ' failed' : '') + (rowOpen ? ' open' : '');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.innerHTML = `
        <span class="group-row-icon mono">${UI_ICON_PATHS[r.icon] ? iconSvg(r.icon) : escapeHtml(r.icon)}</span>
        <span class="group-row-label mono">${escapeHtml(r.label)}</span>
        ${r.adds ? `<span class="ok mono">+${r.adds}</span>` : ''}
        ${r.dels ? `<span class="err-text mono">−${r.dels}</span>` : ''}
        <span class="group-row-status">${escapeHtml(r.status)}</span>`;
      const detail = document.createElement('div');
      detail.className = 'group-row-detail mono-body';
      const isThought = r.msg.kind === 'think';
      const text = (r.msg.content || '').trim() || (r.msg.meta || {}).diff || '';
      // Opening a row prints the whole path or command above what the call
      // returned; the folded label only ever carried a name or seven words. A
      // thought has no call output to append: its own words are the whole of it,
      // so the open row prints the reasoning and nothing else.
      const full = isThought
        ? String(r.msg.content || '').trim()
        : revealText(r.label, (r.msg.meta || {}).path || (r.msg.meta || {}).title || '', text);
      detail.textContent = full || 'No output was captured for this call.';
      const activate = () => {
        if (r.opens === 'text') {
          if (openGroupRows.has(rowKey)) openGroupRows.delete(rowKey); else openGroupRows.add(rowKey);
          renderTimeline();
        } else {
          openDeliveredFile(r.msg);
        }
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
      body.appendChild(row);
      if (rowOpen) body.appendChild(detail);
    }
    box.appendChild(body);
    return box;
  }

  // ── TTS (per assistant message) ────────────────────────────────────────────
  let speakingBtn = null;

  function stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (speakingBtn) {
      speakingBtn.classList.remove('speaking');
      speakingBtn.innerHTML = iconSvg('volume');
      speakingBtn = null;
    }
  }

  function speakMessage(m, btn) {
    if (!('speechSynthesis' in window)) {
      toast('Speech synthesis is not supported in this browser.', 'warn');
      return;
    }
    if (speakingBtn === btn) { stopSpeaking(); return; }
    stopSpeaking();
    const utter = new SpeechSynthesisUtterance(stripMd(m.content));
    utter.lang = 'en-US';
    utter.onend = () => { if (speakingBtn === btn) stopSpeaking(); };
    utter.onerror = () => { if (speakingBtn === btn) stopSpeaking(); };
    speakingBtn = btn;
    btn.classList.add('speaking');
    btn.innerHTML = iconSvg('stop');
    window.speechSynthesis.speak(utter);
  }

  // ── Diff dialog ────────────────────────────────────────────────────────────
  function openDiff(m) {
    const dlg = $('diff-dialog');
    const meta = m.meta || {};
    if (!dlg) return;
    if (!meta.diff) {
      toast('No diff captured for ' + (meta.title || 'this file') + '.', 'info');
      return;
    }
    $('diff-file').textContent = meta.title || 'file';
    $('diff-add').textContent = '+' + (meta.add || 0);
    $('diff-del').textContent = '-' + (meta.del || 0);
    $('diff-body').textContent = meta.diff;
    dlg.showModal();
  }

  // ── Delivered files: open, copy path, save a copy ─────────────────────────
  // The core loop owns the workspace on disk and answers /api/file for it. The
  // Rust chat backend has no file route and never writes a file, so a chip
  // aimed at it says what is missing instead of showing an empty pane.
  // A file the user attached is not a file the backend ever had. The browser
  // hands the page a name, a size and the bytes, and never a location, so the
  // card keeps the bytes the picker read and this is where the pane gets them.
  function readAttachmentView(meta) {
    if (typeof meta.text === 'string') {
      return {
        text: meta.text, lines: viewLines(meta.text),
        bytes: typeof meta.bytes === 'number' ? meta.bytes
          : new TextEncoder().encode(meta.text).length,
      };
    }
    // An image, or a file whose text never reached the card: what the card does
    // hold is shown above this line, and there is nothing below it to draw.
    return {
      error: (meta.isImage ? 'This attachment is an image'
        : 'This attachment carries no text')
        + '; its card holds only the name and the size.',
    };
  }

  // The line count the backend reports for the same bytes: a file that ends in a
  // newline has one line, not one and an empty one.
  function viewLines(text) {
    const body = String(text).replace(/\n+$/, '');
    return body ? body.split(/\r?\n/).length : 0;
  }

  async function readDelivered(m) {
    const meta = m.meta || {};
    // Only a card with a verb is a delivery: a run created or updated the file,
    // so the loop owns it and /api/file can read it back. The user's own
    // attachment has no verb and no path, and asking for one is a 404.
    if (!meta.verb) return readAttachmentView(meta);
    const path = meta.path;
    const contract = await probeCapabilities();
    if (capabilityBackendKind(contract) !== 'core' || !supportsCoding()) {
      return { error: 'Preview needs the supervised core agent loop. Start fennec-core and reload this page.' };
    }
    const root = meta.workspace || runFolder();
    const ws = root ? '&workspace=' + encodeURIComponent(root) : '';
    try {
      const r = await apiFetch('/api/file?path=' + encodeURIComponent(path) + ws);
      if (!r.ok) return { error: 'The backend refused ' + path + ' (HTTP ' + r.status + ').' };
      const j = await r.json();
      return { text: String(j.content || ''), lines: j.lines, bytes: j.bytes };
    } catch (e) {
      return { error: 'Could not reach the backend: ' + (e && e.message ? e.message : e) };
    }
  }

  // A delivered file opens in the right panel, beside the rest of the run's
  // context, so the timeline keeps its shape instead of being covered by a
  // modal. Each open is numbered: two clicks in a row must not let the first
  // file's text land on top of the second's name.
  let fileViewSeq = 0;
  // The viewer paints two kinds. Whichever is not the current one is hidden and
  // emptied, so a 4 MB bitmap does not stay decoded behind a text file, and a
  // stale `src` cannot flash back when the panel is reopened for other text.
  function setViewerKind(kind, name) {
    const img = $('file-viewer-image');
    const body = $('file-viewer-body');
    if (!img || !body) return;
    const image = kind === 'image';
    body.hidden = image;
    img.hidden = !image;
    if (image) {
      img.alt = name || 'image';
    } else {
      img.alt = '';
      img.removeAttribute('src');
    }
  }

  async function openDeliveredFile(m) {
    const seq = ++fileViewSeq;
    const dialog = $('file-viewer-dialog');
    if (!dialog) return;
    const meta = m.meta || {};
    const name = meta.title || 'file';
    $('file-viewer-title').textContent = name;
    const where = joinPath(meta.workspace || runFolder(), meta.path || '');
    const pathEl = $('file-viewer-path');
    pathEl.textContent = where;
    // An attached file has no location the page was ever told about, and a blank
    // row between the name and the size reads as a value that failed to load.
    pathEl.hidden = !where;
    $('file-viewer-meta').textContent = 'reading…';
    $('file-viewer-body').textContent = '';
    setViewerKind('text');
    if (!dialog.open) dialog.showModal();
    const res = await readDelivered(m);
    if (seq !== fileViewSeq) return;
    if (res.error) {
      $('file-viewer-meta').textContent = res.error;
      return;
    }
    const n = res.lines;
    // The file's size on disk, which the backend reports: the text shown here is
    // newline-decoded, so a CRLF file would otherwise read a few bytes short of
    // the same file in the desktop pane and on the card that delivered it.
    const bytes = typeof res.bytes === 'number' ? res.bytes : new TextEncoder().encode(res.text).length;
    $('file-viewer-meta').textContent = (n != null ? n + (n === 1 ? ' line' : ' lines') + ' · ' : '')
      + formatFileSize(bytes);
    $('file-viewer-body').textContent = res.text;
  }

  function closeFileViewer() {
    const dialog = $('file-viewer-dialog');
    if (dialog && dialog.open) dialog.close();
    // A closed dialog holds no bitmap: the decoded image is as big as the file.
    const img = $('file-viewer-image');
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    // Invalidate whatever read is still in flight so it cannot refill a closed panel.
    fileViewSeq++;
  }

  // A delivered path is relative to the workspace the run worked in. The card
  // shows it that way — repo-relative is how the agent refers to it — but a
  // copied or displayed location has to resolve from anywhere.
  function joinPath(root, rel) {
    if (!rel) return '';
    // "." is the core's own root, so a path relative to it needs no prefix.
    if (!root || root === '.') return rel;
    if (/^[a-zA-Z]:[\\/]/.test(rel) || rel[0] === '/' || rel.slice(0, 2) === '\\\\') return rel;
    const win = root.indexOf('\\') !== -1;
    const joined = root.replace(/[\\/]+$/, '') + (win ? '\\' : '/') + rel.replace(/^[\\/]+/, '');
    // A copied path gets pasted into a shell or an Open dialog; one mixed
    // separator in the middle of a Windows path reads as two different things.
    return win ? joined.replace(/\//g, '\\') : joined;
  }

  async function copyChipPath(m) {
    const meta = m.meta || {};
    // A picked file has no path to copy, and joining its name onto the workspace
    // would hand the user a location that never held it.
    if (!meta.verb) {
      toast('The page is never told where a picked file sits on your disk.', 'info');
      return;
    }
    const rel = meta.path || meta.title || '';
    const text = joinPath(meta.workspace || runFolder(), rel);
    try {
      await navigator.clipboard.writeText(text);
      toast('Path copied.', 'ok');
    } catch (_) {
      // The browser can refuse the clipboard (an unfocused window, a denied
      // permission). Showing the path is the next best thing to copying it —
      // and it must not read as if the copy had worked.
      toast('Copy blocked by the browser: ' + text, 'info');
    }
  }

  // Saving goes through the browser's own download, because a web page cannot
  // write to the folder the agent wrote in — the file is already on disk there.
  async function saveDeliveredCopy(m) {
    const res = await readDelivered(m);
    if (res.error) { toast(res.error, 'info'); return; }
    const url = URL.createObjectURL(new Blob([res.text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (m.meta && m.meta.title) || 'file';
    a.click();
    URL.revokeObjectURL(url);
  }

  let chipMenuEl = null;

  function closeChipMenu() {
    if (chipMenuEl) { chipMenuEl.remove(); chipMenuEl = null; }
  }

  function openChipMenu(anchor, m) {
    closeChipMenu();
    const menu = document.createElement('div');
    menu.className = 'chip-menu';
    menu.setAttribute('role', 'menu');
    const items = [
      { label: 'Open', run: () => openDeliveredFile(m) },
      { label: 'Copy path', run: () => copyChipPath(m) },
      { label: 'Save a copy', run: () => saveDeliveredCopy(m) },
    ];
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      b.addEventListener('click', () => { closeChipMenu(); it.run(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
    const top = r.bottom + 6 + menu.offsetHeight > window.innerHeight
      ? r.top - menu.offsetHeight - 6 : r.bottom + 6;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    chipMenuEl = menu;
    setTimeout(() => document.addEventListener('click', closeChipMenu, { once: true }), 0);
  }

  // ── Render: task queue (shown whenever prompts wait, working or not) ──────
  function renderQueue() {
    taskQueueList.innerHTML = '';
    const show = state.queued.length > 0;
    taskQueue.hidden = !show;
    if (!show) return;

    for (let i = 0; i < state.queued.length; i++) {
      const item = state.queued[i];
      const agentOwned = isAgentQueueItem(item);
      const li = document.createElement('li');
      li.className = 'task-queue-item' + (agentOwned ? ' queue-agent-item' : '');
      const controls = agentOwned
        ? '<span class="queue-locked" title="Added by Fennec and cannot be changed">AI · locked</span>'
        : `<span class="queue-controls">
            <button class="queue-action" type="button" data-action="up" data-idx="${i}" title="Move task up" aria-label="Move task up">↑</button>
            <button class="queue-action" type="button" data-action="down" data-idx="${i}" title="Move task down" aria-label="Move task down">↓</button>
            <button class="queue-action" type="button" data-action="edit" data-idx="${i}" title="Edit task" aria-label="Edit task">✎</button>
            <button class="queue-remove" type="button" data-action="remove" data-idx="${i}" title="Remove from queue" aria-label="Remove from queue">✕</button>
          </span>`;
      li.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-title" title="${escapeHtml(queueText(item))}">${escapeHtml(queueText(item))}</span>
        <span class="queue-status">${agentOwned ? 'AI' : (i === 0 ? 'Next' : 'Queued')}</span>
        ${controls}`;
      taskQueueList.appendChild(li);
    }
    taskQueueCount.textContent = state.queued.length + ' item' + (state.queued.length !== 1 ? 's' : '');

    taskQueueList.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const idx = Number(button.dataset.idx);
        const action = button.dataset.action;
        const item = state.queued[idx];
        if (!item || isAgentQueueItem(item)) return;
        if (action === 'edit') {
          const text = window.prompt('Edit queued task', queueText(item));
          if (text && text.trim()) item.text = text.trim();
        } else if (action === 'remove') {
          state.queued.splice(idx, 1);
        } else if (action === 'up' || action === 'down') {
          const step = action === 'up' ? -1 : 1;
          const target = state.queued.findIndex((candidate, candidateIndex) => {
            if (candidateIndex <= idx || isAgentQueueItem(candidate)) return false;
            return step > 0;
          });
          let swap = target;
          if (step < 0) {
            swap = -1;
            for (let candidateIndex = idx - 1; candidateIndex >= 0; candidateIndex--) {
              if (!isAgentQueueItem(state.queued[candidateIndex])) { swap = candidateIndex; break; }
            }
          }
          if (swap >= 0) [state.queued[idx], state.queued[swap]] = [state.queued[swap], state.queued[idx]];
        }
        saveState();
        renderQueue();
      });
    });
  }

  let drainingQueue = false;
  async function drainQueue() {
    if (drainingQueue || !state.queued.length || isWorking()) return;
    if (!supportsCoding()) {
      toast(codingUnavailableReason(), 'warn');
      return;
    }
    drainingQueue = true;
    const next = state.queued[0];
    try {
      const started = await sendMessage(queueText(next), true);
      if (started === true && state.queued[0] === next) {
        state.queued.shift();
        saveState();
        renderQueue();
      }
    } finally {
      drainingQueue = false;
    }
  }

  // ── Render: right panel — live context inspector ───────────────────────────
  function taskStats(task) {
    const stats = {
      delegations: [], commands: 0, toolKinds: {}, artifacts: 0,
      editedFiles: [], webReadings: [], sources: [], failed: 0,
    };
    if (!task) return stats;
    for (const m of task.msgs) {
      const meta = m.meta || {};
      if (m.kind === 'action') {
        const tm = toolMeta(meta.toolKind);
        if (meta.toolKind && !isDefaultTool(meta.toolKind)) stats.toolKinds[meta.toolKind] = (stats.toolKinds[meta.toolKind] || 0) + 1;
        if (meta.category === 'delegate' || tm.category === 'delegate') stats.delegations.push(meta.title || 'Delegation');
        else if (isCommandTool(meta.toolKind) && meta.status === 'Running') stats.commands++;
        else if (tm.category === 'web') stats.webReadings.push(meta.title || tm.label);
        else if (tm.category === 'source') stats.sources.push(meta.title || tm.label);
        if (meta.status === 'Failed') stats.failed++;
      } else if (m.kind === 'edit') {
        stats.artifacts++;
        if (meta.title) stats.editedFiles.push(meta.title);
      } else if (m.kind === 'attach' && meta.fromBackend) {
        stats.artifacts++;
      }
    }
    return stats;
  }

  function setContextValue(id, text, hasData) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'context-value ' + (hasData ? 'ok' : 'muted');
  }

  function renderRightPanel() {
    const working = isWorking();
    const task = activeTask();
    const stats = taskStats(task);
    const elapsed = task && task.startedAt ? formatElapsed(Date.now() - task.startedAt) : '00:00';

    // Active agents
    agentCount.textContent = working ? '1 online' : '0 online';
    agentList.innerHTML = '';
    if (working && task) {
      const item = document.createElement('div');
      item.className = 'agent-item';
      item.innerHTML = `
        <span class="agent-icon" aria-hidden="true">F</span>
        <div class="agent-info">
          <div class="agent-name">Fennec</div>
          <div class="agent-task">${escapeHtml(task.title)}</div>
          <div class="agent-status running">Running · ${elapsed}</div>
        </div>`;
      agentList.appendChild(item);
    } else {
      const note = document.createElement('div');
      note.className = 'agent-note muted';
      note.textContent = 'Nothing is running right now.';
      agentList.appendChild(note);
    }

    // Subagents — delegations seen in events / tool data
    if (stats.delegations.length > 0) {
      setContextValue('subagents-value',
        stats.delegations.length + ' delegation' + (stats.delegations.length !== 1 ? 's' : '') +
        ' · ' + stats.delegations.slice(-2).join(', '), true);
    } else {
      setContextValue('subagents-value', 'No one else is helping yet', false);
    }

    // Processes — only the commands whose process is still alive
    setContextValue('processes-value',
      stats.commands > 0
        ? stats.commands + ' command' + (stats.commands !== 1 ? 's' : '') + ' running in the background'
        : 'Nothing running in the background',
      stats.commands > 0);

    // Skills — what the run reached for beyond the tools it always has
    const kinds = Object.keys(stats.toolKinds);
    if (kinds.length > 0) {
      const top = kinds.sort((a, b) => stats.toolKinds[b] - stats.toolKinds[a]).slice(0, 3)
        .map((k) => toolMeta(k).label);
      setContextValue('skills-value', kinds.length + ' skill' + (kinds.length !== 1 ? 's' : '') + ' · ' + top.join(', '), true);
    } else {
      setContextValue('skills-value', 'Nothing used yet', false);
    }

    // Artifacts — produced files / edits
    const artifactEl = $('artifact-count');
    if (artifactEl) {
      const files = stats.editedFiles.length;
      artifactEl.textContent = stats.artifacts + ' artifact' + (stats.artifacts !== 1 ? 's' : '') +
        (files > 0 ? ' · ' + files + ' file' + (files !== 1 ? 's' : '') + ' changed' : '');
      artifactEl.className = 'context-value ' + (stats.artifacts > 0 ? 'ok' : 'muted');
    }

    // Web Readings — OpenUrl / SearchDocumentation
    if (stats.webReadings.length > 0) {
      setContextValue('webreadings-value',
        stats.webReadings.length + ' reading' + (stats.webReadings.length !== 1 ? 's' : '') +
        ' · ' + stats.webReadings[stats.webReadings.length - 1], true);
    } else {
      setContextValue('webreadings-value', 'No readings yet', false);
    }

    // Sources — files read / inspected / searched
    if (stats.sources.length > 0) {
      setContextValue('sources-value',
        stats.sources.length + ' source' + (stats.sources.length !== 1 ? 's' : '') +
        ' · ' + stats.sources[stats.sources.length - 1], true);
    } else {
      setContextValue('sources-value', 'No files opened yet', false);
    }

    // Attention badge: tasks blocked on the user (pending approvals) or failed,
    // across every workspace — not just the open task's error text.
    const attentionCount = state.tasks.filter(taskNeedsAttention).length;
    if (attentionBadge) {
      attentionBadge.textContent = attentionCount;
      attentionBadge.hidden = attentionCount === 0;
    }

    // Environment
    const ws = activeWorkspace();
    const envRepo = $('env-repo');
    const envBranch = $('env-branch');
    const envBackend = $('env-backend');
    if (envRepo) envRepo.textContent = (task && task.repo) || (ws ? ws.name : 'local');
    if (envBranch) envBranch.textContent = (task && task.branch) || 'main';
    if (envBackend) {
      envBackend.textContent = state.backendConnected ? 'Connected' : 'Disconnected';
      envBackend.className = 'env-value ' + (state.backendConnected ? 'ok' : 'muted');
    }
    renderOutlets();
  }

  // ── Outlets (/api/outlets) ─────────────────────────────────────────────────
  // The rows mirror fennec-client/src/agent.rs (Outlet::fennec / openbot / antigravity and
  // its outlet_rows), including its three states: never probed, probed
  // and empty, probed with data. `present` alone would be one word for three
  // different situations, and the detail is the actionable half — a browser lane
  // without a transport needs an install, one without a key needs a `setx`, and a
  // coworker workspace that will not answer has a reason a user can read.
  const OUTLETS = [
    { id: 'fennec', label: 'Fennec' },
    { id: 'openbot', label: 'OpenBot' },
    { id: 'antigravity', label: 'Antigravity' },
  ];

  function str(v) { return typeof v === 'string' ? v : ''; }

  // The transport usually lives in the interpreter running core, or in one the
  // user pinned, and neither needs a note. Anything else does: it says which other
  // interpreter will really run the loop, and whose uninstall would take it away.
  function transportNote(o) {
    const from = str(o.transport_from);
    if (!from || from === 'this interpreter' || from === 'pinned' || from === 'none') return '';
    return ' · browser transport ' + from;
  }

  function outletDetail(id, o) {
    if (id === 'fennec') {
      const model = str(o.model) || 'd1.2';
      if (o.present) {
        return 'installed — ' + (str(o.interpreter) || 'this interpreter') + transportNote(o) + ' · ' + model;
      }
      return o.transport ? 'not installed — ' + model + ' needs LIQUID_API_KEY or LIQUID_ENDPOINT'
                         : 'not installed — no python with the browser transport';
    }
    if (id === 'openbot') {
      const host = str(o.url);
      if (str(o.error)) return 'unavailable — ' + str(o.error);
      if (!o.present) return 'no agent list at ' + host;
      const n = (Array.isArray(o.agents) ? o.agents : [])
        .filter((a) => str(a.name) || str(a.id)).length;
      return n + ' coworker' + (n === 1 ? '' : 's') + ' at ' + host;
    }
    if (id === 'antigravity') {
      if (o.present) return 'installed — read-only workspace tools';
      return str(o.error) || 'not configured — install SDK, credentials and workspace';
    }
    return '';
  }

  // `null` is "the server never told us" — offline, a Rust backend with no such
  // route, or a request that failed. All three say unknown, because none of them
  // licenses the claim "not installed".
  function outletLines(status) {
    if (!status) return [{ key: 'Outlets', value: 'unknown (agent loop offline)', ok: false }];
    const rows = OUTLETS.filter((o) => status[o.id])
      .map((o) => ({
        key: o.label,
        value: outletDetail(o.id, status[o.id]),
        ok: !!status[o.id].present,
      }));
    return rows.length ? rows : [{ key: 'Outlets', value: 'the agent server named none', ok: false }];
  }

  function renderOutlets() {
    const box = $('env-outlets');
    if (!box) return;
    box.replaceChildren();
    for (const line of state.outlets || outletLines(null)) {
      const row = document.createElement('div');
      row.className = 'env-row outlet';
      const key = document.createElement('span');
      key.className = 'env-key';
      key.textContent = line.key;
      const value = document.createElement('span');
      // An interpreter path has no good break opportunities, so it wraps by force
      // rather than being cut - the row that hid it said less than "not installed".
      value.className = 'env-value wrap ' + (line.ok ? 'ok' : 'muted');
      value.textContent = line.value;
      row.append(key, value);
      box.appendChild(row);
    }
  }

  async function loadOutlets() {
    try {
      const resp = await apiFetch('/api/outlets');
      if (!resp.ok) return outletLines(null);
      return outletLines(await resp.json());
    } catch (_) {
      return outletLines(null);
    }
  }

  // ── Render all ─────────────────────────────────────────────────────────────
  function renderAll() {
    document.querySelector('[data-nav="attention"]').classList.toggle('active', state.attentionOnly);
    renderTaskList();
    renderTimeline();
    renderQueue();
    renderRightPanel();
    updateSendButton();
  }

  // Coalesce rapid streaming renders.
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      renderTimeline();
      renderRightPanel();
      updateSendButton();
    }, 80);
  }

  function updateSendButton() {
    if (isWorking()) {
      sendButton.disabled = false;
      sendButton.classList.add('stop');
      sendButton.setAttribute('aria-label', 'Stop task');
      sendButton.title = 'Stop the running task';
      sendButtonIcon.textContent = '■';
    } else {
      sendButton.classList.remove('stop');
      sendButton.setAttribute('aria-label', 'Send');
      sendButton.title = supportsCoding() ? 'Send prompt' : codingUnavailableReason();
      sendButtonIcon.textContent = '↑';
      sendButton.disabled = composerInput.value.trim().length === 0 && state.attachments.length === 0;
    }
  }

  // ── Attachments ────────────────────────────────────────────────────────────
  function renderAttachmentChips() {
    attachmentChips.innerHTML = '';
    attachmentChips.hidden = state.attachments.length === 0;
    state.attachments.forEach((att, idx) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.innerHTML = `
        <span class="attach-chip-icon">${iconSvg(att.isImage ? 'image' : 'file')}</span>
        <span class="attach-chip-name">${escapeHtml(att.name)}</span>
        <span class="attach-chip-size">${escapeHtml(formatFileSize(att.size))}</span>
        <button class="attach-chip-remove" type="button" data-idx="${idx}" title="Remove attachment" aria-label="Remove attachment">×</button>`;
      attachmentChips.appendChild(chip);
    });
    attachmentChips.querySelectorAll('.attach-chip-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.attachments.splice(parseInt(btn.dataset.idx, 10), 1);
        renderAttachmentChips();
        updateSendButton();
      });
    });
    updateSendButton();
  }

  function addFiles(files) {
    for (const file of files) {
      const isImage = /^image\//.test(file.type);
      const att = { name: file.name, size: file.size, type: file.type || 'file', isImage, text: null };
      state.attachments.push(att);
      if (!isImage) {
        const reader = new FileReader();
        reader.onload = () => {
          let text = String(reader.result || '');
          if (file.size > MAX_INLINE_BYTES) {
            text = text.slice(0, MAX_INLINE_BYTES) + '\n…[truncated — file exceeds 200 KB inline limit]';
          }
          att.text = text;
        };
        reader.onerror = () => { att.text = null; };
        reader.readAsText(file);
      }
    }
    renderAttachmentChips();
  }

  // The backend chat endpoint accepts text only ({ content: String }), so text
  // documents are inlined into the prompt and images are referenced by name.
  function buildPrompt(text) {
    let prompt = text;
    for (const att of state.attachments) {
      if (att.isImage) {
        prompt += '\n\n[Attached image: ' + att.name + ' (' + att.type + ', ' + formatFileSize(att.size) + ') — image content not transmitted; text-only chat endpoint]';
      } else if (att.text != null) {
        prompt += '\n\n[Attached file: ' + att.name + ']\n```\n' + att.text + '\n```';
      } else {
        prompt += '\n\n[Attached file: ' + att.name + ' (' + formatFileSize(att.size) + ') — could not be read as text]';
      }
    }
    return prompt;
  }

  // ── Core supervised loop (/api/agent/*): the only coding backend ───────────
  // Rust advertises chat-only. The PWA never creates a Rust task from a coding
  // prompt; every start below is a core run whose task record carries core=true.

  // The workspace name a run is started in: the active workspace's own folder,
  // or "." meaning the core's configured root. Every delivered path is relative
  // to what this returns, so the file route has to be asked with the same name —
  // including for cards saved before the run's directory was recorded on them.
  function runFolder() {
    const ws = activeWorkspace();
    return (ws && Array.isArray(ws.source_folders) && ws.source_folders[0]) || '.';
  }

  async function startCoreTask(task, prompt) {
    const folder = runFolder();
    const flags = permissionMode === 'full'
      ? { allow_write: true, allow_shell: true, allow_web: true }
      : permissionMode === 'auto'
        ? { allow_write: true, allow_shell: true, allow_web: false }
        : { allow_write: false, allow_shell: false, allow_web: false };
    const resp = await apiFetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: prompt, workspace: folder, ...flags,
        require_approval: permissionMode === 'ask', max_steps: 14,
        reasoning_effort: currentEffort,
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    if (!j || typeof j.id !== 'string' || !j.id) throw new Error('Core did not return a session id');
    task.backendId = j.id;
    // The directory the run is jailed to. A delivered path is relative to it, so
    // opening one later has to name it back to the file route.
    task.backendWs = typeof j.workspace === 'string' ? j.workspace : '';
    task.core = true;
    // One generation per run. The stream and plan messages are rewritten in
    // place while a run is live, so they are only reusable inside their own
    // run — otherwise a second message in the same task would overwrite the
    // first run's answer.
    task.runGen = (task.runGen || 0) + 1;
    // The previous run's stages say nothing about this one.
    task.plan = [];
    // The tokens of this run's answer, held outside the card so a stream that
    // turns out to be a tool call can be withheld without losing its text.
    task.streamBuf = '';
  }

  function coreStreamMsg(task) {
    let m = task.msgs.find((x) => x.kind === 'result' && x.meta && x.meta.coreStream && x.meta.gen === task.runGen);
    if (!m) {
      m = pushMsg(task, { author: 'Fennec', content: '', kind: 'result', collapsed: false, meta: { coreStream: true, stream: true, gen: task.runGen } });
    }
    return m;
  }

  // A file the run wrote is handed to the user as its own card — badge, name,
  // "<dir> · <kind>" and an action menu — the way a written file is delivered
  // in Qoder. Every number on it comes from the tool's own result.
  function deliverFile(task, s) {
    const verb = WRITE_TOOLS[s.name];
    if (!verb) return;
    const rel = (s.args && typeof s.args.path === 'string') ? s.args.path.trim() : '';
    if (!rel) return;
    // One card per file, not per call: a run that rewrote the same file six times
    // delivered one file, and the card carries the last write's numbers.
    const key = 'deliver:' + rel;
    const result = s.result || {};
    const name = baseName(rel);
    const bytes = typeof result.bytes === 'number' ? result.bytes : '';
    const replaced = typeof result.replaced === 'number' ? result.replaced : null;
    const again = task.msgs.find((x) => x.meta && x.meta.deliveryKey === key);
    if (again) {
      again.meta.verb = verb;
      again.meta.replaced = replaced;
      if (bytes !== '') again.meta.size = formatFileSize(bytes);
      return;
    }
    pushMsg(task, {
      author: 'Fennec', content: '', kind: 'attach', collapsed: false,
      meta: {
        deliveryKey: key, title: name, path: rel, verb, replaced,
        workspace: task.backendWs || '',
        subtitle: attachmentSubtitle(rel, name),
        badge: artifactBadge(name), kindLabel: artifactKind(name),
        size: bytes === '' ? '' : formatFileSize(bytes),
      },
    });
  }

  // What the run changed is the chips themselves, one per delivered file, each
  // naming what happened to it. A prose list above them would repeat, in worse
  // type, what the card already says — and the card is the thing you can open.
  function applyCoreStep(task, s, thinkId) {
    const kind = s.type;
    if (kind === 'partial') {
      // Tokens arrive before it is known whether the model is answering or
      // spelling a tool. The buffer holds the run's text so a card is only
      // created once the stream reads as prose — and once a card exists it
      // keeps every token, so a call-shaped example inside a real answer
      // cannot truncate what the user is watching arrive.
      task.streamBuf = (task.streamBuf || '') + (s.content || '');
      const live = task.msgs.find((x) => x.kind === 'result' && x.meta
        && x.meta.coreStream && x.meta.gen === task.runGen);
      if (live || !looksLikeCall(task.streamBuf, false)) coreStreamMsg(task).content = task.streamBuf;
      if (thinkId) task.msgs = task.msgs.filter((x) => x.id !== thinkId);
    } else if (kind === 'reasoning') {
      const text = s.text || '';
      if (!text) return;
      let thought = thinkId != null ? task.msgs.find((x) => x.id === thinkId) : null;
      if (!thought) {
        thought = task.msgs.slice().reverse().find((x) => x.kind === 'think' && x.meta && x.meta.stream);
      }
      if (!thought) {
        thought = pushMsg(task, {
          author: 'Fennec', content: '', kind: 'think', collapsed: true,
          meta: { stream: true, chunks: 0 },
        });
      }
      if (thought.content === 'Connecting to engine…') thought.content = '';
      thought.content += text;
      thought.meta = thought.meta || {};
      thought.meta.stream = true;
      thought.meta.chunks = (thought.meta.chunks || 0) + 1;
    } else if (kind === 'assistant' || kind === 'final') {
      // The model's own reasoning rides on the assistant step, and it is what the
      // Thoughts block is for. The placeholder that said "Connecting to engine…"
      // is filled rather than dropped, so the thought stays above the answer it
      // produced. `stream` has to come off: the cleanup at the end of a run
      // deletes the streaming thoughts it thinks never arrived.
      const reasoning = String(s.reasoning || '').trim();
      const ph = thinkId != null ? task.msgs.find((x) => x.id === thinkId) : null;
      if (reasoning) {
        const t = ph || task.msgs.find((x) => x.kind === 'think' && x.meta && x.meta.coreReason
          && x.meta.gen === task.runGen);
        if (t) {
          t.content = reasoning;
          t.collapsed = true;
          t.meta = t.meta || {};
          t.meta.stream = false;
          t.meta.coreReason = true;
          t.meta.gen = task.runGen;
        } else {
          const created = pushMsg(task, {
            author: 'Fennec', content: reasoning, kind: 'think', collapsed: true,
            meta: { coreReason: true, gen: task.runGen },
          });
          // A thought belongs above the answer it produced, and the answer card
          // can already exist when the text streamed in before the reasoning did.
          const at = task.msgs.findIndex((x) => x.kind === 'result' && x.meta
            && x.meta.coreStream && x.meta.gen === task.runGen);
          if (at >= 0) {
            task.msgs.splice(task.msgs.length - 1, 1);
            task.msgs.splice(at, 0, created);
          }
        }
      }
      if (thinkId && !reasoning) {
        const placeholder = task.msgs.find((x) => x.id === thinkId);
        if (placeholder && (!placeholder.content || placeholder.content === 'Connecting to engine…')) {
          task.msgs = task.msgs.filter((x) => x.id !== thinkId);
        }
      }
      // The loop publishes each call spelling as its own `assistant` step, and
      // a turn that does not land a call spells the same blob again. As an
      // "answer" that is the same object over and over, and the call's own row
      // already says what ran, so a blob never becomes an answer card. The
      // `final` step is exempt: after the loop's one push-back it is the only
      // thing the run has to show.
      if (kind === 'assistant' && looksLikeCall(s.content, (s.tool_calls || []).length > 0)) {
        const at = task.msgs.findIndex((x) => x.kind === 'result' && x.meta
          && x.meta.coreStream && x.meta.gen === task.runGen);
        // The same blob arrives token by token as `partial` before the step that
        // names the call, so the card it filled goes with it.
        if (at >= 0) task.msgs.splice(at, 1);
        task.streamBuf = '';
        return;
      }
      const m = coreStreamMsg(task);
      m.content = s.content || m.content;
      // The step's text is authoritative and fuller than the tokens streamed so
      // far; the buffer has to agree with it or the next partial would rewind
      // the answer to what arrived first.
      task.streamBuf = m.content;
      if (kind === 'final') m.meta.stream = false;
    } else if (kind === 'plan') {
      // The loop's stage list is not something the run said — it is what the run
      // still means to do — so it is task state drawn as a checklist, never a
      // message row the timeline would fold or count.
      task.plan = (s.entries || []).map((e) => ({ text: e.content, done: e.status === 'completed' }));
    } else if (kind === 'tool_start') {
      const id = s.id || s.call_id || s.name;
      if (!task.msgs.some((x) => x.meta && x.meta.toolId === id)) {
        pushMsg(task, {
          author: 'Fennec', content: '', kind: 'action', collapsed: true,
          meta: { toolId: id, toolKind: s.name, title: describeCall(s.name, s.args).title, status: 'Running' },
        });
      }
    } else if (kind === 'progress') {
      // A long call's live line. It is not a step of the run's own account, so it
      // never becomes a message row: that would add a card to the running block and
      // move the "ran n tools" counts. It rides on the card its `tool_start` made,
      // which is what keeps one visible line per in-flight call_id — a newer
      // progress replaces the older instead of piling up rows. The card stays
      // Running, so the block stays the live/unfolded one.
      // The card this belongs to is found by call_id, so an unusable id is as wrong
      // a shape as a missing text — either way there is nothing to attach the line to.
      const text = s.text;
      const id = s.call_id;
      if (typeof text !== 'string' || !text) return;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      if (typeof id === 'string' && !id) return;
      const m = task.msgs.find((x) => x.meta && x.meta.toolId === id);
      if (!m) return;
      // `step`/`of` only ever drive the dim meter, and only when both are there;
      // either alone renders nothing extra. The loop's words go in verbatim.
      const step = s.step;
      const of = s.of;
      const meter = (Number.isInteger(step) && step > 0 && Number.isInteger(of) && of > 0)
        ? step + '/' + of : '';
      m.meta.progress = { text, meter };
    } else if (kind === 'tool') {
      const id = s.id || s.call_id || s.name;
      const status = s.ok ? 'Complete' : 'Failed';
      const output = s.result != null
        ? JSON.stringify(s.result).slice(0, 4000)
        : (s.output || s.error || '');
      const title = describeCall(s.name, s.args).title;
      const m = task.msgs.find((x) => x.meta && x.meta.toolId === id);
      if (m) { m.meta.title = title; m.meta.status = status; m.content = output || m.content; }
      else pushMsg(task, { author: 'Fennec', content: output, kind: 'action', collapsed: true, meta: { toolId: id, toolKind: s.name, title, status } });
      if (s.ok) deliverFile(task, s);
    } else if (kind === 'approval_required') {
      const id = s.approval_id;
      if (!task.approvals) task.approvals = [];
      if (!task.approvals.some((x) => x.id === id)) {
        const args = s.args || {};
        const rec = {
          id, action: s.name || 'action',
          // The loop's own words for the call, the same field the Rust backend
          // fills: "Run command cargo test", not the tool name and not a bare
          // argument the card would have to explain.
          command: describeCall(s.name, args).title || null,
          reason: s.reason || '', risk: s.risk || 'medium',
          status: 'pending', decision: null,
        };
        task.approvals.push(rec);
        task.status = 'WaitingForApproval';
        pushMsg(task, {
          author: 'Fennec', content: rec.command || rec.action, kind: 'approval', collapsed: false,
          meta: { approvalId: id, action: rec.action, command: rec.command, reason: rec.reason, risk: rec.risk, status: 'pending', decision: null },
        });
      }
    } else if (kind === 'queue') {
      // The loop's own follow-ups for a run it judged complex. They go into the
      // same list the user's waiting prompts use, so they drain, show and can be
      // removed exactly the same way. It arrives before the step that ends the
      // run, so the first one is already waiting when the queue drains.
      const incoming = [];
      for (const text of s.items || []) {
        const prompt = String(text || '').trim();
        if (prompt && !state.queued.some((item) => queueText(item) === prompt)) {
          incoming.push(queueEntry(prompt, 'ai'));
        }
      }
      if (incoming.length) {
        const firstUser = state.queued.findIndex((item) => !isAgentQueueItem(item));
        state.queued.splice(firstUser === -1 ? state.queued.length : firstUser, 0, ...incoming);
      }
      saveState();
      renderQueue();
    } else if (kind === 'error') {
      noteEnd(task, s.content || 'Task error.');
    } else if (kind === 'cancelled') {
      noteEnd(task, 'Task cancelled.');
    }
  }

  async function pollCore(task, thinkId) {
    if (!isCoreTask(task)) {
      if (task) {
        expireApprovals(task, EXPIRED_UNSUPERVISED);
        if (LIVE_STATUSES.indexOf(task.status) !== -1) {
          noteEnd(task, 'This saved task has no supervised core session.');
          task.status = 'Failed';
          finalizeTask(task);
        }
      }
      return;
    }
    if (task.polling) return;
    task.polling = true;
    let after = 0;
    let attempts = 0;
    let disconnected = false;
    let gone = false;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (state.tasks.indexOf(task) === -1) { task.polling = false; return; }
      let j = null;
      try {
        const r = await apiFetch('/api/agent/poll?id=' + encodeURIComponent(task.backendId) + '&after=' + after);
        if (r.status === 404) { gone = true; disconnected = true; break; }
        if (!r.ok) break;
        j = await r.json();
        if (!j || !Array.isArray(j.steps)) throw new Error('Malformed core poll response');
      } catch (_) { disconnected = true; break; }
      const arrived = (j.steps || []).length;
      after = j.total != null ? j.total : after + arrived;
      for (const s of j.steps) applyCoreStep(task, s, thinkId);
      const live = Array.isArray(j.pending) ? j.pending : [];
      // A question the loop dropped was answered in another window or timed out
      // in the loop itself; either way it is no longer ours to answer, exactly
      // as the native lane treats it (fennec-desktop/src/gui_main.rs CoreEvent::Pending).
      expireApprovals(task, EXPIRED_GONE, live);
      if (live.length) task.status = 'WaitingForApproval';
      else if (task.status === 'WaitingForApproval') task.status = 'Running';
      saveState();
      scheduleRender();
      const st = j.status;
      if (st && st !== 'running') {
        task.status = st === 'done' ? 'Complete' : st === 'cancelled' ? 'Cancelled' : 'Failed';
        finalizeTask(task);
        return;
      }
      // Blocked on the user is not slow, and neither is a run that keeps
      // talking. The budget counts silence: a complex task runs for minutes and
      // the queue it proposes arrives at the end of that, so a wall-clock cap on
      // the whole run failed the one task type it exists to serve.
      if (live.length || arrived) attempts = 0; else attempts++;
    }
    if (task.status === 'Running' || task.status === 'WaitingForApproval') {
      if (disconnected) markTaskDisconnected(task, gone ? EXPIRED_GONE : EXPIRED_DISCONNECTED);
      noteEnd(task, gone ? EXPIRED_GONE : attempts >= POLL_MAX_ATTEMPTS ? 'Response timed out.'
        : 'Lost contact with the backend while waiting for the response.');
      task.status = 'Failed';
      finalizeTask(task);
    }
    task.polling = false;
  }

  // ── Send message ───────────────────────────────────────────────────────────
  async function sendMessage(queuedText, fromDrain = false) {
    const text = (queuedText != null ? queuedText : composerInput.value).trim();
    const hasAttachments = queuedText == null && state.attachments.length > 0;
    if (!text && !hasAttachments) return false;

    const prompt = queuedText != null ? queuedText : buildPrompt(text);
    const attachments = queuedText != null ? [] : state.attachments.slice();
    const contract = await probeCapabilities();
    if (!contract || !supportsCoding()) {
      toast(codingUnavailableReason(), 'warn');
      updateSendButton();
      return false;
    }

    // If AI is working, queue the prompt (strip shows above composer). A queue
    // drain never creates a second copy if another run started while it probed.
    if (isWorking()) {
      if (fromDrain) return false;
      state.queued.push(queueEntry(prompt));
      state.queued = normalizeQueue(state.queued);
      saveState();
      renderQueue();
      updateSendButton();
      return true;
    }

    // A manual send while idle does not empty the queue. What waits there —
    // the user's own prompts, and the follow-ups an agent proposed for a run
    // that ended without draining them — goes on behind this prompt, as it does
    // in the native shell, which never clears `queued` on send. Wiping here
    // would silently throw away work the agent asked for.

    // A saved Rust conversation keeps its identity. Starting core work in a new
    // local task is the only way to avoid relabelling that history as supervised.
    const currentTask = activeTask();
    if (!currentTask || (currentTask.core !== true && (currentTask.backendId || currentTask.msgs.length > 0))) {
      const ws = activeWorkspace();
      state.activeId = state.nextId++;
      state.tasks.push({
        id: state.activeId,
        title: (text || attachments[0].name).slice(0, 80),
        status: 'Running',
        repo: ws ? ws.name : 'local',
        repoId: ws && ws.repoId ? ws.repoId : 'local',
        workspaceId: ws ? ws.id : null,
        branch: 'main',
        msgs: [],
        backendId: null,
        core: false,
        startedAt: Date.now(),
      });
    }

    const task = activeTask();
    if (!task) return;
    if (text) task.title = text.slice(0, 80);
    task.status = 'Running';
    task.finalized = false;
    task.endNoted = false;
    task.startedAt = Date.now();

    pushMsg(task, { author: 'Fennec', content: text || '(attachments)', kind: 'user', collapsed: false });

    for (const att of attachments) {
      // The card keeps what the picker read, because it is the only copy the
      // page can open: a browser hands over a name, a size and the bytes, and
      // never the file's location, so there is no path for the backend to read.
      pushMsg(task, {
        author: 'Fennec', content: 'Attached: ' + att.name, kind: 'attach', collapsed: false,
        meta: {
          title: att.name,
          size: formatFileSize(att.size),
          bytes: att.size,
          isImage: att.isImage,
          text: att.isImage || att.text == null ? null : att.text,
        },
      });
    }

    // Thinking placeholder — collapsed by default.
    const think = pushMsg(task, {
      author: 'Fennec', content: 'Connecting to engine…', kind: 'think',
      collapsed: true, meta: { stream: true, chunks: 0 },
    });

    saveState();
    renderAll();

    try {
      await startCoreTask(task, prompt);
      // Keep the composer intact until the core has accepted the run. A refused
      // or offline start therefore leaves the user's prompt and attachments put.
      if (queuedText == null && composerInput.value === text) {
        composerInput.value = '';
        state.attachments = [];
        renderAttachmentChips();
      }
      saveState();
      pollCore(task, think.id);
      return true;
    } catch (e) {
      debugLog('send failed', e);
      task.msgs = task.msgs.filter((m) => m.id !== think.id);
      const detail = e && e.message ? e.message : 'network error';
      const reachable = /^HTTP \d+$/.test(detail);
      pushMsg(task, {
        author: 'Fennec',
        content: reachable
          ? 'Fennec engine unavailable — the core is online but the inference engine is not ready. (' + detail + ')'
          : 'Could not start the supervised core run. Check fennec-core and try again; your prompt has been kept. (' + detail + ')',
        kind: 'result', collapsed: false,
      });
      task.status = 'Failed';
      state.backendConnected = reachable;
      updateBackendStatus();
      saveState();
      renderAll();
      return false;
    }
  }

  // ── Backend sync: reconcile messages / tool events / artifacts ────────────
  function syncBackend(task, bt) {
    if (!bt) return;

    // Assistant messages (bind the live-streamed result when possible).
    for (const bm of (bt.messages || [])) {
      if (bm.role === 'User') continue; // local user bubbles already exist
      const content = msgText(bm.content);
      if (!content) continue;
      if (task.msgs.some((m) => m.meta && m.meta.backendMsgId === bm.id)) continue;
      const streamMsg = task.msgs.find((m) => m.kind === 'result' && m.meta && m.meta.stream && !m.meta.backendMsgId);
      const ts = Date.parse(bm.created_at) || Date.now();
      if (streamMsg) {
        streamMsg.content = content;
        streamMsg.meta.stream = false;
        streamMsg.meta.backendMsgId = bm.id;
        streamMsg.ts = ts;
      } else {
        pushMsg(task, {
          author: bm.role || 'Fennec', content, kind: 'result', collapsed: false,
          ts, meta: { backendMsgId: bm.id },
        });
      }
    }

    // Tool events → collapsed action cards.
    for (const te of (bt.tool_events || [])) {
      const tm = toolMeta(te.kind);
      const existing = task.msgs.find((m) => m.meta && m.meta.toolId === te.id);
      const duration = formatDuration(te.duration_ms);
      const title = (te.input && (te.input.filename || te.input.path || te.input.command || te.input.url || te.input.query)) || tm.label;
      if (existing) {
        existing.meta.status = te.status;
        existing.meta.duration = duration;
        existing.content = toolContent(te);
        continue;
      }
      pushMsg(task, {
        author: te.agent_identity || 'Fennec',
        content: toolContent(te),
        kind: 'action',
        collapsed: true,
        ts: Date.parse(te.started_at) || Date.now(),
        meta: {
          toolId: te.id, toolKind: te.kind, category: tm.category,
          title: String(title).slice(0, 120), status: te.status, duration,
        },
      });
    }

    // Artifacts → edit / attach cards.
    for (const a of (bt.artifacts || [])) {
      if (task.msgs.some((m) => m.meta && m.meta.artifactId === a.id)) continue;
      const isEdit = a.kind === 'Diff' || a.status === 'Modified' || a.status === 'Added' || a.status === 'Deleted';
      const diff = a.preview && a.preview.content ? a.preview.content : null;
      let add = 0, del = 0;
      if (diff) {
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) add++;
          else if (line.startsWith('-') && !line.startsWith('---')) del++;
        }
      }
      pushMsg(task, {
        author: 'Fennec',
        content: a.filename,
        kind: isEdit ? 'edit' : 'attach',
        collapsed: false,
        ts: Date.parse(a.created_at) || Date.now(),
        meta: {
          artifactId: a.id, title: a.filename, path: a.path,
          size: formatFileSize(a.size_bytes || 0), add, del, diff,
          fromBackend: true, isImage: a.kind === 'Image',
          label: isEdit ? (a.status === 'Added' ? 'Created 1 file' : a.status === 'Deleted' ? 'Deleted 1 file' : 'Edited 1 file') : undefined,
          kindLabel: a.kind ? a.kind + ' artifact' : 'Artifact',
        },
      });
    }

    // Rust history can contain legacy approval-shaped rows, but Rust has no
    // supervised gate. Only a task started by core may turn them into questions.
    if (task.core === true) {
      if (!task.approvals) task.approvals = [];
      for (const ba of (bt.approvals || [])) {
        const resolved = !!ba.resolved;
        const decision = resolved ? (ba.resolved.choice_id || ba.resolved.decision || null) : null;
        let rec = task.approvals.find((x) => x.id === ba.id);
        if (!rec) {
          rec = {
            id: ba.id, action: ba.action || 'action', command: ba.command || null,
            reason: ba.reason || '', risk: ba.risk_level || 'medium',
            status: resolved ? 'resolved' : 'pending', decision,
          };
          task.approvals.push(rec);
        } else if (resolved && rec.status === 'pending') {
          rec.status = 'resolved';
          rec.decision = decision;
        }
        if (!task.msgs.some((m) => m.meta && m.meta.approvalId === ba.id)) {
          pushMsg(task, {
            author: 'Fennec', content: rec.command || rec.action,
            kind: 'approval', collapsed: false,
            ts: Date.parse(ba.created_at) || Date.now(),
            meta: {
              approvalId: ba.id, action: rec.action, command: rec.command,
              reason: rec.reason, risk: rec.risk, status: rec.status, decision: rec.decision,
            },
          });
        } else {
          const m = task.msgs.find((x) => x.meta && x.meta.approvalId === ba.id);
          // Never hand the buttons back. An answer this client already sent
          // outranks a backend list that has not caught up with it, and a card
          // that flipped back to pending would reappear in the run it left.
          if (m && m.meta.status === 'resolved') {
            rec.status = 'resolved';
            if (rec.decision == null) rec.decision = m.meta.decision;
          } else if (m) {
            m.meta.status = rec.status;
            m.meta.decision = rec.decision;
          }
        }
      }
    } else {
      expireApprovals(task, EXPIRED_UNSUPERVISED);
    }

    task.msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (bt.status) task.status = bt.status;
  }

  function finalizeTask(task) {
    if (task.finalized) return; // SSE + polling may both observe completion
    task.finalized = true;
    // Drop the "Connecting…" placeholder if no reasoning ever arrived.
    task.msgs = task.msgs.filter((m) => !(m.kind === 'think' && m.meta && m.meta.stream && (m.meta.chunks || 0) === 0));
    for (const m of task.msgs) {
      if (m.meta && m.meta.stream) m.meta.stream = false;
    }
    // A run that ended without an answer leaves its approvals expired, not
    // pending forever in My Attention.
    expireApprovals(task, EXPIRED_ENDED);
    task.polling = false;
    saveState();
    renderAll();
    if (settings.notifications && 'Notification' in window && Notification.permission === 'granted' && task.status === 'Complete') {
      try { new Notification('Fennec task complete', { body: task.title }); } catch (_) {}
    }
    // The queue drains whenever a run stops, not only when it answers. A
    // cancelled or failed run left its follow-ups parked at "Next" with nothing
    // ever picking them up, which is what made the strip read as a stack that
    // never moves; the native shell drains on any non-running status, and
    // `drainQueue` refuses to start anything while another run is going.
    drainQueue();
  }

  async function pollTask(task, thinkId) {
    if (!task || task.core === true || state.backendKind !== 'rust' || !task.backendId) return;
    if (task.polling) return;
    task.polling = true;
    let attempts = 0;
    let sawMsgs = -1;
    let disconnected = false;
    let gone = false;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (state.tasks.indexOf(task) === -1) { task.polling = false; return; } // deleted
      if (task.status !== 'Running' && task.status !== 'Planning' && task.status !== 'WaitingForApproval') { task.polling = false; return; } // stopped elsewhere
      let bt = null;
      try {
        const pollResp = await apiFetch('/api/tasks/' + encodeURIComponent(task.backendId));
        if (pollResp.status === 404) { gone = true; disconnected = true; break; }
        if (!pollResp.ok) break;
        bt = await pollResp.json();
        if (!bt || typeof bt !== 'object') throw new Error('Malformed Rust task response');
      } catch (_) { disconnected = true; break; }

      syncBackend(task, bt);
      saveState();
      scheduleRender();

      if (bt.status === 'Complete' || bt.status === 'Failed' || bt.status === 'Cancelled' || bt.status === 'Warning' || bt.status === 'NeedsAttention') {
        if (thinkId) task.msgs = task.msgs.filter((m) => m.id !== thinkId || (m.meta && (m.meta.chunks || 0) > 0));
        finalizeTask(task);
        return;
      }
      // A run blocked on the user is not slow, and neither is one still
      // delivering messages: like `pollCore`, the budget counts silence.
      const reached = (bt.messages || []).length;
      if (bt.status === 'WaitingForApproval' || reached > sawMsgs) attempts = 0;
      else attempts++;
      sawMsgs = reached;
    }

    // Timed out or backend unreachable.
    if (LIVE_STATUSES.indexOf(task.status) !== -1) {
      if (disconnected) markTaskDisconnected(task, gone ? EXPIRED_GONE : EXPIRED_DISCONNECTED);
      if (thinkId) task.msgs = task.msgs.filter((m) => m.id !== thinkId);
      noteEnd(task, gone ? EXPIRED_GONE : attempts >= POLL_MAX_ATTEMPTS
        ? 'Response timed out.'
        : 'Lost contact with the backend while waiting for the response.');
      task.status = 'Failed';
      finalizeTask(task);
    }
    task.polling = false;
  }

  async function stopTask() {
    const task = activeTask();
    if (!task || !isWorking()) return;
    // The status goes away before the request does: the send button doubles as
    // Stop while a run is live, and a second click used to pass `isWorking()`
    // again and write a second stop card for the same ending.
    task.status = 'Cancelled';
    task.msgs = task.msgs.filter((m) => !(m.kind === 'think' && m.meta && m.meta.stream && (m.meta.chunks || 0) === 0));
    noteEnd(task, 'Task stopped by user.');
    if (isCoreTask(task)) {
      try {
        const response = await apiFetch('/api/agent/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: task.backendId }),
        });
        if (response.status === 404) markTaskDisconnected(task, EXPIRED_GONE);
      } catch (_) { markTaskDisconnected(task, EXPIRED_DISCONNECTED); }
    } else {
      // Saved Rust chats have no supervised cancel endpoint. Stop their local
      // polling without inventing a core session or posting a task mutation.
      expireApprovals(task, EXPIRED_UNSUPERVISED);
    }
    finalizeTask(task);
    toast('Task stopped.', 'info');
  }

  // ── SSE live events (/api/events) ──────────────────────────────────────────
  let eventSource = null;

  function connectEvents() {
    if (!backendSupports('events-sse')) {
      if (eventSource) { eventSource.close(); eventSource = null; }
      return;
    }
    if (eventSource) return;
    if (!('EventSource' in window)) return;
    try {
      eventSource = new EventSource(apiBase + '/api/events');
    } catch (_) { return; }
    eventSource.onmessage = (e) => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch (_) { return; }
      handleEvent(ev);
    };
    eventSource.onerror = () => { debugLog('SSE connection error (will retry)'); };
  }

  function taskForEvent(ev) {
    if (!ev || !ev.task_id) return null;
    return state.tasks.find((t) => t.backendId === ev.task_id) || null;
  }

  function handleEvent(ev) {
    debugLog('event', ev.event_type, ev);
    const task = taskForEvent(ev);
    const payload = ev.payload || {};

    switch (ev.event_type) {
      case 'MessageStreamed': {
        if (!task) return;
        const kind = payload.kind;
        const text = payload.text || '';
        if (!text) return;
        if (kind === 'reasoning') {
          let think = task.msgs.slice().reverse().find((m) => m.kind === 'think' && m.meta && m.meta.stream);
          if (!think) {
            think = pushMsg(task, { author: 'Fennec', content: '', kind: 'think', collapsed: true, meta: { stream: true, chunks: 0 } });
          }
          if (think.content === 'Connecting to engine…') think.content = '';
          think.content += text;
          think.meta.chunks = (think.meta.chunks || 0) + 1;
        } else if (kind === 'content') {
          let res = task.msgs.slice().reverse().find((m) => m.kind === 'result' && m.meta && m.meta.stream);
          if (!res) {
            res = pushMsg(task, { author: 'Fennec', content: '', kind: 'result', collapsed: false, meta: { stream: true } });
          }
          res.content += text;
        }
        scheduleRender();
        break;
      }

      case 'TaskStatusChanged': {
        if (!task) return;
        const s = String(ev.status || '').toLowerCase();
        if (s === 'complete' || s === 'cancelled' || s === 'failed') {
          if (task.status === 'Running' || task.status === 'Planning') {
            if (task.core === true) {
              task.status = s === 'complete' ? 'Complete' : s === 'cancelled' ? 'Cancelled' : 'Failed';
              finalizeTask(task);
              break;
            }
            apiFetch('/api/tasks/' + encodeURIComponent(task.backendId))
              .then((r) => (r.ok ? r.json() : null))
              .then((bt) => {
                if (bt) syncBackend(task, bt);
                else task.status = s === 'complete' ? 'Complete' : s === 'cancelled' ? 'Cancelled' : 'Failed';
                if (task.status === 'Running' || task.status === 'Planning') {
                  task.status = s === 'complete' ? 'Complete' : s === 'cancelled' ? 'Cancelled' : 'Failed';
                }
                finalizeTask(task);
              })
              .catch(() => {
                task.status = s === 'complete' ? 'Complete' : s === 'cancelled' ? 'Cancelled' : 'Failed';
                finalizeTask(task);
              });
          }
        }
        break;
      }

      case 'ToolStarted':
      case 'ToolProgressUpdated':
      case 'ToolCompleted':
      case 'ToolFailed': {
        if (!task) return;
        const te = payload.tool_event || payload.tool || payload;
        const id = te.id || te.tool_id || ev.event_id;
        const kind = te.kind || te.tool_kind || 'Action';
        const tm = toolMeta(kind);
        const status = ev.event_type === 'ToolFailed' ? 'Failed'
          : ev.event_type === 'ToolCompleted' ? 'Complete'
          : te.status || 'Running';
        const title = (te.input && (te.input.filename || te.input.path || te.input.command || te.input.url || te.input.query)) || tm.label;
        const existing = task.msgs.find((m) => m.meta && m.meta.toolId === id);
        if (existing) {
          existing.meta.status = status;
          existing.meta.duration = formatDuration(te.duration_ms);
          if (te.output || te.error) existing.content = toolContent(te);
        } else {
          pushMsg(task, {
            author: ev.agent_identity || 'Fennec',
            content: toolContent(te),
            kind: 'action', collapsed: true,
            meta: {
              toolId: id, toolKind: kind, category: tm.category,
              title: String(title).slice(0, 120), status,
              duration: formatDuration(te.duration_ms),
            },
          });
        }
        saveState();
        scheduleRender();
        break;
      }

      case 'ArtifactCreated':
      case 'ArtifactUpdated': {
        if (!task) return;
        const a = payload.artifact || payload;
        const id = a.id || ev.event_id;
        if (task.msgs.some((m) => m.meta && m.meta.artifactId === id)) return;
        const isEdit = a.kind === 'Diff' || a.status === 'Modified' || a.status === 'Added';
        pushMsg(task, {
          author: 'Fennec', content: a.filename || 'artifact',
          kind: isEdit ? 'edit' : 'attach', collapsed: false,
          meta: {
            artifactId: id, title: a.filename || 'artifact', path: a.path || '',
            size: formatFileSize(a.size_bytes || 0), fromBackend: true,
            isImage: a.kind === 'Image',
            diff: a.preview && a.preview.content ? a.preview.content : null,
            kindLabel: (a.kind || 'Task') + ' artifact',
          },
        });
        saveState();
        scheduleRender();
        break;
      }

      case 'AgentDelegated': {
        if (!task) return;
        pushMsg(task, {
          author: 'Fennec',
          content: 'Scope: ' + (payload.scope || '—') + '\n\n' + (payload.instructions || ''),
          kind: 'action', collapsed: true,
          meta: {
            toolId: ev.event_id, toolKind: 'Delegate', category: 'delegate',
            title: 'Delegated → ' + (ev.agent_identity || 'subagent'), status: 'Complete',
          },
        });
        saveState();
        scheduleRender();
        break;
      }

      case 'ApprovalRequested': {
        if (!isCoreTask(task)) return;
        const a = payload.approval || payload;
        const id = a.approval_id || a.id || ev.event_id;
        if (!task.approvals) task.approvals = [];
        if (task.approvals.some((x) => x.id === id)) break;
        const args = a.args || {};
        const record = {
          id,
          action: a.action || a.name || 'action',
          // The loop's own words, so a gate reported over the event stream reads
          // the same as one read off a poll step.
          command: a.command || describeCall(a.action || a.name, args).title || null,
          reason: a.reason || '',
          risk: a.risk_level || a.risk || 'medium',
          status: 'pending',
          decision: null,
        };
        task.approvals.push(record);
        task.status = 'WaitingForApproval';
        pushMsg(task, {
          author: ev.agent_identity || 'Fennec',
          content: record.command || record.action,
          kind: 'approval', collapsed: false,
          meta: {
            approvalId: id, action: record.action, command: record.command,
            reason: record.reason, risk: record.risk, status: 'pending', decision: null,
          },
        });
        saveState();
        scheduleRender();
        break;
      }

      case 'BackendDisconnected': {
        if (task) markTaskDisconnected(task, EXPIRED_DISCONNECTED);
        else {
          state.backendConnected = false;
          updateBackendStatus();
        }
        if (ev.error) toast(ev.error, 'warn');
        break;
      }

      case 'BackendReconnected': {
        state.backendConnected = true;
        updateBackendStatus();
        break;
      }

      default:
        break;
    }
  }

  // ── Nav handlers ───────────────────────────────────────────────────────────
  // The rail carries only the two filter toggles the native shell has; new
  // tasks come from a workspace row's + or the composer, as they do there.
  function handleNav(nav) {
    switch (nav) {
      case 'attention': {
        state.attentionOnly = !state.attentionOnly;
        renderAll();
        break;
      }
      case 'search': {
        taskSearch.hidden = !taskSearch.hidden;
        document.querySelector('[data-nav="search"]').classList.toggle('active', !taskSearch.hidden);
        if (!taskSearch.hidden) {
          taskSearch.focus();
        } else {
          state.searchQuery = '';
          taskSearch.value = '';
          renderTaskList();
        }
        break;
      }
    }
  }

  // ── Inspector toggle ───────────────────────────────────────────────────────
  function applyInspectorState() {
    rightPanel.classList.toggle('collapsed', !state.inspectorOpen);
    appLayout.classList.toggle('inspector-closed', !state.inspectorOpen);
    const t = $('inspector-toggle');
    if (t) {
      t.setAttribute('aria-pressed', String(state.inspectorOpen));
      const label = state.inspectorOpen ? 'Hide context panel' : 'Show context panel';
      t.setAttribute('aria-label', label);
      t.setAttribute('title', label);
    }
  }

  function toggleInspector() {
    state.inspectorOpen = !state.inspectorOpen;
    localStorage.setItem('fennec-inspector-open', String(state.inspectorOpen));
    applyInspectorState();
  }

  // ── Inspector tabs: Overview / Files / Browser ─────────────────────────────
  // The panel was one column of run context. Files and Browser each want the
  // whole column — one browses the same workspace jail the run works in, the
  // other reads a web page as plain text — so context became a tab instead of
  // a fourth section nobody scrolls to. The opened tab is kept across reloads.
  const INSP_TABS = ['overview', 'files', 'browser'];
  let inspTab = 'overview';
  function setInspTab(name) {
    inspTab = INSP_TABS.includes(name) ? name : 'overview';
    localStorage.setItem('fennec-insp-tab', inspTab);
    INSP_TABS.forEach((tab) => {
      const btn = $('insp-tab-' + tab);
      const view = $('insp-view-' + tab);
      if (btn) {
        btn.classList.toggle('active', tab === inspTab);
        btn.setAttribute('aria-selected', String(tab === inspTab));
        btn.tabIndex = tab === inspTab ? 0 : -1;
      }
      if (view) view.hidden = tab !== inspTab;
    });
    if (inspTab === 'files' && !fmState.loaded) loadFmDir(fmState.path);
  }

  // ── Files: the workspace, through the same jail the run sees ───────────────
  const fmState = { path: '.', root: '', loaded: false };
  let fmSeq = 0;

  function fmNote(text) {
    const note = $('fm-note');
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
  }

  // '.' (no workspace chosen) means the server's own default root, which is
  // what an empty `workspace` parameter asks for; naming it would double-encode
  // a folder the jail already resolves to.
  function fmWorkspaceParam() {
    const ws = runFolder();
    return ws && ws !== '.' ? '&workspace=' + encodeURIComponent(ws) : '';
  }

  async function loadFmDir(path) {
    const list = $('fm-list');
    if (!list) return;
    if (!supportsWorkControls()) {
      fmNote('The Files panel is available only with the Rust coding-agent backend.');
      return;
    }
    const seq = ++fmSeq;
    fmState.path = path || '.';
    fmState.loaded = true;
    const pathEl = $('fm-path');
    if (pathEl) {
      pathEl.textContent = fmState.path;
      pathEl.title = fmState.root || '';
    }
    fmNote('reading…');
    list.textContent = '';
    let data = null;
    let error = '';
    try {
      const r = await apiFetch('/api/work/files?path=' + encodeURIComponent(fmState.path) + fmWorkspaceParam());
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) data = j;
      else error = (j && j.error) || ('HTTP ' + r.status);
    } catch (e) {
      error = e && e.message ? String(e.message) : String(e);
    }
    if (seq !== fmSeq) return;
    if (!data) {
      fmNote('Could not list this folder: ' + error);
      return;
    }
    fmState.root = data.root || '';
    if (pathEl) pathEl.title = fmState.root;
    const entries = (Array.isArray(data.entries) ? data.entries.slice() : [])
      .sort((a, b) => (Number(!!b.is_dir) - Number(!!a.is_dir)) || String(a.name).localeCompare(String(b.name)));
    fmNote(entries.length ? '' : 'This folder is empty.');
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'fm-row' + (entry.is_dir ? ' fm-dir' : '');
      row.innerHTML = '<span class="fm-row-icon">' + iconSvg(entry.is_dir ? 'workspace' : 'file') + '</span>'
        + '<span class="fm-row-name mono">' + escapeHtml(entry.name) + '</span>'
        + (entry.is_dir ? '' : '<span class="fm-row-size">' + escapeHtml(formatFileSize(Number(entry.size) || 0)) + '</span>');
      row.addEventListener('click', () => {
        const base = fmState.path === '.' ? '' : fmState.path.replace(/\/+$/, '');
        const child = (base ? base + '/' : '') + entry.name;
        if (entry.is_dir) loadFmDir(child);
        else openFmFile(child, entry.name);
      });
      list.appendChild(row);
    }
  }

  function fmUp() {
    if (fmState.path === '.' || !fmState.path) return;
    const parent = fmState.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    loadFmDir(parent || '.');
  }

  // A listed file opens in the same viewer a delivered card uses — one dialog,
  // one race guard — but reads through the Rust jail route, not the core one.
  async function openFmFile(path, name) {
    if (!supportsWorkControls()) {
      toast('The Files panel is available only with the Rust coding-agent backend.', 'warn');
      return;
    }
    const seq = ++fileViewSeq;
    const dialog = $('file-viewer-dialog');
    if (!dialog) return;
    $('file-viewer-title').textContent = name;
    const pathEl = $('file-viewer-path');
    pathEl.textContent = joinPath(fmState.root, path);
    pathEl.hidden = !fmState.root;
    $('file-viewer-meta').textContent = 'reading…';
    $('file-viewer-body').textContent = '';
    setViewerKind('text');
    if (!dialog.open) dialog.showModal();
    let data = null;
    let error = '';
    try {
      const r = await apiFetch('/api/work/file?path=' + encodeURIComponent(path) + fmWorkspaceParam());
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) data = j;
      else error = (j && j.error) || ('The backend refused ' + path + ' (HTTP ' + r.status + ').');
    } catch (e) {
      error = 'Could not reach the backend: ' + (e && e.message ? e.message : e);
    }
    if (seq !== fileViewSeq) return;
    if (!data) {
      $('file-viewer-meta').textContent = error;
      return;
    }
    // The route answers an image with its bytes, not with lossy text: painting a
    // PNG as a `<pre>` is what showed a wall of replacement characters here.
    if (data.kind === 'image') {
      setViewerKind('image', name);
      $('file-viewer-image').src = 'data:' + data.mime + ';base64,' + (data.data || '');
      $('file-viewer-meta').textContent = data.mime + ' · '
        + formatFileSize(Number(data.bytes) || 0);
      return;
    }
    setViewerKind('text');
    const text = String(data.content || '');
    const n = typeof data.lines === 'number' ? data.lines : viewLines(text);
    const bytes = typeof data.bytes === 'number' ? data.bytes : new TextEncoder().encode(text).length;
    $('file-viewer-meta').textContent = (n != null ? n + (n === 1 ? ' line' : ' lines') + ' · ' : '')
      + formatFileSize(bytes);
    $('file-viewer-body').textContent = text;
  }

  // ── Browser: read a page graphically, no webview ───────────────────────────
  // The Rust server fetches the address and serves the markup to the frame
  // below, sandboxed to an opaque origin so the page's scripts cannot reach
  // the app. Its injected router posts link and form targets back here, and
  // they re-read through the same route — browsing stays inside the pane, and
  // every hop is one the user, a link they clicked, or a form the page
  // submitted named. The last of those is bounded; see brAuto.
  const brHist = [];

  // A page can drive the pane on its own: a form it submits at boot, or a
  // `location` it writes, asks for another read of a real site each time.
  // Measured on a Google results page, whose script submits a logging form as
  // it boots: nine reads in nine seconds, none of them asked for. Two in a row
  // is a page that redirects; the third is a loop, and the pane says so
  // instead of going on hammering the site.
  const brAutoMax = 3;
  let brAsked = true;
  let brAuto = 0;

  function brStopAuto(url) {
    const frame = $('browser-frame');
    const metaEl = $('browser-meta');
    brAuto = 0;
    brAsked = true;
    if (frame) frame.src = 'about:blank';
    if (url) $('browser-url').value = url;
    metaEl.textContent = 'This page kept navigating on its own, so the pane stopped it.';
    metaEl.hidden = false;
  }

  function brNavigate(rawUrl, push = true, auto = false) {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    if (!supportsWorkControls()) {
      const metaEl = $('browser-meta');
      if (metaEl) {
        metaEl.textContent = 'The Browser panel is available only with the Rust coding-agent backend.';
        metaEl.hidden = false;
      }
      return;
    }
    const frame = $('browser-frame');
    if (!frame) return;
    const titleEl = $('browser-title');
    const metaEl = $('browser-meta');
    brAuto = auto ? brAuto + 1 : 0;
    if (brAuto >= brAutoMax) {
      brStopAuto(url);
      return;
    }
    brAsked = true;
    if (push && brHist[brHist.length - 1] !== url) brHist.push(url);
    const input = $('browser-url');
    if (input && document.activeElement !== input) input.value = url;
    titleEl.textContent = '';
    titleEl.hidden = true;
    metaEl.textContent = 'reading…';
    metaEl.hidden = false;
    frame.hidden = false;
    frame.src = '/browse/doc?u=' + encodeURIComponent(url);
  }

  function brBack() {
    if (brHist.length > 1) brHist.pop();
    const prev = brHist[brHist.length - 1];
    if (prev) brNavigate(prev, false);
  }

  function initBrowserFrame() {
    window.addEventListener('message', (event) => {
      const frame = $('browser-frame');
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data || {};
      const metaEl = $('browser-meta');
      if (data.fennecBrowseGo) {
        const target = String(data.fennecBrowseGo);
        if (/^https?:/i.test(target)) brNavigate(target, true, !!data.fennecBrowseAuto);
        return;
      }
      if (data.fennecBrowseErr) {
        metaEl.textContent = String(data.fennecBrowseErr);
        return;
      }
      const read = data.fennecBrowseRead;
      if (!read) return;
      // A read the pane never asked for is the frame navigating itself, which
      // is the other half of the same loop and counts toward it.
      if (!brAsked) {
        brAuto += 1;
        if (brAuto >= brAutoMax) {
          brStopAuto('');
          return;
        }
      }
      brAsked = false;
      const titleEl = $('browser-title');
      if (read.e) {
        metaEl.textContent = String(read.e);
        return;
      }
      titleEl.textContent = read.title || '';
      titleEl.hidden = !read.title;
      metaEl.textContent = read.status + ' · ' + read.url + (read.truncated ? ' · truncated' : '');
    });
  }

  function initInspectorTabs() {
    INSP_TABS.forEach((tab) => {
      const btn = $('insp-tab-' + tab);
      if (btn) btn.addEventListener('click', () => setInspTab(tab));
    });
    const tabs = document.querySelector('.insp-tabs');
    if (tabs) {
      tabs.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const i = INSP_TABS.indexOf(inspTab);
        const step = event.key === 'ArrowRight' ? 1 : INSP_TABS.length - 1;
        const next = INSP_TABS[(i + step) % INSP_TABS.length];
        setInspTab(next);
        const btn = $('insp-tab-' + next);
        if (btn) btn.focus();
        event.preventDefault();
      });
    }
    const up = $('fm-up');
    if (up) up.addEventListener('click', fmUp);
    const refresh = $('fm-refresh');
    if (refresh) refresh.addEventListener('click', () => loadFmDir(fmState.path));
    const form = $('browser-form');
    if (form) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        brNavigate($('browser-url').value);
      });
    }
    const back = $('br-back');
    if (back) back.addEventListener('click', brBack);
    initBrowserFrame();
    setInspTab(readSetting('fennec-insp-tab', 'overview'));
  }

  // ── Backend capabilities ───────────────────────────────────────────────────
  function gateControl(control, enabled, reason) {
    if (!control) return;
    if (control.dataset.capabilityTitle === undefined) {
      control.dataset.capabilityTitle = control.title || '';
    }
    control.disabled = !enabled;
    control.title = enabled ? control.dataset.capabilityTitle : reason;
  }

  function applyCapabilityGates() {
    const rustReason = 'Available only with the Rust coding-agent backend.';
    const codingReason = 'Available only when fennec-core advertises all coding capabilities.';
    const repositoryAvailable = supportsRepositoryControls();
    const githubAvailable = supportsGithubControls();
    const obsidianAvailable = supportsObsidianControls();
    const workAvailable = supportsWorkControls();
    const codingAvailable = supportsCoding();

    const workingIn = $('working-in');
    if (workingIn) workingIn.hidden = !repositoryAvailable;
    for (const id of ['change-repository', 'connect-repository', 'repository-create-name',
      'repository-create-inline', 'repository-create']) {
      gateControl($(id), repositoryAvailable, rustReason);
    }
    for (const id of ['github-account-button', 'github-refresh']) {
      gateControl($(id), githubAvailable, rustReason);
    }
    for (const id of ['obsidian-account-button', 'obsidian-refresh', 'obsidian-note-title',
      'obsidian-note-folder', 'obsidian-note-content', 'obsidian-note-overwrite', 'obsidian-write']) {
      gateControl($(id), obsidianAvailable, rustReason);
    }
    for (const tab of document.querySelectorAll('.settings-tab')) {
      const name = tab.dataset.tab;
      if (name === 'github') gateControl(tab, githubAvailable, rustReason);
      if (name === 'obsidian') gateControl(tab, obsidianAvailable, rustReason);
    }

    for (const id of ['insp-tab-files', 'insp-tab-browser', 'fm-up', 'fm-refresh',
      'browser-url', 'browser-go', 'br-back']) {
      gateControl($(id), workAvailable, rustReason);
    }
    gateControl($('browser-form'), workAvailable, rustReason);
    if (!workAvailable && inspTab !== 'overview') setInspTab('overview');

    gateControl($('permission-trigger'), codingAvailable, codingReason);
    if (!codingAvailable && permDropdown) permDropdown.hidden = true;
    document.querySelectorAll('.permission-option').forEach((option) => {
      gateControl(option, codingAvailable, codingReason);
    });
    updateSendButton();
  }

  function updateBackendStatus() {
    statusDot.setAttribute('data-state', state.backendConnected ? 'online' : 'error');
    backendStatus.textContent = state.backendConnected ? 'Backend connected' : 'Disconnected';
    renderRightPanel();
  }

  function resumeInterruptedTasks() {
    for (const task of state.tasks) {
      if (LIVE_STATUSES.indexOf(task.status) === -1 || task.polling) continue;
      if (isCoreTask(task) && state.backendKind === 'core' && supportsCoding()) {
        pollCore(task);
      } else if (task.core !== true && state.backendKind === 'rust' && task.backendId) {
        pollTask(task);
      } else {
        const note = state.backendKind === 'unknown' ? EXPIRED_DISCONNECTED
          : task.core === true ? 'this saved core run cannot be resumed by the Rust backend'
            : 'this saved Rust chat cannot be resumed by fennec-core';
        expireApprovals(task, note);
        task.msgs = task.msgs.filter((m) => !(m.kind === 'think' && m.meta && m.meta.stream));
        noteEnd(task, task.backendId ? note : 'Task interrupted by page reload.');
        task.status = 'Failed';
        finalizeTask(task);
      }
    }
  }

  async function checkHealth() {
    await probeCapabilities();
    // Both backends can answer the outlet probe. Unsupported or missing
    // capabilities never turn a failed request into an assumed Rust backend.
    state.outlets = state.backendConnected ? await loadOutlets() : outletLines(null);
    updateBackendStatus();
    if (state.backendConnected) {
      if (supportsRepositoryControls()) syncBackendRepositories();
      if (supportsGithubControls()) syncWorkspaceRepositories();
    }
    resumeInterruptedTasks();
    if (supportsCoding()) drainQueue();
    connectEvents();
  }

  // ── Models ─────────────────────────────────────────────────────────────────
  function modelDisplayName(id) {
    const m = models.find((x) => x.id === id);
    if (m) return m.name;
    const fb = FALLBACK_MODELS.find((x) => x.id === id);
    return fb ? fb.name : id;
  }

  async function loadModels() {
    let served = null;
    try {
      const resp = await apiFetch('/api/models');
      if (resp.ok) {
        const data = await resp.json();
        const list = Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : null;
        if (list && list.length > 0) {
          served = list.map((m) => typeof m === 'string'
            ? { id: m, name: m }
            : { id: m.id || m.name, name: m.name || m.display_name || m.id });
          // The checkpoint the engine proved leads the menu, then the models the
          // suite can load — the same rows the native dropdown renders.
          models = served.concat(FALLBACK_MODELS.filter((f) => !served.some((s) => s.id === f.id)));
        }
      }
    } catch (_) { /* endpoint absent — keep fallback list */ }
    // The engine holds one checkpoint and answers every request as it, so a
    // stored choice it isn't serving would name a model nothing replies for.
    // Only the served ids settle the choice; the rest of the menu stays offered.
    if (served && !served.some((m) => m.id === currentModel)) currentModel = served[0].id;
    if (!models.some((m) => m.id === currentModel)) {
      models.unshift({ id: currentModel, name: currentModel });
    }
    renderModelDropdown();
  }

  function renderModelDropdown() {
    const dd = $('model-dropdown');
    const label = $('model-trigger-label');
    if (label) label.textContent = modelDisplayName(currentModel);
    if (!dd) return;
    dd.innerHTML = '';
    for (const m of models) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-option' + (m.id === currentModel ? ' active' : '');
      btn.innerHTML = `<span class="model-option-name">${escapeHtml(m.name)}</span><span class="model-option-check">✓</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentModel = m.id;
        localStorage.setItem('fennec-model', currentModel);
        dd.hidden = true;
        $('model-trigger').setAttribute('aria-expanded', 'false');
        renderModelDropdown();
        toast('Model set to ' + m.name + '.', 'good');
      });
      dd.appendChild(btn);
    }
    const sep = document.createElement('div');
    sep.className = 'model-dropdown-sep';
    dd.appendChild(sep);
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'model-option model-download';
    dl.disabled = true;
    dl.title = 'Model downloads are not available yet';
    dl.innerHTML = iconSvg('download', 'ui-icon model-download-icon') + '<span class="model-option-name muted">Download new model…</span>';
    dd.appendChild(dl);
    const sep2 = document.createElement('div');
    sep2.className = 'model-dropdown-sep';
    dd.appendChild(sep2);
    const head = document.createElement('div');
    head.className = 'model-dropdown-label';
    head.textContent = 'Reasoning';
    dd.appendChild(head);
    for (const level of EFFORT_LEVELS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-option' + (level.id === currentEffort ? ' active' : '');
      btn.innerHTML = `<span class="model-option-name">${escapeHtml(level.name)}</span><span class="model-option-check">✓</span>`;
      gateControl(btn, supportsCoding(), 'Reasoning levels require the supervised fennec-core backend.');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentEffort = level.id;
        localStorage.setItem('fennec-effort', currentEffort);
        dd.hidden = true;
        $('model-trigger').setAttribute('aria-expanded', 'false');
        renderModelDropdown();
        toast('Reasoning set to ' + level.name.toLowerCase() + '.', 'good');
      });
      dd.appendChild(btn);
    }
  }

  // ── Permission mode ────────────────────────────────────────────────────────
  function setPermissionMode(mode) {
    if (!PERM_MODES[mode]) mode = 'ask';
    permissionMode = mode;
    const meta = PERM_MODES[mode];
    const trigger = $('permission-trigger');
    trigger.classList.remove('perm-ask', 'perm-auto', 'perm-full');
    trigger.classList.add(meta.colorClass);
    $('permission-trigger-icon').textContent = meta.icon;
    $('permission-trigger-label').textContent = meta.label;
    document.querySelectorAll('.permission-option').forEach((opt) => {
      opt.classList.toggle('active', opt.dataset.mode === mode);
    });
    localStorage.setItem('fennec-permission-mode', mode);
    localStorage.setItem('fennec-permission-flags', JSON.stringify(meta.flags));
  }

  function closeDropdowns() {
    closeChipMenu();
    const pd = $('permission-dropdown');
    const md = $('model-dropdown');
    if (pd) pd.hidden = true;
    if (md) md.hidden = true;
    $('permission-trigger').setAttribute('aria-expanded', 'false');
    $('model-trigger').setAttribute('aria-expanded', 'false');
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────
  let workspaces = [];
  try { workspaces = JSON.parse(localStorage.getItem('fennec-workspaces') || '[]'); } catch (_) { workspaces = []; }
  let activeWorkspaceId = localStorage.getItem('fennec-active-workspace') || null;

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    workspaces = [{ id: 'default', name: 'Default', icon: 'workspace' }];
    activeWorkspaceId = 'default';
  }
  if (!workspaces.some((w) => w.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id;

  function activeWorkspace() {
    return workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0] || null;
  }

  function createTaskInWorkspace(workspaceId) {
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;
    activeWorkspaceId = ws.id;
    const id = state.nextId++;
    state.tasks.push({
      id,
      title: 'New task',
      status: 'Idle',
      repo: ws.name,
      repoId: ws.repoId || 'local',
      workspaceId: ws.id,
      branch: 'main',
      msgs: [],
      backendId: null,
      core: false,
      startedAt: null,
    });
    state.activeId = id;
    state.queued = [];
    state.attentionOnly = false;
    saveState();
    saveWorkspaces();
    renderAll();
    composerInput.focus();
  }

  function saveWorkspaces() {
    localStorage.setItem('fennec-workspaces', JSON.stringify(workspaces));
    localStorage.setItem('fennec-active-workspace', activeWorkspaceId || '');
    renderWorkspaces();
    updateWorkspaceDisplay();
  }

  // ── Pane resize (left rail + inspector) ──────────────────────────────────
  // The width lives as an inline CSS custom property on .app-layout, which is
  // how a dragged value outranks each media step's default. The narrow tiers
  // re-declare smaller defaults but keep both handles live; below 700px only
  // the rail's goes, because the rail itself is hidden there.
  function paneLimits(pane) {
    // No pane may eat more than 40% of the window; the timeline has to live.
    const cap = Math.floor(window.innerWidth * 0.4);
    return pane === 'rail' ? [180, Math.min(440, cap)] : [220, Math.min(560, cap)];
  }

  function initPaneResize() {
    const layout = $('app-layout');
    if (!layout) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('fennec-pane-widths') || '{}'); } catch (_) { saved = {}; }
    const varName = (pane) => pane === 'rail' ? '--rail-w' : '--insp-w';
    const panelOf = (pane) => layout.querySelector(pane === 'rail' ? '.left-panel' : '.right-panel');
    const widthOf = (pane) => panelOf(pane).getBoundingClientRect().width;
    const apply = (pane, w) => layout.style.setProperty(varName(pane), w + 'px');
    const persist = () => localStorage.setItem('fennec-pane-widths', JSON.stringify(saved));
    for (const pane of ['rail', 'insp']) {
      const handle = layout.querySelector('.pane-resizer[data-pane=' + pane + ']');
      if (!handle) continue;
      if (Number.isFinite(saved[pane])) {
        const [lo, hi] = paneLimits(pane);
        apply(pane, Math.min(hi, Math.max(lo, saved[pane])));
      }
      handle.setAttribute('aria-valuenow', String(Math.round(widthOf(pane))));
      const setWidth = (w) => {
        const [lo, hi] = paneLimits(pane);
        const clamped = Math.round(Math.min(hi, Math.max(lo, w)));
        apply(pane, clamped);
        handle.setAttribute('aria-valuenow', String(clamped));
        return clamped;
      };
      handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        const from = e.clientX;
        const startW = widthOf(pane);
        handle.classList.add('dragging');
        const move = (ev) => {
          const dx = ev.clientX - from;
          // The rail grows rightward, the inspector grows leftward.
          setWidth(startW + (pane === 'rail' ? dx : -dx));
        };
        const up = () => {
          handle.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          saved[pane] = Math.round(widthOf(pane));
          persist();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      // Double-click hands the pane back its default width.
      handle.addEventListener('dblclick', () => {
        delete saved[pane];
        layout.style.removeProperty(varName(pane));
        persist();
        handle.setAttribute('aria-valuenow', String(Math.round(widthOf(pane))));
      });
      handle.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const dir = (pane === 'rail') === (e.key === 'ArrowRight') ? 12 : -12;
        e.preventDefault();
        saved[pane] = setWidth(widthOf(pane) + dir);
        persist();
      });
    }
  }

  function updateWorkspaceDisplay() {
    const ws = activeWorkspace();
    const nameEl = $('workspace-name');
    const repoEl = $('repository-name');
    const branchEl = $('branch-name');
    const boundEl = $('repository-bound');
    const unboundEl = $('repository-unbound');
    // Mirrors fennec-ui::repository::working_in_banner: the panel always shows,
    // and unbound it offers the connect action that opens the same picker.
    const bound = !!(ws && ws.githubRepo);
    if (boundEl) boundEl.hidden = !bound;
    if (unboundEl) unboundEl.hidden = bound;
    if (nameEl && ws) nameEl.textContent = ws.name;
    if (repoEl) repoEl.textContent = bound ? ws.githubRepo : '';
    if (bound && branchEl) branchEl.textContent = ws.branch || 'main';
    const task = activeTask();
    if (timelineRepo) timelineRepo.textContent = ((task && task.repo) || (ws ? ws.name : 'local')) + ' · main';
  }

  // ── My Attention: pending approvals + answered commands ───────────────────
  function taskNeedsAttention(t) {
    return t.status === 'WaitingForApproval' || t.status === 'AwaitingApproval' || t.status === 'NeedsAttention' ||
      (t.approvals || []).some((a) => a.status === 'pending');
  }

  function approvedCommands() {
    const out = [];
    for (const t of state.tasks) {
      for (const a of (t.approvals || [])) {
        if (a.status === 'resolved') out.push({ task: t, approval: a });
      }
    }
    return out;
  }

  // The four answers the core loop accepts (loop.py:_APPROVAL_OPTIONS),
  // worded as the desktop shells word them (fennec-ui/src/attention.rs) so the
  // same answer reads the same on every surface.
  const APPROVAL_DECISIONS = [
    ['allow_once', 'Allow once'],
    ['allow_always', 'Allow every time'],
    ['reject_once', 'Reject'],
    ['reject_always', 'Reject and stop asking'],
  ];

  function decisionLabel(d) {
    const hit = APPROVAL_DECISIONS.find(([key]) => key === d);
    return hit ? hit[1] : (d || 'answered');
  }

  function answerApproval(task, approvalId, decision) {
    const a = (task.approvals || []).find((x) => x.id === approvalId);
    if (!a || a.status !== 'pending') return;
    if (!isCoreTask(task)) {
      expireApprovals(task, EXPIRED_UNSUPERVISED);
      toast('This saved task has no supervised core approval session.', 'warn');
      saveState();
      renderAll();
      return;
    }
    apiFetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.backendId, approval_id: approvalId, decision }),
    }).then((r) => {
      if (r.status === 404) {
        // The loop only answers a question it still holds; a 404 means this one
        // was already dropped, so the card must stop asking instead of sitting
        // in My Attention forever.
        markTaskDisconnected(task, EXPIRED_GONE);
        saveState();
        renderAll();
        throw new Error(EXPIRED_GONE);
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(() => {
      a.status = 'resolved';
      a.decision = decision;
      const m = task.msgs.find((x) => x.meta && x.meta.approvalId === approvalId);
      if (m) { m.meta.status = 'resolved'; m.meta.decision = decision; }
      if (task.status === 'WaitingForApproval') task.status = 'Running';
      saveState();
      renderAll();
      toast(decision.startsWith('allow') ? 'Command approved.' : 'Command rejected.', 'good');
    }).catch((e) => {
      const detail = e && e.message ? e.message : String(e);
      if (a.status !== 'expired' && (e && e.name === 'TypeError' || /fetch|network|offline/i.test(detail))) {
        markTaskDisconnected(task, EXPIRED_DISCONNECTED);
        saveState();
        renderAll();
      }
      if (a.status !== 'expired') toast('Could not send answer: ' + detail, 'warn');
      else toast('Answer did not land — ' + (a.note || EXPIRED_GONE), 'warn');
    });
  }

  function renderWorkspaces() {
    const list = $('workspace-list');
    if (!list) return;
    const focusKey = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.focus : null;
    list.innerHTML = '';
    let shown = filteredTasks();
    if (state.attentionOnly) shown = shown.filter(taskNeedsAttention);
    const q = state.searchQuery.trim().toLowerCase();

    const appendTasks = (ul, tasks) => {
      for (const tk of tasks) ul.appendChild(buildTaskRow(tk));
    };

    workspaces.forEach((ws) => {
      const li = document.createElement('li');
      li.className = 'workspace-item' + (ws.id === activeWorkspaceId ? ' active' : '');
      const folders = Array.isArray(ws.source_folders) ? ws.source_folders : [];
      const workspaceIcon = UI_ICON_PATHS[ws.icon] ? ws.icon : 'workspace';
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon" style="${ws.color ? 'background:' + escapeHtml(ws.color) : ''}">${iconSvg(workspaceIcon)}</span>
          <span class="workspace-label">${escapeHtml(ws.name)}</span>
          <button class="workspace-new-task" data-id="${escapeHtml(ws.id)}" type="button" aria-label="Add task to workspace">+</button>
          <button class="workspace-delete" data-id="${escapeHtml(ws.id)}" type="button" aria-label="Delete workspace">×</button>
        </div>`;
      li.querySelector('.workspace-row').addEventListener('click', (e) => {
        if (e.target.classList.contains('workspace-delete') || e.target.classList.contains('workspace-new-task')) return;
        activeWorkspaceId = ws.id;
        saveWorkspaces();
      });
      const mine = shown.filter((t) => t.workspaceId === ws.id);
      if (mine.length > 0 || !q) {
        const ul = document.createElement('ul');
        ul.className = 'workspace-tasks';
        appendTasks(ul, mine);
        li.appendChild(ul);
      }
      if (folders.length > 0) {
        const f = document.createElement('div');
        f.className = 'workspace-folders';
        f.textContent = folders.map((p) => p.split(/[\\/]/).pop()).join(', ');
        li.appendChild(f);
      }
      list.appendChild(li);
    });

    // A task pointing at a workspace that no longer exists still needs a row
    // it can be reached from; with nothing orphaned there is no Unfiled group,
    // the same as the native rail. An empty list gets the bare hint instead of
    // hiding it inside a fake workspace row.
    const unfiled = shown.filter((t) => !t.workspaceId || !workspaces.some((w) => w.id === t.workspaceId));
    if (unfiled.length > 0) {
      const li = document.createElement('li');
      li.className = 'workspace-item unfiled';
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon">${iconSvg('workspace')}</span>
          <span class="workspace-label">Unfiled</span>
        </div>`;
      const ul = document.createElement('ul');
      ul.className = 'workspace-tasks';
      appendTasks(ul, unfiled);
      li.appendChild(ul);
      list.appendChild(li);
    } else if (!q && shown.length === 0 && !state.attentionOnly) {
      const empty = document.createElement('li');
      empty.className = 'task-empty';
      empty.textContent = 'No tasks yet. Start with a prompt.';
      list.appendChild(empty);
    }

    // My Attention: the commands the user has already answered, newest last.
    if (state.attentionOnly) {
      const approved = approvedCommands();
      const li = document.createElement('li');
      li.className = 'workspace-item unfiled';
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon">${iconSvg('check')}</span>
          <span class="workspace-label">Approved commands</span>
        </div>`;
      const ul = document.createElement('ul');
      ul.className = 'workspace-tasks';
      for (const { task, approval } of approved) {
        const row = document.createElement('li');
        row.className = 'task-item approved-command';
        row.tabIndex = 0;
        row.dataset.focus = 'cmd:' + task.id + ':' + (approval.id || '');
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'Go to task: ' + (task.title || 'untitled'));
        // The same words the card asked with, never the tool's own name.
        const cmd = gateTitle(approval.action, approval.command);
        // The dot carries the risk the gate reported (as the desktop rail does);
        // the decision word says allow or reject.
        const risk = approval.risk || 'unknown';
        const riskClass = risk === 'high' ? 'failed' : risk === 'medium' ? 'running' : risk === 'low' ? 'complete' : 'idle';
        row.innerHTML = `
          <div class="task-item-main">
            <div class="task-item-title">${escapeHtml(cmd)}</div>
            <div class="task-item-meta">
              <span class="task-status-dot ${riskClass}"></span>
              <span>${escapeHtml(decisionLabel(approval.decision))}</span>
              <span>·</span>
              <span>${escapeHtml(task.title || '')}</span>
            </div>
          </div>`;
        const jump = () => { switchTask(task.id); };
        row.addEventListener('click', jump);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); }
        });
        ul.appendChild(row);
      }
      if (approved.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'task-empty';
        empty.textContent = 'No answered commands yet.';
        ul.appendChild(empty);
      }
      li.appendChild(ul);
      list.appendChild(li);

      if (shown.length === 0 && approved.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'task-empty';
        empty.textContent = 'Nothing needs your attention.';
        list.appendChild(empty);
      }
    }

    list.querySelectorAll('.workspace-new-task').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        createTaskInWorkspace(btn.dataset.id);
      });
    });

    list.querySelectorAll('.workspace-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (workspaces.length <= 1) { toast('Keep at least one workspace.', 'warn'); return; }
        workspaces = workspaces.filter((w) => w.id !== id);
        if (activeWorkspaceId === id) activeWorkspaceId = workspaces[0] ? workspaces[0].id : null;
        saveWorkspaces();
      });
    });

    // The list is rebuilt on every render, so activating a row with the keyboard
    // would throw focus to the document and send Tab back to the top of the page.
    if (focusKey) {
      const keep = Array.from(list.querySelectorAll('[data-focus]'))
        .find((el) => el.dataset.focus === focusKey);
      if (keep) keep.focus();
    }
  }

  // ── Workspace creation dialog (parity with the native gpui dialog) ─────────
  const WS_ICONS = [
    'workspace', 'file', 'search', 'image', 'panel', 'tool', 'settings', 'queue', 'check', 'download',
    'vault', 'thought', 'list', 'plus', 'clock', 'paperclip', 'mic', 'github', 'image', 'workspace',
  ];
  const WS_COLORS = [
    { name: 'orange', css: '#d97706' }, { name: 'green', css: '#22c55e' },
    { name: 'blue', css: '#3b82f6' }, { name: 'yellow', css: '#eab308' },
    { name: 'red', css: '#ef4444' }, { name: 'pink', css: '#ec4899' },
    { name: 'purple', css: '#a855f7' }, { name: 'teal', css: '#14b8a6' },
  ];
  const wsDraft = { icon: 0, color: 0, folders: [], indexed: true };

  function renderWsFolders() {
    const ul = $('ws-folder-list');
    ul.innerHTML = '';
    wsDraft.folders.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'ws-folder-row';
      li.innerHTML = `<span class="ws-folder-path">${escapeHtml(p)}</span>
        <button class="task-action-btn" type="button" data-i="${i}" aria-label="Remove folder">×</button>`;
      li.querySelector('button').addEventListener('click', () => {
        wsDraft.folders.splice(i, 1);
        renderWsFolders();
      });
      ul.appendChild(li);
    });
  }

  // The source-folder chooser. A page cannot read an absolute disk path back off
  // a browser folder prompt, so this browses the core's own listing instead:
  // /api/files is jailed to the configured workspace root, so every folder the
  // browser can offer is one the agent run will accept too.
  const wsBrowse = { rel: '.', root: '', dirs: [], status: '' };

  function joinRel(rel, name) {
    return rel === '.' || rel === '' ? name : rel + '/' + name;
  }

  function parentRel(rel) {
    const parts = (rel || '.').split('/').filter(Boolean);
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  }

  function browseLabel(rel) {
    if (!wsBrowse.root) return rel === '.' ? '/' : rel;
    const root = wsBrowse.root.replace(/[\\/]+$/, '');
    if (rel === '.' || rel === '') return root;
    const sep = root.includes('\\') ? '\\' : '/';
    return root + sep + rel.split('/').join(sep);
  }

  function renderWsBrowser() {
    const list = $('ws-browser-list');
    const atRoot = wsBrowse.rel === '.' || wsBrowse.rel === '';
    $('ws-browser-path').textContent = browseLabel(wsBrowse.rel);
    $('ws-browser-up').disabled = atRoot;
    list.innerHTML = '';
    if (wsBrowse.status) {
      const li = document.createElement('li');
      li.className = 'ws-browser-empty';
      li.textContent = wsBrowse.status;
      list.appendChild(li);
      return;
    }
    if (!atRoot) {
      const up = document.createElement('li');
      up.innerHTML = '<button class="ws-browser-dir" type="button" data-up>↑ ..</button>';
      up.querySelector('button').addEventListener('click', () => browseFolders(parentRel(wsBrowse.rel)));
      list.appendChild(up);
    }
    for (const d of wsBrowse.dirs) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-browser-dir';
      b.innerHTML = iconSvg('workspace') + '<span>' + escapeHtml(d.name) + '</span>';
      b.addEventListener('click', () => browseFolders(d.rel));
      li.appendChild(b);
      list.appendChild(li);
    }
    if (atRoot && wsBrowse.dirs.length === 0) {
      const li = document.createElement('li');
      li.className = 'ws-browser-empty';
      li.textContent = 'No folders here.';
      list.appendChild(li);
    }
  }

  async function browseFolders(rel) {
    wsBrowse.rel = rel;
    wsBrowse.dirs = [];
    if (state.backendKind === 'unknown') {
      wsBrowse.status = 'Backend capabilities are unknown. Type a folder path instead.';
      renderWsBrowser();
      return;
    }
    wsBrowse.status = 'Loading…';
    renderWsBrowser();
    try {
      const route = state.backendKind === 'rust'
        ? '/api/work/files?path=.&workspace=' + encodeURIComponent(rel)
        : '/api/files?path=.&workspace=' + encodeURIComponent(rel);
      const resp = await apiFetch(route);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      const entries = Array.isArray(j.entries) ? j.entries : [];
      if (typeof j.root === 'string') wsBrowse.root = j.root;
      wsBrowse.dirs = entries.filter((e) => e && e.is_dir)
        .map((e) => ({ name: e.name, rel: joinRel(rel, e.path) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      wsBrowse.status = '';
    } catch (_) {
      wsBrowse.dirs = [];
      wsBrowse.status = 'The core is not answering, so the list is empty. Type a folder path instead.';
    }
    renderWsBrowser();
  }

  async function openWsBrowser() {
    const panel = $('ws-folder-browser');
    panel.hidden = false;
    await browseFolders(wsBrowse.rel);
  }

  function closeWsBrowser() { $('ws-folder-browser').hidden = true; }

  function renderWsGrids() {
    const ig = $('ws-icon-grid');
    ig.innerHTML = '';
    WS_ICONS.forEach((icon, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-icon-btn' + (i === wsDraft.icon ? ' selected' : '');
      b.innerHTML = iconSvg(icon);
      b.setAttribute('aria-label', 'Workspace icon ' + (i + 1));
      b.addEventListener('click', () => { wsDraft.icon = i; renderWsGrids(); });
      ig.appendChild(b);
    });
    const cg = $('ws-color-grid');
    cg.innerHTML = '';
    WS_COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-color-btn' + (i === wsDraft.color ? ' selected' : '');
      b.style.background = c.css;
      b.setAttribute('aria-label', c.name);
      b.addEventListener('click', () => { wsDraft.color = i; renderWsGrids(); });
      cg.appendChild(b);
    });
  }

  function openWorkspaceDialog() {
    wsDraft.icon = 0; wsDraft.color = 0; wsDraft.folders = []; wsDraft.indexed = true;
    wsBrowse.rel = '.'; wsBrowse.dirs = []; wsBrowse.status = '';
    $('ws-name').value = '';
    $('ws-folder-input').value = '';
    $('ws-indexed').checked = true;
    closeWsBrowser();
    renderWsFolders();
    renderWsGrids();
    $('workspace-dialog').showModal();
    $('ws-name').focus();
  }

  function initWorkspaceDialog() {
    $('ws-folder-add').addEventListener('click', () => {
      const p = $('ws-folder-input').value.trim();
      if (!p) { toast('Enter a folder path first.', 'warn'); return; }
      wsDraft.folders.push(p);
      $('ws-folder-input').value = '';
      renderWsFolders();
    });
    $('ws-folder-browse').addEventListener('click', () => {
      if ($('ws-folder-browser').hidden) openWsBrowser(); else closeWsBrowser();
    });
    $('ws-browser-up').addEventListener('click', () => browseFolders(parentRel(wsBrowse.rel)));
    $('ws-browser-close').addEventListener('click', closeWsBrowser);
    $('ws-browser-choose').addEventListener('click', () => {
      const p = browseLabel(wsBrowse.rel);
      if (!wsDraft.folders.includes(p)) wsDraft.folders.push(p);
      renderWsFolders();
      closeWsBrowser();
      toast('Folder "' + p + '" added.', 'good');
    });
    $('ws-folder-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('ws-folder-add').click(); }
    });
    const close = () => $('workspace-dialog').close();
    $('ws-cancel').addEventListener('click', close);
    $('ws-cancel-x').addEventListener('click', close);
    $('ws-create').addEventListener('click', () => {
      const name = $('ws-name').value.trim();
      if (!name) { toast('Please enter a workspace name.', 'warn'); return; }
      const id = 'ws-' + Date.now();
      workspaces.push({
        id, name,
        icon: WS_ICONS[wsDraft.icon],
        color: WS_COLORS[wsDraft.color].css,
        source_folders: wsDraft.folders.slice(),
        indexed: $('ws-indexed').checked,
      });
      activeWorkspaceId = id;
      saveWorkspaces();
      close();
      toast('Workspace "' + name + '" created.', 'good');
      syncWorkspaceRepositories();
    });
  }

  async function syncBackendRepositories() {
    if (!supportsRepositoryControls()) return;
    try {
      const resp = await apiFetch('/api/repositories');
      if (!resp.ok) return;
      const repos = await resp.json();
      if (!Array.isArray(repos)) return;
      let changed = false;
      for (const r of repos) {
        if (!r || !r.id) continue;
        if (!workspaces.some((w) => w.repoId === r.id)) {
          workspaces.push({ id: 'repo-' + r.id, name: r.name || r.id, icon: 'workspace', repoId: r.id });
          changed = true;
        }
      }
      if (changed) saveWorkspaces();
    } catch (_) { /* backend offline — local workspaces only */ }
  }

  async function syncWorkspaceRepositories() {
    if (!supportsGithubControls()) return;
    // Mirrors the desktop's sync_workspace_github_repos: an unbound workspace
    // adopts the GitHub repository of its first source folder, when it has one.
    let changed = false;
    for (const ws of workspaces) {
      if (ws.githubRepo) continue;
      const folder = (ws.source_folders && ws.source_folders[0]) || '';
      if (!folder) continue;
      try {
        const resp = await apiFetch('/api/github/detect?path=' + encodeURIComponent(folder));
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data && data.repository) { ws.githubRepo = data.repository; changed = true; }
      } catch (_) { /* backend offline — the binding stays manual */ }
    }
    if (changed) { saveWorkspaces(); updateWorkspaceDisplay(); }
  }

  function setGithubAccountButton(text, state) {
    const button = $('github-account-button');
    if (!button) return;
    const status = String(text).replace(/^GitHub\s*·\s*/, '');
    button.innerHTML = iconSvg('github') + `<span class="account-status-text">${escapeHtml(status)}</span>`;
    button.setAttribute('aria-label', 'GitHub account: ' + status);
    button.title = button.disabled ? 'Available only with the Rust coding-agent backend.' : 'GitHub account: ' + status;
    button.classList.toggle('connected', state === 'connected');
    button.classList.toggle('error', state === 'error');
  }

  async function refreshGithub() {
    const accountEl = $('github-account-status');
    const listEl = $('github-repository-list');
    if (!accountEl || !listEl) return;
    if (!supportsGithubControls()) {
      accountEl.textContent = 'GitHub controls are unavailable on this backend.';
      setGithubAccountButton('GitHub · unavailable', 'error');
      repositoryHint(listEl, 'Use the Rust coding-agent backend for GitHub integration.');
      return;
    }
    accountEl.textContent = 'Checking GitHub authentication…';
    setGithubAccountButton('GitHub · Checking…', 'checking');
    listEl.replaceChildren();
    const loading = document.createElement('span');
    loading.className = 'settings-hint';
    loading.textContent = 'Loading repositories…';
    listEl.appendChild(loading);
    try {
      const [accountResponse, repositoriesResponse] = await Promise.all([
        apiFetch('/api/github/account'),
        apiFetch('/api/github/repositories'),
      ]);
      const account = accountResponse.ok ? await accountResponse.json() : null;
      const repositories = repositoriesResponse.ok ? await repositoriesResponse.json() : null;
      if (!account || !account.authenticated) {
        accountEl.textContent = (account && account.error) || 'GitHub is not authenticated.';
        setGithubAccountButton('GitHub · Sign in', 'error');
        listEl.replaceChildren();
        const hint = document.createElement('span');
        hint.className = 'settings-hint';
        hint.textContent = 'Run “gh auth login” locally, then refresh.';
        listEl.appendChild(hint);
        return;
      }
      const profile = account.account || {};
      accountEl.textContent = profile.display_name
        ? profile.display_name + ' (@' + profile.login + ')'
        : '@' + profile.login;
      setGithubAccountButton('GitHub · @' + (profile.login || 'connected'), 'connected');
      listEl.replaceChildren();
      for (const repository of (repositories && repositories.repositories) || []) {
        const row = document.createElement('a');
        row.className = 'github-repository';
        row.href = repository.html_url;
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
        row.textContent = repository.full_name + (repository.private ? ' · private' : '');
        listEl.appendChild(row);
      }
      if (!listEl.childElementCount) {
        const empty = document.createElement('span');
        empty.className = 'settings-hint';
        empty.textContent = 'No repositories were returned.';
        listEl.appendChild(empty);
      }
    } catch (_) {
      accountEl.textContent = 'Could not reach the coding-agent backend.';
      setGithubAccountButton('GitHub · unavailable', 'error');
      listEl.replaceChildren();
      const hint = document.createElement('span');
      hint.className = 'settings-hint';
      hint.textContent = 'Check the backend connection, then refresh.';
      listEl.appendChild(hint);
    }
  }

  function repositoryHint(listEl, text) {
    listEl.replaceChildren();
    const hint = document.createElement('span');
    hint.className = 'settings-hint';
    hint.textContent = text;
    listEl.appendChild(hint);
  }

  // Mirrors fennec-ui::repository::open_repository_dialog: list the signed-in
  // gh account's repositories, bind one to the workspace, or create a
  // private one. Binding only writes the workspace record, nothing is pushed.
  function openRepositoryDialog() {
    if (!supportsRepositoryControls() || !supportsGithubControls()) {
      toast('Repository controls are available only with the Rust coding-agent backend.', 'warn');
      return;
    }
    const ws = activeWorkspace();
    if (!ws) { toast('Select a workspace first.', 'warn'); return; }
    const dialog = $('repository-dialog');
    const listEl = $('repository-choice-list');
    const nameInput = $('repository-new-name');
    if (!dialog || !listEl) return;
    if (nameInput) nameInput.value = '';
    repositoryHint(listEl, 'Loading repositories…');
    dialog.showModal();
    apiFetch('/api/github/repositories').then(async (response) => {
      const data = response.ok ? await response.json() : null;
      const repositories = (data && data.repositories) || [];
      if (!repositories.length) {
        repositoryHint(listEl, 'No GitHub repositories are available. Sign in with gh, or create one below.');
        return;
      }
      listEl.replaceChildren();
      for (const repository of repositories) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'repository-choice';
        row.textContent = repository.full_name + ' · ' + (repository.private ? 'Private' : 'Public');
        if (repository.full_name === ws.githubRepo) row.classList.add('selected');
        row.addEventListener('click', () => {
          bindRepository(repository.full_name);
          dialog.close();
        });
        listEl.appendChild(row);
      }
    }).catch(() => repositoryHint(listEl, 'Could not reach the coding-agent backend.'));
  }

  function bindRepository(fullName) {
    if (!supportsGithubControls()) {
      toast('Repository binding is available only with the Rust coding-agent backend.', 'warn');
      return;
    }
    const ws = activeWorkspace();
    if (!ws) return;
    ws.githubRepo = fullName;
    saveWorkspaces();
    toast('Workspace connected to ' + fullName + '.', 'good');
  }

  function createRepository() {
    if (!supportsGithubControls()) {
      toast('Repository creation is available only with the Rust coding-agent backend.', 'warn');
      return;
    }
    const nameInput = $('repository-new-name');
    const dialog = $('repository-dialog');
    const name = ((nameInput && nameInput.value) || '').trim();
    if (!name) { toast('Enter a repository name.', 'warn'); return; }
    if (dialog) dialog.close();
    toast('Creating GitHub repository…', 'info');
    apiFetch('/api/github/repositories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true }),
    }).then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.full_name) {
        toast((data && data.error) || 'Could not create the repository.', 'warn');
        return;
      }
      bindRepository(data.full_name);
    }).catch(() => toast('Could not reach the coding-agent backend.', 'warn'));
  }

  // Inline create from the unbound banner: reads from the banner's input field.
  function createRepositoryInline() {
    if (!supportsGithubControls()) {
      toast('Repository creation is available only with the Rust coding-agent backend.', 'warn');
      return;
    }
    const nameInput = $('repository-create-name');
    const name = ((nameInput && nameInput.value) || '').trim();
    if (!name) { toast('Enter a repository name.', 'warn'); return; }
    if (nameInput) nameInput.value = '';
    toast('Creating GitHub repository…', 'info');
    apiFetch('/api/github/repositories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, private: true }),
    }).then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.full_name) {
        toast((data && data.error) || 'Could not create the repository.', 'warn');
        return;
      }
      bindRepository(data.full_name);
    }).catch(() => toast('Could not reach the coding-agent backend.', 'warn'));
  }

  // Mirrors the native settings Integrations page: the static Nod bridge card
  // plus the verified capability contract shared by startup and Settings.
  function renderCapabilities() {
    const statusEl = $('capability-status');
    const featuresEl = $('capability-features');
    if (!statusEl || !featuresEl) return;
    const contract = state.capabilities;
    if (!contract) {
      statusEl.textContent = 'Backend capabilities are unavailable.';
      featuresEl.textContent = 'Start fennec-core to load coding capabilities, or fennec-agent for Rust-only tools.';
      return;
    }
    statusEl.textContent = contract.backend + ' ' + contract.version + ' · protocol ' + contract.protocol_version;
    featuresEl.textContent = contract.features.join(' · ');
  }

  async function refreshCapabilities() {
    await probeCapabilities();
  }

  function setObsidianAccountButton(text, state) {
    const button = $('obsidian-account-button');
    if (!button) return;
    const status = String(text).replace(/^Obsidian\s*·\s*/, '');
    button.innerHTML = iconSvg('vault') + `<span class="account-status-text">${escapeHtml(status)}</span>`;
    button.setAttribute('aria-label', 'Obsidian vault: ' + status);
    button.title = button.disabled ? 'Available only with the Rust coding-agent backend.' : 'Obsidian vault: ' + status;
    button.classList.toggle('connected', state === 'connected');
    button.classList.toggle('error', state === 'error');
  }

  async function refreshObsidian() {
    const statusEl = $('obsidian-account-status');
    if (!statusEl) return;
    if (!supportsObsidianControls()) {
      statusEl.textContent = 'Obsidian controls are unavailable on this backend.';
      setObsidianAccountButton('Obsidian · unavailable', 'error');
      return;
    }
    statusEl.textContent = 'Checking Obsidian vault…';
    setObsidianAccountButton('Obsidian · Checking…', 'checking');
    try {
      const response = await apiFetch('/api/obsidian/status');
      const status = response.ok ? await response.json() : null;
      if (!status || !status.configured) {
        statusEl.textContent = (status && status.message) || 'Obsidian vault is not configured.';
        setObsidianAccountButton('Obsidian · Configure', 'error');
        return;
      }
      statusEl.textContent = 'Vault ready: ' + (status.vault || 'configured');
      setObsidianAccountButton('Obsidian · Ready', 'connected');
    } catch (_) {
      statusEl.textContent = 'Could not reach the coding-agent backend.';
      setObsidianAccountButton('Obsidian · unavailable', 'error');
    }
  }

  async function writeObsidianNote() {
    if (!supportsObsidianControls()) {
      const statusEl = $('obsidian-write-status');
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'Obsidian writes are available only with the Rust coding-agent backend.';
      }
      return;
    }
    const statusEl = $('obsidian-write-status');
    const title = $('obsidian-note-title').value.trim();
    const folder = $('obsidian-note-folder').value.trim();
    const content = $('obsidian-note-content').value;
    if (!title || !content.trim()) {
      statusEl.hidden = false;
      statusEl.textContent = 'Enter a note title and content.';
      return;
    }
    statusEl.hidden = false;
    statusEl.className = 'settings-hint';
    statusEl.textContent = 'Writing note…';
    try {
      const response = await apiFetch('/api/obsidian/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          folder: folder || null,
          content,
          overwrite: $('obsidian-note-overwrite').checked,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Obsidian write failed');
      statusEl.className = 'settings-hint';
      statusEl.textContent = 'Wrote ' + result.path;
      refreshObsidian();
    } catch (error) {
      statusEl.className = 'error-text';
      statusEl.textContent = error.message || 'Obsidian write failed.';
    }
  }

  // ── Settings dialog wiring ─────────────────────────────────────────────────
  function applyTheme(theme) {
    // Each theme carries its own `--brand` accent (and with it the icons and
    // chrome that consume it); fennec-ui/src/theme.rs mirrors this map token
    // for token. Dark keeps the original terracotta; the others are tuned to
    // their own ground and still hold white button text.
    const themes = {
      dark: { bg: '#141414', panel: '#191919', surface: '#1F1F1F', text: '#EDEDED', brand: '#E9865D' },
      light: { bg: '#FFFFFF', panel: '#F5F5F5', surface: '#E8E8E8', text: '#1A1A1A', brand: '#C2542A' },
      ocean: { bg: '#0A1929', panel: '#0D2137', surface: '#132F4C', text: '#E0F2FE', brand: '#1F6FE4' },
      forest: { bg: '#0F1F0F', panel: '#1A2E1A', surface: '#253D25', text: '#E8F5E9', brand: '#2E9458' },
      sunset: { bg: '#2D1B1B', panel: '#3D2424', surface: '#4D2D2D', text: '#FEE2E2', brand: '#DC4A38' },
      lavender: { bg: '#1E1B2E', panel: '#2A2640', surface: '#363252', text: '#EDE9FE', brand: '#8B5CF6' },
      coffee: { bg: '#1A1410', panel: '#241C14', surface: '#2E2418', text: '#F5E6D3', brand: '#A9713F' },
    };
    const t = themes[theme] || themes.dark;
    const root = document.documentElement;
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--panel', t.panel);
    root.style.setProperty('--surface', t.surface);
    root.style.setProperty('--text', t.text);
    root.style.setProperty('--brand', t.brand);
    localStorage.setItem('fennec-theme', theme);
  }

  function applyFontSize(px) {
    document.documentElement.style.fontSize = px + 'px';
    localStorage.setItem('fennec-font-size', String(px));
  }

  function initSettings() {
    const settingsDialog = $('settings-dialog');
    if (!settingsDialog) return;

    const openGithubSettings = () => {
      const tab = settingsDialog.querySelector('.settings-tab[data-tab="github"]');
      if (tab) tab.click();
      refreshGithub();
      if (!settingsDialog.open) settingsDialog.showModal();
    };
    const githubAccountButton = $('github-account-button');
    if (githubAccountButton) githubAccountButton.addEventListener('click', openGithubSettings);
    const obsidianAccountButton = $('obsidian-account-button');
    if (obsidianAccountButton) obsidianAccountButton.addEventListener('click', () => {
      const tab = settingsDialog.querySelector('.settings-tab[data-tab="obsidian"]');
      if (tab) tab.click();
      refreshObsidian();
      if (!settingsDialog.open) settingsDialog.showModal();
    });

    $('settings-button').addEventListener('click', () => {
      $('font-size').value = settings.fontSize;
      $('auto-save').checked = settings.autoSave;
      $('notifications').checked = settings.notifications;
      $('debug-mode').checked = settings.debug;
      refreshGithub();
      refreshObsidian();
      refreshCapabilities();
      settingsDialog.showModal();
    });
    $('settings-close').addEventListener('click', () => settingsDialog.close());
    $('github-refresh').addEventListener('click', refreshGithub);
    $('obsidian-refresh').addEventListener('click', refreshObsidian);
    $('obsidian-write').addEventListener('click', writeObsidianNote);
    refreshGithub();
    refreshObsidian();
    refreshCapabilities();
    settingsDialog.addEventListener('click', (e) => {
      if (e.target === settingsDialog) settingsDialog.close();
    });

    // Tabs
    const tabs = settingsDialog.querySelectorAll('.settings-tab');
    const panels = settingsDialog.querySelectorAll('.settings-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = settingsDialog.querySelector(`#panel-${tab.dataset.tab}`);
        if (panel) panel.classList.add('active');
      });
    });

    // Themes
    const themeItems = settingsDialog.querySelectorAll('.theme-item');
    themeItems.forEach((item) => {
      item.addEventListener('click', () => {
        themeItems.forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        applyTheme(item.dataset.theme);
      });
    });

    // Appearance
    $('font-size').addEventListener('change', () => {
      const px = Math.min(24, Math.max(10, parseInt($('font-size').value, 10) || 14));
      settings.fontSize = px;
      $('font-size').value = px;
      applyFontSize(px);
    });

    // Behavior / advanced toggles
    $('auto-save').addEventListener('change', () => {
      settings.autoSave = $('auto-save').checked;
      localStorage.setItem('fennec-auto-save', String(settings.autoSave));
      if (settings.autoSave) saveState();
    });
    $('notifications').addEventListener('change', () => {
      settings.notifications = $('notifications').checked;
      localStorage.setItem('fennec-notifications', String(settings.notifications));
      if (settings.notifications && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    });
    $('debug-mode').addEventListener('change', () => {
      settings.debug = $('debug-mode').checked;
      localStorage.setItem('fennec-debug', String(settings.debug));
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  loadState();

  // Composer: send / stop
  sendButton.addEventListener('click', () => {
    if (isWorking()) stopTask();
    else sendMessage();
  });
  composerInput.addEventListener('input', updateSendButton);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isWorking()) sendMessage();
      else if (composerInput.value.trim()) sendMessage();
    }
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => handleNav(btn.dataset.nav));
  });

  // Task search filter
  taskSearch.addEventListener('input', () => {
    state.searchQuery = taskSearch.value || '';
    renderTaskList();
  });
  taskSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      taskSearch.value = '';
      state.searchQuery = '';
      taskSearch.hidden = true;
      document.querySelector('[data-nav="search"]').classList.remove('active');
      renderTaskList();
    }
  });

  // Inspector toggle (top-right; the panel has no header of its own)
  $('inspector-toggle').addEventListener('click', toggleInspector);
  applyInspectorState();

  // Composer tools
  $('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  // Dictation (click to start, click again to stop). The clip is posted to
  // the backend's /api/stt, which is the only route that starts the
  // faster-whisper sidecar (`fennec_client::Speech`); `stt.py` takes raw audio
  // bytes, so the blob goes out as its own body with the recorder's mime type.
  // Browser SpeechRecognition was the old path: it transcribes on Google's
  // servers, which the local-first promise rules out, and its empty onerror
  // made a refused microphone look exactly like a silent one.
  let recorder = null;
  $('btn-dictate').addEventListener('click', async () => {
    const btn = $('btn-dictate');
    if (recorder) { recorder.stop(); return; }
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') {
      toast('This browser cannot record from the microphone.', 'warn');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast('Microphone unavailable: ' +
        (e && e.name === 'NotAllowedError' ? 'permission refused in the browser'
          : (e && e.message) || String(e)), 'warn');
      return;
    }
    const chunks = [];
    const rec = new MediaRecorder(stream);
    const stop = () => { stream.getTracks().forEach((t) => t.stop()); recorder = null; btn.innerHTML = iconSvg('mic'); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => {
      stop();
      toast('Recording failed: ' + ((e && e.error && e.error.name) || 'unknown error'), 'warn');
    };
    rec.onstop = async () => {
      const type = rec.mimeType || 'audio/webm';
      stop();
      const blob = new Blob(chunks, { type });
      if (!blob.size) { toast('The microphone captured nothing.', 'warn'); return; }
      // A cold sidecar is started and loaded inside this one request, so the
      // glyph has to say "listening to you took, now transcribing" or the
      // button looks dead for the seconds the model takes.
      btn.innerHTML = iconSvg('clock');
      try {
        const res = await apiFetch('/api/stt', {
          method: 'POST', headers: { 'Content-Type': type }, body: blob,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || body.error || ('http ' + res.status));
        const text = (body.text || '').trim();
        if (!text) { toast("Didn't catch any words.", 'info'); return; }
        const sep = composerInput.value && !/\s$/.test(composerInput.value) ? ' ' : '';
        composerInput.value += sep + text;
        composerInput.focus();
        updateSendButton();
      } catch (e) {
        toast('Speech recognition failed: ' + e.message, 'warn');
      }
      btn.innerHTML = iconSvg('mic');
    };
    recorder = rec;
    btn.innerHTML = iconSvg('stop');
    rec.start();
  });

  // Permission dropdown
  const permTrigger = $('permission-trigger');
  const permDropdown = $('permission-dropdown');
  permTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = permDropdown.hidden;
    closeDropdowns();
    permDropdown.hidden = !open;
    permTrigger.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.permission-option').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      setPermissionMode(opt.dataset.mode);
      closeDropdowns();
    });
  });
  permDropdown.addEventListener('click', (e) => e.stopPropagation());

  // Model dropdown
  const modelTrigger = $('model-trigger');
  const modelDropdown = $('model-dropdown');
  modelTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = modelDropdown.hidden;
    closeDropdowns();
    modelDropdown.hidden = !open;
    modelTrigger.setAttribute('aria-expanded', String(open));
  });
  modelDropdown.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', closeDropdowns);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDropdowns();
  });

  // Diff dialog close
  const diffDialog = $('diff-dialog');
  if (diffDialog) {
    $('diff-close').addEventListener('click', () => diffDialog.close());
    diffDialog.addEventListener('click', (e) => { if (e.target === diffDialog) diffDialog.close(); });
  }

  // Delivered file preview: modal dialog, dismissed with × or backdrop click.
  const fileViewerClose = $('file-viewer-close');
  if (fileViewerClose) fileViewerClose.addEventListener('click', closeFileViewer);
  const fileViewerDialog = $('file-viewer-dialog');
  if (fileViewerDialog) fileViewerDialog.addEventListener('click', (e) => { if (e.target === fileViewerDialog) closeFileViewer(); });

  // Workspaces
  const btnAddWorkspace = $('btn-add-workspace');
  if (btnAddWorkspace) {
    initWorkspaceDialog();
    btnAddWorkspace.addEventListener('click', openWorkspaceDialog);
  }

  // GitHub repository picker: the banner's icon and the unbound connect action
  // both open it, so an unbound workspace can reach it too.
  const changeRepository = $('change-repository');
  if (changeRepository) changeRepository.addEventListener('click', openRepositoryDialog);
  const connectRepository = $('connect-repository');
  if (connectRepository) connectRepository.addEventListener('click', openRepositoryDialog);
  // Inline create button in the unbound banner: reads from the banner's input.
  const createInline = $('repository-create-inline');
  if (createInline) createInline.addEventListener('click', createRepositoryInline);
  const repositoryDialog = $('repository-dialog');
  if (repositoryDialog) {
    $('repository-create').addEventListener('click', createRepository);
    const closeRepositoryDialog = () => repositoryDialog.close();
    $('repository-cancel').addEventListener('click', closeRepositoryDialog);
    $('repository-cancel-x').addEventListener('click', closeRepositoryDialog);
    repositoryDialog.addEventListener('click', (e) => { if (e.target === repositoryDialog) repositoryDialog.close(); });
  }

  // Settings + theme + font
  initSettings();
  initPaneResize();
  initInspectorTabs();
  const savedTheme = readSetting('fennec-theme', 'dark');
  applyTheme(savedTheme);
  const savedThemeItem = document.querySelector(`.theme-item[data-theme="${savedTheme}"]`);
  if (savedThemeItem) savedThemeItem.classList.add('active');
  applyFontSize(settings.fontSize);

  // Permission + model initial state
  setPermissionMode(permissionMode);
  renderModelDropdown();
  loadModels();

  renderWorkspaces();
  updateWorkspaceDisplay();

  // Initial render + capability-gated backend wiring. checkHealth resumes only
  // tasks whose saved backend identity matches the verified current backend.
  renderAll();
  checkHealth();

  setInterval(checkHealth, 30000);
  // The running block carries a timer, so the clock has to be redrawn while the
  // run is in progress and not only when a step lands.
  setInterval(() => { if (isWorking()) { tickTimer(); renderRightPanel(); } }, 1000);
})();