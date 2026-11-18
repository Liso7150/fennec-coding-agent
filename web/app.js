// Fennec Workspace — full client: persistence, backend API, SSE events, dynamic UI.
// Endpoints used (same origin by default, configurable in Settings → Connection):
//   GET  /health
//   GET  /api/models            (optional; falls back to the desktop model list)
//   POST /api/tasks             { title, user_goal, repository_id }
//   POST /api/tasks/:id/start
//   POST /api/tasks/:id/stop
//   POST /api/tasks/:id/messages { content }   (text-only backend; files are inlined)
//   GET  /api/tasks/:id         (messages, tool_events, artifacts, status)
//   DELETE /api/tasks/:id
//   GET  /api/events            (SSE EventEnvelope stream)
//   GET  /api/repositories
(function () {
  'use strict';

  const STORAGE_KEY = 'fennec-coding-agent-history';
  const MAX_INLINE_BYTES = 200 * 1024; // per attached text file
  const POLL_INTERVAL_MS = 1000;
  const POLL_MAX_ATTEMPTS = 180;

  // ── Settings (persisted) ───────────────────────────────────────────────────
  function readSetting(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  }

  let apiBase = (readSetting('fennec-server-url', '') || '').replace(/\/+$/, '');
  const settings = {
    autoSave: readSetting('fennec-auto-save', 'true') !== 'false',
    notifications: readSetting('fennec-notifications', 'true') !== 'false',
    debug: readSetting('fennec-debug', 'false') === 'true',
    experimental: readSetting('fennec-experimental', 'false') === 'true',
    fontSize: parseInt(readSetting('fennec-font-size', '14'), 10) || 14,
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    tasks: [],
    activeId: null,
    queued: [],
    inspectorOpen: readSetting('fennec-inspector-open', 'true') !== 'false',
    backendConnected: false,
    nextId: 1,
    searchQuery: '',
    attachments: [], // pending composer attachments (not persisted)
  };

  const FALLBACK_MODELS = [
    { id: 'qwen3_5_moe', name: 'Qwen3.5-MoE' },
    { id: 'edge0_145b', name: 'Edge0-145B' },
    { id: 'qwen36_35b', name: 'Qwen36-35B' },
  ];
  let models = FALLBACK_MODELS.slice();
  let currentModel = readSetting('fennec-model', 'qwen3_5_moe');

  // Permission modes mirror the desktop app (gui_main.rs set_access_mode).
  const PERM_MODES = {
    ask: {
      icon: '🛡', label: 'Ask every time', colorClass: 'perm-ask',
      flags: { allow_write: false, allow_shell: false, allow_web: false, ask_each: true },
    },
    auto: {
      icon: '🕐', label: 'Auto approve', colorClass: 'perm-auto',
      flags: { allow_write: true, allow_shell: true, allow_web: true, ask_each: false },
    },
    full: {
      icon: '⚠', label: 'Full access', colorClass: 'perm-full',
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

  // ── Persistence ────────────────────────────────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Only restore real conversations — never empty drafts.
        state.tasks = (parsed.tasks || []).filter((t) => t && Array.isArray(t.msgs) && t.msgs.length > 0);
        state.activeId = parsed.activeId || null;
        state.queued = Array.isArray(parsed.queued) ? parsed.queued : [];
        if (state.activeId !== null && !state.tasks.some((t) => t.id === state.activeId)) {
          state.activeId = null;
        }
        state.nextId = (state.tasks.reduce((m, t) => Math.max(m, t.id || 0), 0) || 0) + 1;
        for (const t of state.tasks) {
          // Runtime-only flags must never survive a reload.
          t.polling = false;
          t.finalized = false;
          const maxMsg = (t.msgs || []).reduce((m, x) => Math.max(m, x.id || 0), 0);
          state.nextId = Math.max(state.nextId, maxMsg + 1);
        }
      }
    } catch (_) { /* corrupt storage — start fresh */ }
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

  function activeTask() {
    return state.tasks.find((t) => t.id === state.activeId) || null;
  }

  function isWorking() {
    const t = activeTask();
    return !!t && (t.status === 'Running' || t.status === 'Planning');
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

  // ── Tool kind → display mapping (events.rs ToolEventKind) ─────────────────
  const TOOL_KINDS = {
    InspectRepository: { label: 'Inspect repository', icon: '🔍', category: 'source' },
    ReadFile: { label: 'Read file', icon: '📖', category: 'source' },
    SearchCode: { label: 'Search code', icon: '🔍', category: 'source' },
    CreateFile: { label: 'Create file', icon: '📝', category: 'edit' },
    EditFile: { label: 'Edit file', icon: '📝', category: 'edit' },
    DeleteFile: { label: 'Delete file', icon: '🗑', category: 'edit' },
    ReviewDiff: { label: 'Review diff', icon: '👁', category: 'edit' },
    RunCommand: { label: 'Run command', icon: '⌨', category: 'command' },
    RunTestSuite: { label: 'Run tests', icon: '🧪', category: 'command' },
    BuildProject: { label: 'Build project', icon: '🔧', category: 'command' },
    LintProject: { label: 'Lint project', icon: '🧹', category: 'command' },
    FormatProject: { label: 'Format project', icon: '🧹', category: 'command' },
    SearchDocumentation: { label: 'Search documentation', icon: '🌐', category: 'web' },
    OpenUrl: { label: 'Open URL', icon: '🌐', category: 'web' },
    AnalyzeImage: { label: 'Analyze image', icon: '🖼', category: 'other' },
    GenerateArtifact: { label: 'Generate artifact', icon: '📦', category: 'edit' },
    VerifyImplementation: { label: 'Verify implementation', icon: '✓', category: 'other' },
    GitFetch: { label: 'Git fetch', icon: '🔀', category: 'command' },
    GitPull: { label: 'Git pull', icon: '🔀', category: 'command' },
    GitCommit: { label: 'Git commit', icon: '🔀', category: 'command' },
    GitPush: { label: 'Git push', icon: '🔀', category: 'command' },
    PullRequestOperation: { label: 'Pull request', icon: '🔀', category: 'other' },
    FineTuneModel: { label: 'Fine-tune model', icon: '⚡', category: 'other' },
    EvaluateFineTunedModel: { label: 'Evaluate model', icon: '⚡', category: 'other' },
  };

  function toolMeta(kind) {
    return TOOL_KINDS[kind] || { label: kind || 'Action', icon: '🔧', category: 'other' };
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

  function deleteTask(id) {
    const tk = state.tasks.find((t) => t.id === id);
    if (!tk) return;
    if (!confirm('Delete task "' + tk.title + '"?')) return;
    if (tk.backendId) {
      fetch(apiBase + '/api/tasks/' + encodeURIComponent(tk.backendId), { method: 'DELETE' }).catch(() => {});
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
    if (tk && (tk.status === 'Running' || tk.status === 'Planning') && tk.backendId && !tk.polling) {
      pollTask(tk);
    }
  }

  // ── Render: center — timeline ──────────────────────────────────────────────
  function renderTimeline() {
    timeline.innerHTML = '';
    const task = activeTask();

    if (!task) {
      timelineHeader.hidden = true;
      const empty = document.createElement('div');
      empty.className = 'timeline-empty';
      empty.innerHTML = '<div class="timeline-empty-icon">🦊</div><div>No active task.</div><div class="muted">Type a prompt below to start a new conversation.</div>';
      timeline.appendChild(empty);
      return;
    }

    timelineHeader.hidden = false;
    timelineTitle.textContent = task.title || 'New task';
    timelineRepo.textContent = (task.repo || 'local') + ' · ' + (task.branch || 'main');
    timelineStatusText.textContent = task.status;
    timelineStatus.className = 'status-badge status-' + String(task.status || '').toLowerCase();

    const ordered = task.msgs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const m of ordered) {
      timeline.appendChild(renderMessage(m));
    }
    timeline.scrollTop = timeline.scrollHeight;
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
            <div class="message-header">
              <div class="message-avatar user">L</div>
              <span class="message-author user">${escapeHtml(m.author)}</span>
              <span class="message-time">${time}</span>
            </div>
            <div class="message-body">${escapeHtml(m.content)}</div>
          </div>`;
        break;

      case 'think': {
        const chunks = meta.chunks || 0;
        const hint = chunks > 0 ? chunks + ' chunk' + (chunks !== 1 ? 's' : '') : 'waiting';
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1" role="button" tabindex="0" aria-expanded="${!m.collapsed}">
              <div class="message-avatar agent">F</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
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
        const status = meta.status || 'Complete';
        const dur = meta.duration ? ' · ' + meta.duration : '';
        const statusClass = status === 'Failed' ? 'failed' : status === 'Running' ? 'running' : 'complete';
        const lines = (m.content || '').split('\n').length;
        const hint = status === 'Running' ? 'running…' : lines + ' line' + (lines !== 1 ? 's' : '');
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1" role="button" tabindex="0" aria-expanded="${!m.collapsed}">
              <div class="message-avatar agent tool-avatar">${tm.icon}</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="action-label">${escapeHtml(title)}</span>
              <span class="chunk-hint">${escapeHtml(hint)}</span>
              <span class="message-status ${statusClass}">${escapeHtml(status)}${escapeHtml(dur)}</span>
              <span class="message-time">${time}</span>
              <span class="collapse-indicator">${chevron(m)}</span>
            </div>
            <div class="message-body mono-body">${escapeHtml(m.content)}</div>
          </div>`;
        break;
      }

      case 'attach': {
        const fn = meta.title || 'file';
        const path = meta.path || '';
        const size = meta.size || '';
        const icon = meta.isImage ? '🖼' : '📄';
        const kindLabel = meta.isImage ? 'Image attachment' : (meta.kindLabel || 'Document attachment');
        wrap.innerHTML = `
          <div class="message-card">
            <div class="attachment-card">
              <span class="attachment-icon">${icon}</span>
              <div class="attachment-info">
                <div class="attachment-name">${escapeHtml(fn)}</div>
                <div class="muted attachment-sub">${escapeHtml(path ? path + ' · ' : '')}${escapeHtml(kindLabel)}</div>
              </div>
              <span class="attachment-size">${escapeHtml(size)}</span>
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
              <div class="message-avatar agent tool-avatar">📝</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
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

      case 'result':
      default: {
        const streaming = !!meta.stream;
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <div class="message-avatar agent result-avatar">✓</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              ${streaming ? '<span class="message-status running">Streaming…</span>' : ''}
              <span class="message-time">${time}</span>
              <button class="tts-btn" type="button" title="Read aloud" aria-label="Read aloud">🔊</button>
            </div>
            <div class="message-body">${escapeHtml(m.content)}</div>
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

    return wrap;
  }

  // ── TTS (per assistant message) ────────────────────────────────────────────
  let speakingBtn = null;

  function stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (speakingBtn) {
      speakingBtn.classList.remove('speaking');
      speakingBtn.textContent = '🔊';
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
    const utter = new SpeechSynthesisUtterance(m.content || '');
    utter.lang = 'en-US';
    utter.onend = () => { if (speakingBtn === btn) stopSpeaking(); };
    utter.onerror = () => { if (speakingBtn === btn) stopSpeaking(); };
    speakingBtn = btn;
    btn.classList.add('speaking');
    btn.textContent = '⏹';
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

  // ── Render: task queue (only while working AND prompts queued) ────────────
  function renderQueue() {
    taskQueueList.innerHTML = '';
    const show = state.queued.length > 0 && isWorking();
    taskQueue.hidden = !show;
    if (!show) return;

    for (let i = 0; i < state.queued.length; i++) {
      const li = document.createElement('li');
      li.className = 'task-queue-item';
      li.innerHTML = `
        <span class="queue-dot"></span>
        <span class="queue-title">${escapeHtml(state.queued[i])}</span>
        <span class="queue-status">${i === 0 ? 'Next' : 'Queued'}</span>
        <button class="queue-remove" type="button" data-idx="${i}" title="Remove from queue" aria-label="Remove from queue">✕</button>`;
      taskQueueList.appendChild(li);
    }
    taskQueueCount.textContent = state.queued.length + ' item' + (state.queued.length !== 1 ? 's' : '');

    taskQueueList.querySelectorAll('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        state.queued.splice(idx, 1);
        saveState();
        renderQueue();
      });
    });
  }

  function drainQueue() {
    if (state.queued.length > 0 && !isWorking()) {
      const next = state.queued.shift();
      saveState();
      renderQueue();
      sendMessage(next);
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
        if (meta.toolKind) stats.toolKinds[meta.toolKind] = (stats.toolKinds[meta.toolKind] || 0) + 1;
        if (meta.category === 'delegate' || tm.category === 'delegate') stats.delegations.push(meta.title || 'Delegation');
        else if (tm.category === 'command') stats.commands++;
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
        <span class="agent-icon">🦊</span>
        <div class="agent-info">
          <div class="agent-name">Fennec</div>
          <div class="agent-task">${escapeHtml(task.title)}</div>
          <div class="agent-status running">Running · ${elapsed}</div>
        </div>`;
      agentList.appendChild(item);
    } else {
      const note = document.createElement('div');
      note.className = 'agent-note muted';
      note.textContent = 'No agents running.';
      agentList.appendChild(note);
    }

    // Subagents — delegations seen in events / tool data
    if (stats.delegations.length > 0) {
      setContextValue('subagents-value',
        stats.delegations.length + ' delegation' + (stats.delegations.length !== 1 ? 's' : '') +
        ' · ' + stats.delegations.slice(-2).join(', '), true);
    } else {
      setContextValue('subagents-value', 'No active delegated agents', false);
    }

    // Processes — commands run + stream state
    const msgCount = task ? task.msgs.length : 0;
    setContextValue('processes-value',
      stats.commands + ' command' + (stats.commands !== 1 ? 's' : '') + ' run · ' +
      msgCount + ' messages · stream ' + (working ? 'active' : 'idle'),
      stats.commands > 0 || working);

    // Skills — distinct tool kinds used
    const kinds = Object.keys(stats.toolKinds);
    if (kinds.length > 0) {
      const top = kinds.sort((a, b) => stats.toolKinds[b] - stats.toolKinds[a]).slice(0, 3)
        .map((k) => toolMeta(k).label);
      setContextValue('skills-value', kinds.length + ' tool kind' + (kinds.length !== 1 ? 's' : '') + ' · ' + top.join(', '), true);
    } else {
      setContextValue('skills-value', 'No tool activity yet', false);
    }

    // Artifacts — produced files / edits
    const artifactEl = $('artifact-count');
    if (artifactEl) {
      const files = stats.editedFiles.length;
      artifactEl.textContent = stats.artifacts + ' task artifact' + (stats.artifacts !== 1 ? 's' : '') +
        (files > 0 ? ' · ' + files + ' file' + (files !== 1 ? 's' : '') + ' edited' : '');
      artifactEl.className = 'context-value ' + (stats.artifacts > 0 ? 'ok' : 'muted');
    }

    // Web Readings — OpenUrl / SearchDocumentation
    if (stats.webReadings.length > 0) {
      setContextValue('webreadings-value',
        stats.webReadings.length + ' reading' + (stats.webReadings.length !== 1 ? 's' : '') +
        ' · ' + stats.webReadings[stats.webReadings.length - 1], true);
    } else {
      setContextValue('webreadings-value', 'No linked readings', false);
    }

    // Sources — files read / inspected / searched
    if (stats.sources.length > 0) {
      setContextValue('sources-value',
        stats.sources.length + ' source' + (stats.sources.length !== 1 ? 's' : '') +
        ' · ' + stats.sources[stats.sources.length - 1], true);
    } else {
      setContextValue('sources-value', 'No task sources', false);
    }

    // Attention badge
    const attentionCount = task ? task.msgs.filter((m) =>
      (m.kind === 'result' && /error|fail|attention/i.test(m.content || '')) ||
      (m.kind === 'action' && m.meta && m.meta.status === 'Failed')).length : 0;
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
  }

  // ── Render all ─────────────────────────────────────────────────────────────
  function renderAll() {
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
      sendButton.title = 'Send prompt';
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
        <span class="attach-chip-icon">${att.isImage ? '🖼' : '📄'}</span>
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

  // ── Backend conversation helpers ───────────────────────────────────────────
  async function createBackendTask(task, prompt) {
    const resp = await fetch(apiBase + '/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: task.title,
        user_goal: prompt,
        repository_id: task.repoId || 'local',
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const agentTask = await resp.json();
    task.backendId = agentTask.id;
    const startResp = await fetch(apiBase + '/api/tasks/' + encodeURIComponent(agentTask.id) + '/start', { method: 'POST' });
    if (!startResp.ok) throw new Error('HTTP ' + startResp.status);
  }

  function postBackendMessage(backendId, prompt) {
    return fetch(apiBase + '/api/tasks/' + encodeURIComponent(backendId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: prompt,
        // Extra hints; the current backend ignores unknown fields.
        model: currentModel,
        permissions: PERM_MODES[permissionMode].flags,
      }),
    });
  }

  // ── Send message ───────────────────────────────────────────────────────────
  async function sendMessage(queuedText) {
    const text = (queuedText != null ? queuedText : composerInput.value).trim();
    const hasAttachments = queuedText == null && state.attachments.length > 0;
    if (!text && !hasAttachments) return;

    const prompt = queuedText != null ? queuedText : buildPrompt(text);
    const attachments = queuedText != null ? [] : state.attachments.slice();

    if (queuedText == null) {
      composerInput.value = '';
      state.attachments = [];
      renderAttachmentChips();
    }

    // If AI is working, queue the prompt (strip shows above composer).
    if (isWorking()) {
      state.queued.push(prompt);
      saveState();
      renderQueue();
      updateSendButton();
      return;
    }

    state.queued = [];

    // Ensure a task exists — created only on a real send, never as a draft.
    if (!state.activeId) {
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
        startedAt: Date.now(),
      });
    }

    const task = activeTask();
    if (!task) return;
    if (text) task.title = text.slice(0, 80);
    task.status = 'Running';
    task.finalized = false;
    task.startedAt = Date.now();

    pushMsg(task, { author: 'Liso7150', content: text || '(attachments)', kind: 'user', collapsed: false });

    for (const att of attachments) {
      pushMsg(task, {
        author: 'Liso7150', content: 'Attached: ' + att.name, kind: 'attach', collapsed: false,
        meta: { title: att.name, path: '.', size: formatFileSize(att.size), isImage: att.isImage },
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
      // Reuse the conversation's backend task so the engine keeps full history.
      if (!task.backendId) await createBackendTask(task, prompt);
      let msgResp = await postBackendMessage(task.backendId, prompt);
      if (msgResp.status === 404) {
        // Backend restarted and lost the task — recreate it.
        task.backendId = null;
        await createBackendTask(task, prompt);
        msgResp = await postBackendMessage(task.backendId, prompt);
      }
      if (!msgResp.ok) throw new Error('HTTP ' + msgResp.status);

      saveState();
      pollTask(task, think.id);
    } catch (e) {
      debugLog('send failed', e);
      task.msgs = task.msgs.filter((m) => m.id !== think.id);
      pushMsg(task, {
        author: 'Fennec',
        content: 'Backend offline — start fennec-agent on :8787. (' + (e && e.message ? e.message : 'network error') + ')',
        kind: 'result', collapsed: false,
      });
      task.status = 'Failed';
      state.backendConnected = false;
      saveState();
      renderAll();
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
    task.polling = false;
    saveState();
    renderAll();
    if (settings.notifications && 'Notification' in window && Notification.permission === 'granted' && task.status === 'Complete') {
      try { new Notification('Fennec task complete', { body: task.title }); } catch (_) {}
    }
    if (task.status === 'Complete') drainQueue();
  }

  async function pollTask(task, thinkId) {
    if (task.polling) return;
    task.polling = true;
    let attempts = 0;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (state.tasks.indexOf(task) === -1) { task.polling = false; return; } // deleted
      if (task.status !== 'Running' && task.status !== 'Planning') { task.polling = false; return; } // stopped elsewhere
      let bt = null;
      try {
        const pollResp = await fetch(apiBase + '/api/tasks/' + encodeURIComponent(task.backendId));
        if (!pollResp.ok) break;
        bt = await pollResp.json();
      } catch (_) { break; }

      syncBackend(task, bt);
      saveState();
      scheduleRender();

      if (bt.status === 'Complete' || bt.status === 'Failed' || bt.status === 'Cancelled' || bt.status === 'Warning' || bt.status === 'NeedsAttention') {
        if (thinkId) task.msgs = task.msgs.filter((m) => m.id !== thinkId || (m.meta && (m.meta.chunks || 0) > 0));
        finalizeTask(task);
        return;
      }
      attempts++;
    }

    // Timed out or backend unreachable.
    if (task.status === 'Running' || task.status === 'Planning') {
      if (thinkId) task.msgs = task.msgs.filter((m) => m.id !== thinkId);
      pushMsg(task, {
        author: 'Fennec',
        content: attempts >= POLL_MAX_ATTEMPTS ? 'Response timed out.' : 'Lost contact with the backend while waiting for the response.',
        kind: 'result', collapsed: false,
      });
      task.status = 'Failed';
      finalizeTask(task);
    }
    task.polling = false;
  }

  async function stopTask() {
    const task = activeTask();
    if (!task || !isWorking()) return;
    if (task.backendId) {
      try {
        await fetch(apiBase + '/api/tasks/' + encodeURIComponent(task.backendId) + '/stop', { method: 'POST' });
      } catch (_) { /* offline — cancel locally */ }
    }
    task.status = 'Cancelled';
    task.msgs = task.msgs.filter((m) => !(m.kind === 'think' && m.meta && m.meta.stream && (m.meta.chunks || 0) === 0));
    pushMsg(task, { author: 'Fennec', content: 'Task stopped by user.', kind: 'result', collapsed: false });
    finalizeTask(task);
    toast('Task stopped.', 'info');
  }

  // ── SSE live events (/api/events) ──────────────────────────────────────────
  let eventSource = null;

  function connectEvents() {
    if (eventSource) { eventSource.close(); eventSource = null; }
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
            fetch(apiBase + '/api/tasks/' + encodeURIComponent(task.backendId))
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
        if (!task) return;
        pushMsg(task, {
          author: 'Fennec',
          content: '⚠ Approval requested: ' + (payload.action || 'action') + '\n' + (payload.reason || '') +
            (payload.command ? '\nCommand: ' + payload.command : ''),
          kind: 'result', collapsed: false,
        });
        saveState();
        scheduleRender();
        break;
      }

      case 'BackendDisconnected': {
        state.backendConnected = false;
        updateBackendStatus();
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
  function handleNav(nav) {
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
    const btn = document.querySelector(`[data-nav="${nav}"]`);
    if (btn) btn.classList.add('active');

    switch (nav) {
      case 'new-task':
        state.activeId = null;
        state.queued = [];
        saveState();
        renderAll();
        composerInput.focus();
        break;
      case 'attention': {
        const task = activeTask();
        if (task) {
          const ordered = task.msgs.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
          const idx = ordered.findIndex((m) =>
            (m.kind === 'result' && /error|fail|attention/i.test(m.content || '')) ||
            (m.kind === 'action' && m.meta && m.meta.status === 'Failed'));
          if (idx >= 0) {
            const msgs = timeline.querySelectorAll('.message');
            if (msgs[idx]) msgs[idx].scrollIntoView({ behavior: 'smooth' });
          } else {
            toast('Nothing needs your attention.', 'info');
          }
        }
        break;
      }
      case 'search':
        taskSearch.hidden = !taskSearch.hidden;
        if (!taskSearch.hidden) {
          taskSearch.focus();
        } else {
          state.searchQuery = '';
          taskSearch.value = '';
          renderTaskList();
        }
        break;
      case 'coding':
        composerInput.placeholder = 'Ask Fennec to inspect, edit, test, or explain your code';
        composerInput.focus();
        break;
    }
  }

  // ── Inspector toggle ───────────────────────────────────────────────────────
  function applyInspectorState() {
    rightPanel.classList.toggle('collapsed', !state.inspectorOpen);
    appLayout.classList.toggle('inspector-closed', !state.inspectorOpen);
    const t = $('inspector-toggle');
    if (t) t.setAttribute('aria-pressed', String(state.inspectorOpen));
  }

  function toggleInspector() {
    state.inspectorOpen = !state.inspectorOpen;
    localStorage.setItem('fennec-inspector-open', String(state.inspectorOpen));
    applyInspectorState();
  }

  // ── Backend health ─────────────────────────────────────────────────────────
  function updateBackendStatus() {
    statusDot.setAttribute('data-state', state.backendConnected ? 'online' : 'error');
    backendStatus.textContent = state.backendConnected ? 'Backend connected' : 'Disconnected';
    renderRightPanel();
  }

  async function checkHealth() {
    try {
      const resp = await fetch(apiBase + '/health');
      state.backendConnected = resp.ok;
    } catch (_) {
      state.backendConnected = false;
    }
    updateBackendStatus();
  }

  // ── Models ─────────────────────────────────────────────────────────────────
  function modelDisplayName(id) {
    const m = models.find((x) => x.id === id);
    if (m) return m.name;
    const fb = FALLBACK_MODELS.find((x) => x.id === id);
    return fb ? fb.name : id;
  }

  async function loadModels() {
    try {
      const resp = await fetch(apiBase + '/api/models');
      if (resp.ok) {
        const data = await resp.json();
        const list = Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : null;
        if (list && list.length > 0) {
          models = list.map((m) => typeof m === 'string'
            ? { id: m, name: m }
            : { id: m.id || m.name, name: m.name || m.display_name || m.id });
        }
      }
    } catch (_) { /* endpoint absent — keep fallback list */ }
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
    dl.innerHTML = '<span class="model-download-icon">⬇</span><span class="model-option-name muted">Download new model…</span>';
    dl.addEventListener('click', (e) => {
      e.stopPropagation();
      dd.hidden = true;
      $('model-trigger').setAttribute('aria-expanded', 'false');
      toast('Model download coming soon.', 'info');
    });
    dd.appendChild(dl);
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
    workspaces = [{ id: 'default', name: 'Default', icon: '📁' }];
    activeWorkspaceId = 'default';
  }
  if (!workspaces.some((w) => w.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id;

  function activeWorkspace() {
    return workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0] || null;
  }

  function saveWorkspaces() {
    localStorage.setItem('fennec-workspaces', JSON.stringify(workspaces));
    localStorage.setItem('fennec-active-workspace', activeWorkspaceId || '');
    renderWorkspaces();
    updateWorkspaceDisplay();
  }

  function updateWorkspaceDisplay() {
    const ws = activeWorkspace();
    const nameEl = $('workspace-name');
    if (nameEl && ws) nameEl.textContent = ws.name;
    const task = activeTask();
    if (timelineRepo) timelineRepo.textContent = ((task && task.repo) || (ws ? ws.name : 'local')) + ' · main';
  }

  function renderWorkspaces() {
    const list = $('workspace-list');
    if (!list) return;
    list.innerHTML = '';
    const shown = filteredTasks();
    const q = state.searchQuery.trim().toLowerCase();

    const appendTasks = (ul, tasks) => {
      for (const tk of tasks) ul.appendChild(buildTaskRow(tk));
    };

    workspaces.forEach((ws) => {
      const li = document.createElement('li');
      li.className = 'workspace-item' + (ws.id === activeWorkspaceId ? ' active' : '');
      const folders = Array.isArray(ws.source_folders) ? ws.source_folders : [];
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon" style="${ws.color ? 'background:' + escapeHtml(ws.color) : ''}">${escapeHtml(ws.icon || '📁')}</span>
          <span class="workspace-label">${escapeHtml(ws.name)}</span>
          <button class="workspace-delete" data-id="${escapeHtml(ws.id)}" type="button" aria-label="Delete workspace">×</button>
        </div>`;
      li.querySelector('.workspace-row').addEventListener('click', (e) => {
        if (e.target.classList.contains('workspace-delete')) return;
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

    const unfiled = shown.filter((t) => !t.workspaceId || !workspaces.some((w) => w.id === t.workspaceId));
    if (unfiled.length > 0 || (!q && shown.length === 0)) {
      const li = document.createElement('li');
      li.className = 'workspace-item unfiled';
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon">🗂</span>
          <span class="workspace-label">Unfiled</span>
        </div>`;
      const ul = document.createElement('ul');
      ul.className = 'workspace-tasks';
      appendTasks(ul, unfiled);
      if (unfiled.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'task-empty';
        empty.textContent = q ? 'No tasks match the filter.' : 'No tasks yet. Type a prompt to start.';
        ul.appendChild(empty);
      }
      li.appendChild(ul);
      list.appendChild(li);
    }

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
  }

  // ── Workspace creation dialog (parity with the native gpui dialog) ─────────
  const WS_ICONS = ['📁', '💻', '🔬', '🧪', '🎨', '🤖', '⚙️', '🔧', '📦', '🚀'];
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

  function renderWsGrids() {
    const ig = $('ws-icon-grid');
    ig.innerHTML = '';
    WS_ICONS.forEach((icon, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-icon-btn' + (i === wsDraft.icon ? ' selected' : '');
      b.textContent = icon;
      b.setAttribute('aria-label', 'Icon ' + (i + 1));
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
    $('ws-name').value = '';
    $('ws-folder-input').value = '';
    $('ws-indexed').checked = true;
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
    });
  }

  async function syncBackendRepositories() {
    try {
      const resp = await fetch(apiBase + '/api/repositories');
      if (!resp.ok) return;
      const repos = await resp.json();
      if (!Array.isArray(repos)) return;
      let changed = false;
      for (const r of repos) {
        if (!r || !r.id) continue;
        if (!workspaces.some((w) => w.repoId === r.id)) {
          workspaces.push({ id: 'repo-' + r.id, name: r.name || r.id, icon: '📁', repoId: r.id });
          changed = true;
        }
      }
      if (changed) saveWorkspaces();
    } catch (_) { /* backend offline — local workspaces only */ }
  }

  // ── Settings dialog wiring ─────────────────────────────────────────────────
  function applyTheme(theme) {
    const themes = {
      dark: { bg: '#15120F', panel: '#1B1714', surface: '#28211A', text: '#F2EEE8' },
      light: { bg: '#FFFFFF', panel: '#F5F5F5', surface: '#E8E8E8', text: '#1A1A1A' },
      ocean: { bg: '#0A1929', panel: '#0D2137', surface: '#132F4C', text: '#E0F2FE' },
      forest: { bg: '#0F1F0F', panel: '#1A2E1A', surface: '#253D25', text: '#E8F5E9' },
      sunset: { bg: '#2D1B1B', panel: '#3D2424', surface: '#4D2D2D', text: '#FEE2E2' },
      lavender: { bg: '#1E1B2E', panel: '#2A2640', surface: '#363252', text: '#EDE9FE' },
      coffee: { bg: '#1A1410', panel: '#241C14', surface: '#2E2418', text: '#F5E6D3' },
    };
    const t = themes[theme] || themes.dark;
    const root = document.documentElement;
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--panel', t.panel);
    root.style.setProperty('--surface', t.surface);
    root.style.setProperty('--text', t.text);
    localStorage.setItem('fennec-theme', theme);
  }

  function applyFontSize(px) {
    document.documentElement.style.fontSize = px + 'px';
    localStorage.setItem('fennec-font-size', String(px));
  }

  function initSettings() {
    const settingsDialog = $('settings-dialog');
    if (!settingsDialog) return;

    $('settings-button').addEventListener('click', () => {
      $('server-url').value = apiBase;
      $('engine-url').value = readSetting('fennec-engine-url', '');
      $('access-token').value = readSetting('fennec-access-token', '');
      $('font-size').value = settings.fontSize;
      $('auto-save').checked = settings.autoSave;
      $('notifications').checked = settings.notifications;
      $('debug-mode').checked = settings.debug;
      $('experimental').checked = settings.experimental;
      settingsDialog.showModal();
    });
    $('settings-close').addEventListener('click', () => settingsDialog.close());
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

    // Connection
    $('save-connection').addEventListener('click', () => {
      const url = $('server-url').value.trim().replace(/\/+$/, '');
      const errEl = $('connect-error');
      if (url && !/^https?:\/\//i.test(url)) {
        errEl.textContent = 'URL must start with http:// or https://';
        errEl.hidden = false;
        return;
      }
      errEl.hidden = true;
      apiBase = url;
      localStorage.setItem('fennec-server-url', apiBase);
      localStorage.setItem('fennec-engine-url', $('engine-url').value.trim());
      localStorage.setItem('fennec-access-token', $('access-token').value);
      checkHealth();
      connectEvents();
      loadModels();
      syncBackendRepositories();
      toast('Connection settings saved.', 'good');
    });
    $('disconnect-button').addEventListener('click', () => {
      apiBase = '';
      localStorage.removeItem('fennec-server-url');
      $('server-url').value = '';
      state.backendConnected = false;
      updateBackendStatus();
      checkHealth();
      connectEvents();
      toast('Disconnected — using same-origin default.', 'info');
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
    $('experimental').addEventListener('change', () => {
      settings.experimental = $('experimental').checked;
      localStorage.setItem('fennec-experimental', String(settings.experimental));
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
      renderTaskList();
    }
  });

  // Inspector toggles (top-right + panel header)
  $('inspector-toggle').addEventListener('click', toggleInspector);
  $('inspector-collapse').addEventListener('click', toggleInspector);
  applyInspectorState();

  // Composer tools
  $('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) addFiles(Array.from(fileInput.files));
    fileInput.value = '';
  });

  // Dictation (click to start / stop)
  let recognition = null;
  $('btn-dictate').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Speech recognition not supported in this browser.', 'warn'); return; }
    const btn = $('btn-dictate');
    if (recognition) {
      recognition.stop();
      recognition = null;
      btn.textContent = '🎤';
      return;
    }
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onresult = (e) => {
      composerInput.value += e.results[0][0].transcript;
      updateSendButton();
    };
    recognition.onend = () => { recognition = null; btn.textContent = '🎤'; };
    recognition.onerror = () => { recognition = null; btn.textContent = '🎤'; };
    btn.textContent = '⏹';
    recognition.start();
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

  // Workspaces
  const btnAddWorkspace = $('btn-add-workspace');
  if (btnAddWorkspace) {
    initWorkspaceDialog();
    btnAddWorkspace.addEventListener('click', openWorkspaceDialog);
  }

  // Settings + theme + font
  initSettings();
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

  // Resume interrupted tasks after reload.
  for (const t of state.tasks) {
    if (t.status === 'Running' || t.status === 'Planning') {
      if (t.backendId) {
        pollTask(t);
      } else {
        t.status = 'Failed';
        t.msgs = t.msgs.filter((m) => !(m.kind === 'think' && m.meta && m.meta.stream));
        pushMsg(t, { author: 'Fennec', content: 'Task interrupted by page reload.', kind: 'result', collapsed: false });
      }
    }
  }

  // Initial render + backend wiring
  renderAll();
  checkHealth();
  connectEvents();
  syncBackendRepositories();

  setInterval(checkHealth, 30000);
  setInterval(() => { if (isWorking()) renderRightPanel(); }, 1000);
})();