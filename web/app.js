// Fennec Workspace — full client: persistence, backend API, dynamic UI.
(function () {
  'use strict';

  const API_BASE = '';
  const STORAGE_KEY = 'fennec-coding-agent-history';

  // ── State ──────────────────────────────────────────────────────────────────
  let state = {
    tasks: [],
    activeId: null,
    queued: [],
    inspectorOpen: true,
    backendConnected: false,
    nextId: 1,
    agents: [],
    searchOpen: false,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const timeline = $('timeline');
  const taskList = $('task-list');
  const taskQueue = $('task-queue');
  const taskQueueList = $('task-queue-list');
  const taskQueueCount = $('task-queue-count');
  const composerInput = $('composer-input');
  const sendButton = $('send-button');
  const rightPanel = $('right-panel');
  const backendStatus = $('backend-status');
  const statusDot = document.querySelector('.status-dot');
  const agentCount = $('agent-count');
  const agentList = $('agent-list');
  const artifactCount = $('artifact-count');
  const attentionBadge = $('attention-badge');
  const timelineHeader = $('timeline-header');
  const timelineTitle = $('timeline-title');
  const timelineStatusText = $('timeline-status-text');
  const timelineStatus = $('timeline-status');
  const taskSearch = $('task-search');

  // ── Persistence ────────────────────────────────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state.tasks = parsed.tasks || [];
        state.activeId = parsed.activeId || null;
        state.nextId = (state.tasks.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;
      }
    } catch (_) { /* corrupt storage — start fresh */ }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tasks: state.tasks,
        activeId: state.activeId,
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
    div.textContent = text;
    return div.innerHTML;
  }

  function activeTask() {
    return state.tasks.find((t) => t.id === state.activeId) || null;
  }

  function isWorking() {
    const t = activeTask();
    return t && t.status === 'Running';
  }

  // ── Render: left panel — recent tasks ──────────────────────────────────────
  function renderTaskList() {
    taskList.innerHTML = '';
    if (state.tasks.length === 0) {
      taskList.innerHTML = '<li class="task-empty">No tasks yet. Type a prompt to start.</li>';
      return;
    }
    const shown = state.tasks.slice(-5).reverse();
    for (const tk of shown) {
      const li = document.createElement('li');
      li.className = 'task-item' + (tk.id === state.activeId ? ' active' : '');
      const dotClass = tk.status === 'Running' ? 'running' : tk.status === 'Complete' ? 'complete' : 'waiting';
      li.innerHTML = `
        <div class="task-item-title">${escapeHtml(tk.title)}</div>
        <div class="task-item-meta">
          <span class="task-status-dot ${dotClass}"></span>
          <span>${escapeHtml(tk.status)}</span>
          <span>·</span>
          <span>${escapeHtml(tk.repo)}</span>
        </div>`;
      li.addEventListener('click', () => switchTask(tk.id));
      taskList.appendChild(li);
    }
  }

  function switchTask(id) {
    state.activeId = id;
    saveState();
    renderAll();
  }

  // ── Render: center — timeline ──────────────────────────────────────────────
  function renderTimeline() {
    timeline.innerHTML = '';
    const task = activeTask();
    if (!task) return;

    for (const m of task.msgs) {
      timeline.appendChild(renderMessage(m));
    }
    timeline.scrollTop = timeline.scrollHeight;
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + m.kind;
    if (m.collapsed) wrap.classList.add('collapsed');

    const time = m.time || now();

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

      case 'think':
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1">
              <div class="message-avatar agent">F</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="message-time">${time}</span>
              <span class="action-label" style="color:var(--ok)">Thinking</span>
              <span class="collapse-indicator">▸</span>
            </div>
            <div class="message-body">${escapeHtml(m.content)}</div>
          </div>`;
        break;

      case 'action': {
        const title = (m.meta && m.meta.title) || 'Action';
        const dur = (m.meta && m.meta.duration) || '';
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header" data-toggle="1">
              <div class="message-avatar agent" style="background:var(--blue-dim)">🔍</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="message-time">${time}</span>
              <span class="action-label">${escapeHtml(title)}</span>
              <span class="message-status">Complete · ${escapeHtml(dur)}</span>
              <span class="collapse-indicator">▸</span>
            </div>
            <div class="message-body" style="font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(m.content)}</div>
          </div>`;
        break;
      }

      case 'attach': {
        const fn = (m.meta && m.meta.title) || 'file';
        const path = (m.meta && m.meta.path) || '';
        const size = (m.meta && m.meta.size) || '';
        wrap.innerHTML = `
          <div class="message-card">
            <div class="attachment-card">
              <span class="attachment-icon">📄</span>
              <div>
                <div class="attachment-name">${escapeHtml(fn)}</div>
                <div class="muted" style="font-size:11px">${escapeHtml(path)} · Markdown attachment</div>
              </div>
              <span class="attachment-size">${escapeHtml(size)}</span>
            </div>
          </div>`;
        break;
      }

      case 'edit': {
        const fn = (m.meta && m.meta.title) || 'file';
        const add = (m.meta && m.meta.add) || 0;
        const del = (m.meta && m.meta.del) || 0;
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <div class="message-avatar agent" style="background:var(--blue-dim)">📝</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="action-label">Edited 1 file</span>
              <button class="quiet-button review-btn" style="margin-left:auto">Review</button>
            </div>
            <div style="padding:8px 0;font-size:12px;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:space-between">
              <span>${escapeHtml(fn)}</span>
              <span><span style="color:var(--ok)">+${add}</span> <span style="color:var(--err);margin-left:8px">-${del}</span></span>
            </div>
          </div>`;
        break;
      }

      case 'result':
        wrap.innerHTML = `
          <div class="message-card">
            <div class="message-header">
              <div class="message-avatar agent" style="background:var(--ok-dim)">✓</div>
              <span class="message-author agent">${escapeHtml(m.author)}</span>
              <span class="message-time">${time}</span>
            </div>
            <div class="message-body">${escapeHtml(m.content)}</div>
          </div>`;
        break;
    }

    // Toggle collapse on header click
    const header = wrap.querySelector('[data-toggle]');
    if (header) {
      header.addEventListener('click', () => {
        wrap.classList.toggle('collapsed');
        m.collapsed = !m.collapsed;
        saveState();
      });
    }

    // Review button
    const reviewBtn = wrap.querySelector('.review-btn');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', () => {
        alert('Review diff: ' + ((m.meta && m.meta.title) || 'file'));
      });
    }

    return wrap;
  }

  // ── Render: task queue ─────────────────────────────────────────────────────
  function renderQueue() {
    taskQueueList.innerHTML = '';
    const show = state.queued.length > 0 && isWorking();
    taskQueue.hidden = !show;
    if (!show) return;

    for (let i = 0; i < state.queued.length; i++) {
      const li = document.createElement('li');
      li.className = 'task-queue-item';
      li.innerHTML = `
        <span class="queue-dot" style="background:var(--warn)"></span>
        <span class="queue-title">${escapeHtml(state.queued[i])}</span>
        <span class="queue-status">${i === 0 ? 'Next' : 'Queued'}</span>
        <button class="quiet-button queue-remove" data-idx="${i}" style="min-width:24px;padding:2px 6px;font-size:14px">✕</button>`;
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

  // ── Render: right panel ────────────────────────────────────────────────────
  function renderRightPanel() {
    const working = isWorking();
    const task = activeTask();
    const elapsed = task && task.startedAt ? formatElapsed(Date.now() - task.startedAt) : '00:00';
    const msgCount = task ? task.msgs.length : 0;

    // Active agents
    agentCount.textContent = working ? '1 online' : '0 online';
    const agentSection = document.querySelector('.agent-item');
    if (agentSection) {
      agentSection.style.display = working ? 'flex' : 'none';
      if (working) {
        agentSection.querySelector('.agent-task').textContent = task ? task.title : '';
        agentSection.querySelector('.agent-status').textContent = 'Running · ' + elapsed;
      }
    }

    // Processes
    const processValue = document.querySelector('.context-item:nth-child(2) .context-value');
    if (processValue) {
      processValue.textContent = msgCount + ' messages · stream ' + (working ? 'active' : 'idle');
      processValue.className = 'context-value ' + (working ? 'ok' : 'muted');
    }

    // Artifacts
    const attachCount = task ? task.msgs.filter((m) => m.kind === 'attach' || m.kind === 'edit').length : 0;
    if (artifactCount) artifactCount.textContent = attachCount + ' task artifacts';

    // Attention badge
    const attentionCount = task ? task.msgs.filter((m) => m.kind === 'result' && /error|fail|attention/i.test(m.content)).length : 0;
    if (attentionBadge) {
      if (attentionCount > 0) {
        attentionBadge.textContent = attentionCount;
        attentionBadge.hidden = false;
      } else {
        attentionBadge.hidden = true;
      }
    }

    // Backend status
    const envBackend = document.querySelectorAll('.env-value')[2];
    if (envBackend) {
      envBackend.textContent = state.backendConnected ? 'Connected' : 'Idle';
      envBackend.className = 'env-value ' + (state.backendConnected ? 'ok' : 'muted');
    }
  }

  function formatElapsed(ms) {
    const secs = Math.floor(ms / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
  }

  // ── Render all ─────────────────────────────────────────────────────────────
  function renderAll() {
    renderTaskList();
    renderTimeline();
    renderQueue();
    renderRightPanel();
  }

  // ── Send message ───────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = composerInput.value.trim();
    if (!text) return;
    composerInput.value = '';
    sendButton.disabled = true;

    // If AI is working, queue the message
    if (isWorking()) {
      state.queued.push(text);
      saveState();
      renderQueue();
      return;
    }

    // Clear queue
    state.queued = [];

    // Ensure task exists
    if (!state.activeId) {
      state.activeId = state.nextId++;
      state.tasks.push({
        id: state.activeId,
        title: 'New task',
        status: 'Running',
        repo: 'Liso7150/fennec',
        msgs: [],
        backendId: null,
        startedAt: Date.now(),
      });
    }

    const task = activeTask();
    task.title = text;
    task.status = 'Running';
    task.startedAt = Date.now();

    // Add user message
    task.msgs.push({
      id: state.nextId++,
      author: 'Liso7150',
      content: text,
      kind: 'user',
      time: now(),
      collapsed: false,
    });

    // Add thinking indicator (collapsed)
    const thinkId = state.nextId++;
    task.msgs.push({
      id: thinkId,
      author: 'Fennec',
      content: 'Connecting to engine…',
      kind: 'think',
      time: now(),
      collapsed: true,
    });

    saveState();
    renderAll();

    // Call backend
    try {
      const resp = await fetch(API_BASE + '/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: text, user_goal: text, repository_id: 'local' }),
      });

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const agentTask = await resp.json();
      task.backendId = agentTask.id;

      // Start task
      await fetch(API_BASE + '/api/tasks/' + agentTask.id + '/start', { method: 'POST' });

      // Send message
      const msgResp = await fetch(API_BASE + '/api/tasks/' + agentTask.id + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      if (!msgResp.ok) throw new Error('HTTP ' + msgResp.status);

      // Poll for completion
      let attempts = 0;
      while (attempts < 60) {
        await new Promise((r) => setTimeout(r, 500));
        const pollResp = await fetch(API_BASE + '/api/tasks/' + agentTask.id);
        if (!pollResp.ok) break;
        const pollTask = await pollResp.json();

        if (pollTask.status === 'Complete' || pollTask.status === 'Failed') {
          // Remove thinking indicator
          task.msgs = task.msgs.filter((m) => m.id !== thinkId);

          // Add assistant messages
          for (const bm of (pollTask.messages || [])) {
            if (bm.role === 'Fennec' || bm.role === 'fennec') {
              const content = typeof bm.content === 'string' ? bm.content : JSON.stringify(bm.content);
              if (content) {
                task.msgs.push({
                  id: state.nextId++,
                  author: 'Fennec',
                  content,
                  kind: 'result',
                  time: now(),
                  collapsed: false,
                });
              }
            }
          }

          task.status = pollTask.status;
          saveState();
          renderAll();
          break;
        }
        attempts++;
      }

      if (attempts >= 60) {
        task.msgs = task.msgs.filter((m) => m.id !== thinkId);
        task.msgs.push({
          id: state.nextId++,
          author: 'Fennec',
          content: 'Response timed out.',
          kind: 'result',
          time: now(),
          collapsed: false,
        });
        task.status = 'Failed';
        saveState();
        renderAll();
      }
    } catch (e) {
      // Backend offline
      task.msgs = task.msgs.filter((m) => m.id !== thinkId);
      task.msgs.push({
        id: state.nextId++,
        author: 'Fennec',
        content: 'Backend offline — start fennec-agent on :8787.',
        kind: 'result',
        time: now(),
        collapsed: false,
      });
      task.status = 'Failed';
      state.backendConnected = false;
      saveState();
      renderAll();
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
      case 'attention':
        // Scroll to first attention-worthy message
        const task = activeTask();
        if (task) {
          const idx = task.msgs.findIndex((m) => m.kind === 'result' && /error|fail|attention/i.test(m.content));
          if (idx >= 0) {
            const msgs = timeline.querySelectorAll('.message');
            if (msgs[idx]) msgs[idx].scrollIntoView({ behavior: 'smooth' });
          }
        }
        break;
      case 'search':
        composerInput.placeholder = 'Search tasks…';
        composerInput.focus();
        break;
      case 'coding':
        composerInput.placeholder = 'Ask Fennec to inspect, edit, test, or explain your code';
        break;
    }
  }

  // ── Inspector toggle ───────────────────────────────────────────────────────
  function toggleInspector() {
    state.inspectorOpen = !state.inspectorOpen;
    rightPanel.classList.toggle('collapsed', !state.inspectorOpen);
  }

  // ── Backend health check ───────────────────────────────────────────────────
  async function checkHealth() {
    try {
      const resp = await fetch(API_BASE + '/health');
      state.backendConnected = resp.ok;
    } catch (_) {
      state.backendConnected = false;
    }
    statusDot.setAttribute('data-state', state.backendConnected ? 'online' : 'error');
    backendStatus.textContent = state.backendConnected ? 'Backend connected' : 'Disconnected';
    renderRightPanel();
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  loadState();

  // Send button
  sendButton.addEventListener('click', sendMessage);
  composerInput.addEventListener('input', () => {
    sendButton.disabled = composerInput.value.trim().length === 0;
  });
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Nav buttons
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => handleNav(btn.dataset.nav));
  });

  // Inspector toggle
  $('inspector-toggle').addEventListener('click', toggleInspector);
  $('inspector-collapse').addEventListener('click', toggleInspector);

  // Tool buttons
  $('btn-add').addEventListener('click', () => {
    composerInput.placeholder = 'Type a command…';
    composerInput.focus();
  });
  $('btn-attach').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', () => {
      if (input.files.length > 0) {
        const task = activeTask();
        if (task) {
          task.msgs.push({
            id: state.nextId++,
            author: 'Liso7150',
            content: 'Attached: ' + input.files[0].name,
            kind: 'attach',
            time: now(),
            collapsed: false,
            meta: { title: input.files[0].name, path: '.', size: formatFileSize(input.files[0].size) },
          });
          saveState();
          renderAll();
        }
      }
    });
    input.click();
  });
  $('btn-dictate').addEventListener('click', () => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.lang = 'en-US';
      rec.onresult = (e) => {
        composerInput.value += e.results[0][0].transcript;
        sendButton.disabled = false;
      };
      rec.start();
    } else {
      alert('Speech recognition not supported in this browser.');
    }
  });

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Settings dialog
  const settingsDialog = $('settings-dialog');
  if (settingsDialog) {
    $('settings-button').addEventListener('click', () => settingsDialog.showModal());
    $('settings-close').addEventListener('click', () => settingsDialog.close());
    settingsDialog.addEventListener('click', (e) => {
      if (e.target === settingsDialog) settingsDialog.close();
    });

    // Tab switching
    const tabs = settingsDialog.querySelectorAll('.settings-tab');
    const panels = settingsDialog.querySelectorAll('.settings-panel');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        tabs.forEach((t) => t.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = settingsDialog.querySelector(`#panel-${target}`);
        if (panel) panel.classList.add('active');
      });
    });

    // Theme selection
    const themeItems = settingsDialog.querySelectorAll('.theme-item');
    themeItems.forEach((item) => {
      item.addEventListener('click', () => {
        themeItems.forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        const theme = item.dataset.theme;
        applyTheme(theme);
      });
    });
  }

  // Theme application
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

  // Load saved theme
  const savedTheme = localStorage.getItem('fennec-theme') || 'dark';
  applyTheme(savedTheme);
  const savedThemeItem = document.querySelector(`.theme-item[data-theme="${savedTheme}"]`);
  if (savedThemeItem) savedThemeItem.classList.add('active');

  // Permission mode switching
  const permBtns = document.querySelectorAll('.permission-btn');
  permBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      permBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      localStorage.setItem('fennec-permission-mode', mode);
    });
  });

  // Load saved permission mode
  const savedPerm = localStorage.getItem('fennec-permission-mode') || 'ask';
  const savedPermBtn = document.querySelector(`.permission-btn[data-mode="${savedPerm}"]`);
  if (savedPermBtn) {
    permBtns.forEach((b) => b.classList.remove('active'));
    savedPermBtn.classList.add('active');
  }

  // Initial render
  renderAll();
  checkHealth();

  // Periodic health check
  setInterval(checkHealth, 30000);

  // Elapsed timer update
  setInterval(() => {
    if (isWorking()) renderRightPanel();
  }, 1000);
})();
