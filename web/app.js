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

  // The only statuses with a run still behind them; anything else on disk is
  // finished, so a question it still holds is dead, not unanswered.
  const LIVE_STATUSES = ['Running', 'Planning', 'WaitingForApproval'];
  // The two reasons a question stops being answerable, worded as the native
  // surfaces word them (fennec-ui/src/attention.rs renders "not used · <note>").
  const EXPIRED_ENDED = 'the run ended before an answer arrived';
  const EXPIRED_GONE = 'the loop no longer holds this question';

  // ── Settings (persisted) ───────────────────────────────────────────────────
  function readSetting(key, fallback) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  }

  let apiBase = (readSetting('fennec-server-url', '') || '').replace(/\/+$/, '');
  // Core refuses /api/* without the loopback client header; send it on every call.
  function apiFetch(path, opts) {
    const o = opts || {};
    o.headers = Object.assign({ 'X-Fennec-Client': '1' }, o.headers || {});
    return fetch(apiBase + path, o);
  }

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
    attentionOnly: false,
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
          // A finished conversation cannot still be holding a live question, so
          // reloads of older history do not pin a dead one in My Attention.
          if (LIVE_STATUSES.indexOf(t.status) === -1) expireApprovals(t, EXPIRED_ENDED);
          const maxMsg = (t.msgs || []).reduce((m, x) => Math.max(m, x.id || 0), 0);
          state.nextId = Math.max(state.nextId, maxMsg + 1);
        }
      }
    } catch (_) { /* corrupt storage — start fresh */ }
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

  function mdBody(text) {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      if (list) out.push('<ul class="md-list">' + list.join('') + '</ul>');
      list = null;
    };
    for (const line of String(text || '').split('\n')) {
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

  // The core loop's own registry (fennec_core/tools.py) names calls in snake
  // case; the Rust table above names the same actions in enum form. Both arrive
  // here so a card never falls back to a bare "🔧 write_file".
  const CORE_TOOL_KINDS = {
    write_file: { label: 'Write file', icon: '📝', category: 'edit' },
    edit_file: { label: 'Edit file', icon: '📝', category: 'edit' },
    read_file: { label: 'Read file', icon: '📖', category: 'source' },
    list_dir: { label: 'Inspect repository', icon: '📁', category: 'source' },
    grep: { label: 'Search code', icon: '🔍', category: 'source' },
    semantic_search: { label: 'Semantic search', icon: '🔍', category: 'source' },
    run_shell: { label: 'Run command', icon: '⌨', category: 'command' },
    run_python: { label: 'Run python', icon: '🧪', category: 'command' },
    git_status: { label: 'Repository status', icon: '🔀', category: 'command' },
    git_diff: { label: 'Review diff', icon: '👁', category: 'edit' },
    web_task: { label: 'Web research', icon: '🌐', category: 'web' },
    coworker_task: { label: 'Delegate to coworker', icon: '🤝', category: 'other' },
    summarise: { label: 'Summarise the run', icon: '✓', category: 'other' },
  };

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
      || { label: kind || 'Action', icon: '🔧', category: 'other' };
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
    if (tk && (tk.status === 'Running' || tk.status === 'Planning') && tk.backendId && !tk.polling) {
      pollTask(tk);
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
    key += '#g' + Array.from(openGroups).sort().join(',');
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
    const folds = foldCalls(ordered, task.id);
    for (let i = 0; i < ordered.length; i += 1) {
      const block = folds.at.get(i);
      if (block) {
        if (block.written.length) timeline.appendChild(renderGroup('written', block.id, '✎', block.written));
        if (block.ran.length) timeline.appendChild(renderGroup('ran', block.id, '⚙', block.ran));
        continue;
      }
      if (folds.hidden.has(i)) continue;
      timeline.appendChild(renderMessage(ordered[i]));
    }
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
    else timeline.scrollTop = previousTop;
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
        // Same placeholder the shared `action_card` draws: the running call is
        // kept out of the folded blocks so it can be watched, and an empty body
        // would make that toggle look dead.
        const bodyText = m.content
          || (status === 'Running' ? 'No output yet.' : 'This call returned no output.');
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
            <div class="message-body mono-body">${escapeHtml(bodyText)}</div>
          </div>`;
        break;
      }

      case 'attach': {
        const fn = meta.title || 'file';
        const badge = meta.badge || (meta.isImage ? 'IMG' : artifactBadge(fn));
        const subtitle = meta.subtitle || attachmentSubtitle(meta.path || '', fn);
        wrap.innerHTML = `
          <div class="message-card">
            <div class="file-chip" role="button" tabindex="0" aria-label="Open ${escapeHtml(fn)}">
              <span class="file-chip-badge" aria-hidden="true">${escapeHtml(badge)}</span>
              <span class="file-chip-text">
                <span class="file-chip-name">${escapeHtml(fn)}</span>
                <span class="file-chip-sub">${escapeHtml(subtitle)}</span>
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

      case 'approval': {
        const pending = meta.status === 'pending';
        const expired = meta.status === 'expired';
        const risk = meta.risk || 'medium';
        const riskClass = risk === 'high' ? 'failed' : risk === 'medium' ? 'running' : 'complete';
        const cmd = meta.command || meta.action || 'action';
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <div class="message-avatar agent tool-avatar">⚠</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="action-label">${escapeHtml(meta.action || 'Approval requested')}</span>
              <span class="message-status ${riskClass}">${escapeHtml(risk)} risk</span>
              <span class="message-time">${time}</span>
            </div>
            <div class="message-body mono-body">${escapeHtml(cmd)}</div>
            ${meta.reason ? `<div class="message-body muted">${escapeHtml(meta.reason)}</div>` : ''}
            <div class="approval-actions">
              ${pending ? APPROVAL_DECISIONS.map(([key, label]) => `<button class="quiet-button approval-btn${key.startsWith('reject') ? ' reject' : ''}" type="button" data-decision="${key}">${label}</button>`).join('') : `<span class="message-status ${expired ? 'failed' : (String(meta.decision || '').startsWith('allow') ? 'complete' : 'failed')}">${escapeHtml(expired ? 'not used · ' + (meta.note || EXPIRED_ENDED) : 'answer sent · ' + decisionLabel(meta.decision))}</span>`}
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
            <div class="message-body md">${mdBody(m.content)}</div>
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
  // Mirrors fennec-ui/src/timeline.rs. Every settled call of one run folds into
  // two blocks — the files it wrote and the tools it ran — and only the call the
  // run is still inside stays on its own, where its output can be watched.
  function foldsUp(m) {
    const d = m.meta || {};
    if (m.kind === 'action') return !!d.status && d.status !== 'Running';
    if (m.kind === 'attach') return !!d.verb;
    return m.kind === 'edit';
  }

  function foldCalls(msgs, taskId) {
    const hidden = new Set();
    const at = new Map();
    let i = 0;
    while (i < msgs.length) {
      if (!foldsUp(msgs[i])) { i += 1; continue; }
      const start = i;
      let end = i;
      while (end < msgs.length && foldsUp(msgs[end])) end += 1;
      const run = msgs.slice(start, end);
      // The loop reports a successful write twice — once as the call, once as the
      // delivered file — and one row per file is the whole point of the count.
      const delivered = new Set(run.filter((m) => m.kind === 'attach').map((m) => (m.meta || {}).path || ''));
      const written = [];
      const ran = [];
      for (const m of run) {
        const w = writeOfTitle((m.meta || {}).title);
        if (m.kind === 'action' && w && delivered.has(w.path)) continue;
        (writeVerb(m) ? written : ran).push(m);
      }
      for (let k = start; k < end; k += 1) hidden.add(k);
      if (written.length || ran.length) at.set(start, { id: taskId + ':' + msgs[start].id, written, ran });
      i = end;
    }
    return { hidden, at };
  }

  // Open blocks survive the per-tick rebuild, which keeps no DOM.
  const openGroups = new Set();
  const openGroupRows = new Set();

  function groupRowOf(m, kind) {
    const d = m.meta || {};
    if (kind === 'written') {
      const path = d.path || (writeOfTitle(d.title) || {}).path || '';
      const name = baseName(d.title || path || 'file');
      return {
        icon: d.badge || artifactBadge(name),
        label: path || d.title || name,
        status: writeVerb(m) || 'changed',
        adds: d.add || 0,
        dels: d.del || 0,
        failed: false,
        msg: m,
        // Only a delivered card knows how to read the file off disk; the call
        // that made it has its result text, which is what the row shows inline.
        opens: m.kind === 'attach' ? 'file' : 'text',
      };
    }
    const failed = d.status === 'Failed';
    return {
      icon: toolMeta(d.toolKind).icon,
      label: d.title || toolMeta(d.toolKind).label,
      status: failed ? 'Failed' : (d.duration ? 'Complete · ' + d.duration : 'Complete'),
      adds: 0, dels: 0, failed,
      msg: m,
      opens: 'text',
    };
  }

  function renderGroup(kind, blockId, icon, msgs) {
    const rows = msgs.map((m) => groupRowOf(m, kind));
    const failed = rows.filter((r) => r.failed).length;
    const title = kind === 'written'
      ? 'Written ' + rows.length + ' file' + (rows.length === 1 ? '' : 's')
      : 'Ran ' + rows.length + ' tool' + (rows.length === 1 ? '' : 's');
    // Both blocks of one run are keyed by their first call, so the open state
    // carries the kind too — otherwise opening "Written" opens "Ran" with it.
    const openKey = kind + ':' + blockId;
    const open = openGroups.has(openKey);
    const box = document.createElement('div');
    box.className = 'tool-group';
    box.innerHTML = `
      <div class="tool-group-header" role="button" tabindex="0" aria-expanded="${open}">
        <span class="group-chev">${open ? '▾' : '▸'}</span>
        <span class="group-icon">${icon}</span>
        <span class="group-title">${escapeHtml(title)}</span>
        ${failed ? `<span class="group-failed">${failed} failed</span>` : ''}
      </div>`;
    const head = box.querySelector('.tool-group-header');
    const toggle = () => {
      if (openGroups.has(openKey)) openGroups.delete(openKey); else openGroups.add(openKey);
      renderTimeline();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    if (!open) return box;
    const body = document.createElement('div');
    body.className = 'tool-group-body';
    for (const r of rows) {
      const rowKey = openKey + ':' + r.msg.id;
      const rowOpen = openGroupRows.has(rowKey);
      const row = document.createElement('div');
      row.className = 'group-row' + (r.failed ? ' failed' : '') + (rowOpen ? ' open' : '');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.innerHTML = `
        <span class="group-row-icon mono">${escapeHtml(r.icon)}</span>
        <span class="group-row-label mono">${escapeHtml(r.label)}</span>
        ${r.adds ? `<span class="ok mono">+${r.adds}</span>` : ''}
        ${r.dels ? `<span class="err-text mono">−${r.dels}</span>` : ''}
        <span class="group-row-status">${escapeHtml(r.status)}</span>`;
      const detail = document.createElement('div');
      detail.className = 'group-row-detail mono-body';
      const text = (r.msg.content || '').trim() || (r.msg.meta || {}).diff || '';
      detail.textContent = text || 'No output was captured for this call.';
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
    const utter = new SpeechSynthesisUtterance(stripMd(m.content));
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

  // ── Delivered files: open, copy path, save a copy ─────────────────────────
  // The core loop owns the workspace on disk and answers /api/file for it. The
  // Rust chat backend has no file route and never writes a file, so a chip
  // aimed at it says what is missing instead of showing an empty pane.
  async function readDelivered(m) {
    const path = (m.meta && m.meta.path) || '';
    if (!path) return { error: 'This card carries no path to open.' };
    if ((await probeBackendKind()) !== 'core') {
      return { error: 'Preview needs the core agent loop. Point Settings → Connection at fennec-core.' };
    }
    const root = (m.meta && m.meta.workspace) || runFolder();
    const ws = root ? '&workspace=' + encodeURIComponent(root) : '';
    try {
      const r = await apiFetch('/api/file?path=' + encodeURIComponent(path) + ws);
      if (!r.ok) return { error: 'The backend refused ' + path + ' (HTTP ' + r.status + ').' };
      const j = await r.json();
      return { text: String(j.content || ''), lines: j.lines };
    } catch (e) {
      return { error: 'Could not reach the backend: ' + (e && e.message ? e.message : e) };
    }
  }

  async function openDeliveredFile(m) {
    const dlg = $('file-dialog');
    if (!dlg) return;
    const name = (m.meta && m.meta.title) || 'file';
    $('file-name').textContent = name;
    $('file-path').textContent = joinPath((m.meta && m.meta.workspace) || runFolder(), (m.meta && m.meta.path) || '');
    $('file-meta').textContent = 'reading…';
    const body = $('file-body');
    body.textContent = '';
    dlg.showModal();
    const res = await readDelivered(m);
    if (res.error) {
      $('file-meta').textContent = res.error;
      body.textContent = '';
      return;
    }
    $('file-meta').textContent = (res.lines != null ? res.lines + ' lines · ' : '')
      + formatFileSize(new TextEncoder().encode(res.text).length);
    body.textContent = res.text;
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
    const rel = (m.meta && (m.meta.path || m.meta.title)) || '';
    const text = joinPath((m.meta && m.meta.workspace) || runFolder(), rel);
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
    const resp = await apiFetch('/api/tasks', {
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
    const startResp = await apiFetch('/api/tasks/' + encodeURIComponent(agentTask.id) + '/start', { method: 'POST' });
    if (!startResp.ok) throw new Error('HTTP ' + startResp.status);
  }

  function postBackendMessage(backendId, prompt) {
    return apiFetch('/api/tasks/' + encodeURIComponent(backendId) + '/messages', {
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

  // ── Core supervised loop (/api/agent/*): the only backend that gates tools ──
  // The Rust fennec-agent backend is a thin chat/event server with no approval
  // gate; the Python core runs the supervised loop and asks before gated calls.
  // Detect which one apiBase points at so approvals (and My Attention) are real.
  let backendKind = null;
  async function probeBackendKind() {
    if (backendKind) return backendKind;
    try {
      const r = await apiFetch('/api/health');
      const j = await r.json();
      backendKind = (j && j.app) ? 'core' : 'rust';
    } catch (_) { backendKind = 'rust'; }
    return backendKind;
  }

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
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    task.backendId = j.id;
    // The directory the run is jailed to. A delivered path is relative to it, so
    // opening one later has to name it back to the file route.
    task.backendWs = typeof j.workspace === 'string' ? j.workspace : '';
    task.core = true;
  }

  function coreStreamMsg(task) {
    let m = task.msgs.find((x) => x.kind === 'result' && x.meta && x.meta.coreStream);
    if (!m) {
      m = pushMsg(task, { author: 'Fennec', content: '', kind: 'result', collapsed: false, meta: { coreStream: true, stream: true } });
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
    const key = 'deliver:' + (s.call_id || s.id || (s.name + ':' + rel));
    if (task.msgs.some((x) => x.meta && x.meta.deliveryKey === key)) return;
    const result = s.result || {};
    const name = baseName(rel);
    const bytes = typeof result.bytes === 'number' ? result.bytes : '';
    const replaced = typeof result.replaced === 'number' ? result.replaced : null;
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

  // What the run changed, counted from the delivery cards themselves — the same
  // list the timeline shows, so a summary cannot name a file the run never
  // delivered, and a task resumed from history still reports its own writes.
  function workSummary(task) {
    const rows = [];
    const seen = {};
    for (const m of (task.msgs || [])) {
      const mt = m.meta;
      if (m.kind !== 'attach' || !mt || !mt.verb || !mt.path) continue;
      const prev = seen[mt.path];
      if (prev) { prev.count += 1; continue; }
      seen[mt.path] = { path: mt.path, verb: mt.verb, size: mt.size, replaced: mt.replaced, count: 1 };
      rows.push(seen[mt.path]);
    }
    if (!rows.length) return '';
    let out = '**Delivered ' + rows.length + ' file' + (rows.length === 1 ? '' : 's') + '**\n\n';
    for (const r of rows) {
      const parts = [r.verb];
      if (r.count > 1) parts.push(r.count + '×');
      if (r.size) parts.push(r.size);
      if (r.replaced != null && r.verb !== 'created') parts.push(r.replaced + ' replacement' + (r.replaced === 1 ? '' : 's'));
      out += '- `' + r.path + '` — ' + parts.join(', ') + '\n';
    }
    return out;
  }

  function applyCoreStep(task, s, thinkId) {
    const kind = s.type;
    if (kind === 'partial') {
      const m = coreStreamMsg(task);
      m.content += (s.content || '');
      if (thinkId) task.msgs = task.msgs.filter((x) => x.id !== thinkId);
    } else if (kind === 'assistant' || kind === 'final') {
      const m = coreStreamMsg(task);
      m.content = s.content || m.content;
      if (kind === 'final') {
        m.meta.stream = false;
        const sum = workSummary(task);
        if (sum && m.content.indexOf('**Delivered ') === -1) {
          m.content = m.content.replace(/\s+$/, '') + '\n\n' + sum;
        }
      }
      if (thinkId) task.msgs = task.msgs.filter((x) => x.id !== thinkId);
    } else if (kind === 'plan') {
      const text = (s.entries || []).map((e) => (e.status === 'completed' ? '✓ ' : '• ') + e.content).join('\n');
      let m = task.msgs.find((x) => x.kind === 'think' && x.meta && x.meta.corePlan);
      if (!m) m = pushMsg(task, { author: 'Fennec', content: text, kind: 'think', collapsed: true, meta: { corePlan: true } });
      else m.content = text;
    } else if (kind === 'tool_start') {
      const id = s.id || s.call_id || s.name;
      if (!task.msgs.some((x) => x.meta && x.meta.toolId === id)) {
        pushMsg(task, {
          author: 'Fennec', content: '', kind: 'action', collapsed: true,
          meta: { toolId: id, toolKind: s.name, title: describeCall(s.name, s.args).title, status: 'Running' },
        });
      }
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
          command: args.command || args.filename || args.path || null,
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
    } else if (kind === 'error') {
      pushMsg(task, { author: 'Fennec', content: s.content || 'Task error.', kind: 'result', collapsed: false });
    } else if (kind === 'cancelled') {
      pushMsg(task, { author: 'Fennec', content: 'Task cancelled.', kind: 'result', collapsed: false });
    }
  }

  async function pollCore(task, thinkId) {
    if (task.polling) return;
    task.polling = true;
    let after = 0;
    let attempts = 0;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (state.tasks.indexOf(task) === -1) { task.polling = false; return; }
      let j = null;
      try {
        const r = await apiFetch('/api/agent/poll?id=' + encodeURIComponent(task.backendId) + '&after=' + after);
        if (!r.ok) break;
        j = await r.json();
      } catch (_) { break; }
      after = j.total != null ? j.total : after + (j.steps || []).length;
      for (const s of (j.steps || [])) applyCoreStep(task, s, thinkId);
      const live = j.pending || [];
      // A question the loop dropped was answered in another window or timed out
      // in the loop itself; either way it is no longer ours to answer, exactly
      // as the native lane treats it (gui_main.rs CoreEvent::Pending).
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
      // Blocked on the user is not slow: don't let the timeout kill it.
      if (live.length) attempts = 0; else attempts++;
    }
    if (task.status === 'Running' || task.status === 'WaitingForApproval') {
      pushMsg(task, { author: 'Fennec', content: 'Response timed out.', kind: 'result', collapsed: false });
      task.status = 'Failed';
      finalizeTask(task);
    }
    task.polling = false;
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
      const kind = await probeBackendKind();
      if (kind === 'core') {
        // Supervised loop: gates tools and asks before protected calls, so
        // approvals (and the My Attention list) are real.
        await startCoreTask(task, prompt);
        saveState();
        pollCore(task, think.id);
      } else {
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
      }
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

    // Approvals → pending cards + resolved record (survives reload / poll).
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
        if (m) { m.meta.status = rec.status; m.meta.decision = rec.decision; }
      }
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
    if (task.status === 'Complete') drainQueue();
  }

  async function pollTask(task, thinkId) {
    if (task.polling) return;
    task.polling = true;
    let attempts = 0;
    while (attempts < POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (state.tasks.indexOf(task) === -1) { task.polling = false; return; } // deleted
      if (task.status !== 'Running' && task.status !== 'Planning' && task.status !== 'WaitingForApproval') { task.polling = false; return; } // stopped elsewhere
      let bt = null;
      try {
        const pollResp = await apiFetch('/api/tasks/' + encodeURIComponent(task.backendId));
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
      // A run blocked on the user is not slow: don't let the timeout kill it.
      if (bt.status === 'WaitingForApproval') attempts = 0;
      else attempts++;
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
        await apiFetch('/api/tasks/' + encodeURIComponent(task.backendId) + '/stop', { method: 'POST' });
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
        if (!task) return;
        const a = payload.approval || payload;
        const id = a.approval_id || a.id || ev.event_id;
        if (!task.approvals) task.approvals = [];
        if (task.approvals.some((x) => x.id === id)) break;
        const args = a.args || {};
        const record = {
          id,
          action: a.action || a.name || 'action',
          command: a.command || args.command || args.filename || args.path || null,
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
        state.attentionOnly = false;
        saveState();
        renderAll();
        composerInput.focus();
        break;
      case 'attention': {
        state.attentionOnly = !state.attentionOnly;
        document.querySelectorAll('.nav-item').forEach((el) => el.classList.remove('active'));
        const target = document.querySelector(`[data-nav="${state.attentionOnly ? 'attention' : 'coding'}"]`);
        if (target) target.classList.add('active');
        renderAll();
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
      // /api/health is the one route both backends answer; /health is Rust-only,
      // so probing it read a running core as offline.
      const resp = await apiFetch('/api/health');
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
      const resp = await apiFetch('/api/models');
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

  // The four answers the core loop accepts (fennec_core/loop.py:_APPROVAL_OPTIONS),
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
    if (!task.backendId) { toast('No backend session to answer.', 'warn'); return; }
    apiFetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.backendId, approval_id: approvalId, decision }),
    }).then((r) => {
      if (r.status === 404) {
        // The loop only answers a question it still holds; a 404 means this one
        // was already dropped, so the card must stop asking instead of sitting
        // in My Attention forever.
        a.status = 'expired';
        a.note = EXPIRED_GONE;
        const dead = task.msgs.find((x) => x.meta && x.meta.approvalId === approvalId);
        if (dead) { dead.meta.status = 'expired'; dead.meta.note = EXPIRED_GONE; }
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
      if (a.status !== 'expired') toast('Could not send answer: ' + e.message, 'warn');
      else toast('Answer did not land — ' + EXPIRED_GONE, 'warn');
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
    // In the attention view an empty Unfiled group would claim there are no
    // tasks at all; the "Approved commands" section below is the real content.
    if (unfiled.length > 0 || (!q && shown.length === 0 && !state.attentionOnly)) {
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

    // My Attention: the commands the user has already answered, newest last.
    if (state.attentionOnly) {
      const approved = approvedCommands();
      const li = document.createElement('li');
      li.className = 'workspace-item unfiled';
      li.innerHTML = `
        <div class="workspace-row">
          <span class="workspace-icon">✅</span>
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
        const cmd = approval.command || approval.action || 'action';
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
      const resp = await apiFetch('/api/repositories');
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
      dark: { bg: '#141414', panel: '#191919', surface: '#1F1F1F', text: '#EDEDED' },
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
      backendKind = null;
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

  // Delivered file preview close
  const fileDialog = $('file-dialog');
  if (fileDialog) {
    $('file-close').addEventListener('click', () => fileDialog.close());
    fileDialog.addEventListener('click', (e) => { if (e.target === fileDialog) fileDialog.close(); });
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
    if (LIVE_STATUSES.indexOf(t.status) !== -1) {
      if (t.backendId) {
        if (t.core) pollCore(t); else pollTask(t);
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