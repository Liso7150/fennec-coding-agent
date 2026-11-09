/* Colibri Coding Agent — interaction layer. All markup is pre-rendered by the
   Python component modules; this script swaps views and drives the mock agent. */
(() => {
  const state = JSON.parse(document.getElementById('app-state').textContent);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const stage = $('#stage');
  const header = $('#headerInner');
  const scroll = $('#scrollArea');
  const input = $('#composerInput');
  const sendBtn = $('#sendBtn');
  const toastEl = $('#toast');
  const toastText = $('#toastText');
  const backdrop = $('#backdrop');
  const modal = $('#modalBackdrop');
  const modalBody = $('#modalBody');
  const modalFile = $('#modalFile');

  let currentTask = state.activeTask;
  let view = 'coding';
  let processing = false;
  let toastTimer = null;

  const clock = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  function toast(message) {
    toastText.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  const bottom = () => { scroll.scrollTop = scroll.scrollHeight; };
  const closeMenus = () => {
    $('#moreMenu')?.classList.remove('open');
    $('#modelMenu')?.classList.remove('open');
  };
  const closeDrawers = () => {
    $('#leftPane')?.classList.remove('open');
    $('#rightPane')?.classList.remove('open');
    backdrop.classList.remove('show');
  };
  const setNav = key => $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === key));
  const setRow = id => $$('.task-row').forEach(el => el.classList.toggle('active', el.dataset.task === id));
  const setHeader = key => { header.innerHTML = state.headers[key]; };

  function setStage(html) {
    stage.innerHTML = html;
    bottom();
  }

  function openTask(id) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    currentTask = id;
    view = 'coding';
    setHeader(id);
    setStage(task.html);
    setNav('coding');
    setRow(id);
    closeDrawers();
    closeMenus();
  }

  function openView(key) {
    view = key;
    setHeader(key);
    setStage(state.views[key]);
    setNav(key);
    setRow(null);
    closeDrawers();
    closeMenus();
    if (key === 'search') setTimeout(() => $('#searchInput')?.focus(), 60);
  }

  function startNew() {
    view = 'new';
    setHeader('new');
    setStage(state.views.new);
    setNav('new');
    setRow(null);
    closeDrawers();
    closeMenus();
    input.focus();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 170) + 'px';
  }

  function updateSend() {
    sendBtn.disabled = processing || !input.value.trim();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
      area.remove();
      return ok;
    }
  }

  function openArtifact(name) {
    if (!name || !state.previews[name]) return;
    modalFile.textContent = name;
    modalBody.innerHTML = state.previews[name];
    modal.classList.add('open');
  }

  function pickReply(text) {
    const t = text.toLowerCase();
    if (/(test|pytest|suite|verify|green)/.test(t)) return state.replies.test;
    if (/(package|installer|build|exe|ship|bundle)/.test(t)) return state.replies.package;
    if (/(index|search|embedding|retriev)/.test(t)) return state.replies.index;
    if (/(stream|chunk|out.of.order|state)/.test(t)) return state.replies.stream;
    return state.replies.default;
  }

  function appendUser(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg user fade-in';
    wrap.innerHTML = '<div class="msg-user-card"><div class="msg-meta">'
      + '<span class="who">You</span><span>' + clock() + '</span></div><p></p></div>';
    wrap.querySelector('p').textContent = text;
    let tl = stage.querySelector('.timeline');
    if (!tl) {
      tl = document.createElement('div');
      tl.className = 'timeline';
      stage.innerHTML = '';
      stage.appendChild(tl);
    }
    tl.appendChild(wrap);
    bottom();
  }

  function send() {
    const text = input.value.trim();
    if (!text || processing) return;

    if (view === 'attention' || view === 'search') openTask(currentTask);
    if (view === 'new') {
      const titleEl = header.querySelector('.task-title-main');
      if (titleEl) titleEl.textContent = text.length > 64 ? text.slice(0, 61) + '…' : text;
      const lineEl = header.querySelector('.task-status-line');
      if (lineEl) lineEl.textContent = 'Agent is planning and executing your request.';
      const pill = header.querySelector('.pill');
      if (pill) { pill.className = 'pill running'; pill.innerHTML = '<span class="pulse"></span>Running'; }
      stage.innerHTML = '<div class="timeline"></div>';
      view = 'coding';
      currentTask = null;
      setNav('coding');
      setRow(null);
    }

    processing = true;
    updateSend();
    sendBtn.classList.add('processing');
    appendUser(text);
    input.value = '';
    autosize();

    const tl = stage.querySelector('.timeline');
    const typing = document.createElement('div');
    typing.className = 'msg assistant fade-in';
    typing.innerHTML = '<div class="msg-head"><span class="agent-mark">C</span>'
      + '<span class="who">Colibri</span><span class="time">' + clock() + '</span></div>'
      + '<div class="typing-dots"><i></i><i></i><i></i></div>';
    tl.appendChild(typing);
    bottom();

    const replies = pickReply(text);
    let delay = 900;
    replies.forEach((html, index) => {
      setTimeout(() => {
        typing.remove();
        tl.insertAdjacentHTML('beforeend', html.replaceAll('{{now}}', clock()));
        bottom();
        if (index === replies.length - 1) {
          $$('.tool-card.running', tl).forEach(card => card.remove());
          processing = false;
          sendBtn.classList.remove('processing');
          updateSend();
        }
      }, delay);
      delay += 650 + index * 180;
    });
  }

  /* ------------------------------- events ------------------------------- */
  document.addEventListener('click', event => {
    const target = event.target;

    const taskEl = target.closest('[data-task]');
    if (taskEl) { openTask(taskEl.dataset.task); return; }

    const viewEl = target.closest('[data-view]');
    if (viewEl) {
      const key = viewEl.dataset.view;
      if (key === 'coding') { currentTask ? openTask(currentTask) : startNew(); }
      else if (key === 'new') startNew();
      else openView(key);
      return;
    }

    const modelEl = target.closest('[data-model]');
    if (modelEl) {
      const label = $('#modelLabel');
      if (label) label.textContent = modelEl.dataset.modelName;
      $$('#modelMenu [data-model]').forEach(el => el.classList.toggle('selected', el === modelEl));
      $$('.env-row').forEach(row => {
        if (row.querySelector('.k')?.textContent.trim() === 'Local model') {
          const value = row.querySelector('.v');
          if (value) value.textContent = modelEl.dataset.modelName;
        }
      });
      $('#modelMenu')?.classList.remove('open');
      toast('Model switched to ' + modelEl.dataset.modelName + ' (demo).');
      return;
    }

    const starter = target.closest('[data-starter]');
    if (starter) {
      input.value = starter.dataset.starter;
      autosize();
      updateSend();
      input.focus();
      toast('Starter prompt loaded — press send to run it.');
      return;
    }

    const hint = target.closest('[data-toast]');
    if (hint) { toast(hint.dataset.toast); return; }

    const actionEl = target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'share') {
        copyText('https://colibri.local/tasks/' + (currentTask || 'new')).then(ok =>
          toast(ok ? 'Task link copied to clipboard.' : 'Share link is simulated in this demo.'));
      } else if (action === 'more') {
        $('#moreMenu')?.classList.toggle('open');
      } else if (action === 'ctx-toggle') {
        $('#rightPane')?.classList.toggle('open');
        backdrop.classList.toggle('show');
      } else if (action === 'menu-toggle') {
        $('#leftPane')?.classList.toggle('open');
        backdrop.classList.toggle('show');
      } else if (action === 'close-modal') {
        modal.classList.remove('open');
      } else if (action === 'artifact') {
        openArtifact(actionEl.dataset.artifact);
      } else if (action === 'copy') {
        const card = actionEl.closest('.code-card');
        const source = card?.querySelector('.copy-src');
        if (source) {
          copyText(source.value).then(ok => {
            const previous = actionEl.innerHTML;
            actionEl.textContent = ok ? 'Copied' : 'Copy failed';
            setTimeout(() => { actionEl.innerHTML = previous; }, 1400);
          });
        }
      } else if (action === 'send') {
        send();
      } else if (action === 'web') {
        actionEl.classList.toggle('active');
        toast('Web search ' + (actionEl.classList.contains('active') ? 'enabled' : 'disabled') + ' (demo).');
      } else if (action === 'toggle-tools') {
        actionEl.classList.toggle('on');
        toast('Local tools ' + (actionEl.classList.contains('on') ? 'enabled' : 'disabled') + ' (demo).');
      } else if (action === 'clear') {
        stage.innerHTML = '<div class="timeline"><div class="empty-note">'
          + 'Transcript cleared. Send a message to continue.</div></div>';
        closeMenus();
        toast('Transcript cleared.');
      } else if (action === 'rename') {
        closeMenus();
        toast('Rename is simulated in this demo.');
      } else if (action === 'duplicate') {
        closeMenus();
        toast('Task duplicated (demo).');
      } else if (action === 'export') {
        closeMenus();
        toast('Session log exported (demo).');
      }
      return;
    }

    if (!target.closest('.header-actions')) closeMenus();
    if (target === backdrop) closeDrawers();
    if (target === modal) modal.classList.remove('open');
  });

  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openView('search');
    }
    if (event.key === 'Escape') {
      closeMenus();
      closeDrawers();
      modal.classList.remove('open');
    }
  });

  input?.addEventListener('input', () => { autosize(); updateSend(); });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  $('#modelBtn')?.addEventListener('click', () => $('#modelMenu')?.classList.toggle('open'));

  $('#searchInput')?.addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    let shown = 0;
    $$('#searchResults .search-result').forEach(row => {
      const match = !query || (row.dataset.search || '').toLowerCase().includes(query);
      row.style.display = match ? '' : 'none';
      if (match) shown += 1;
    });
    const empty = $('#searchEmpty');
    if (empty) empty.style.display = shown ? 'none' : '';
  });

  autosize();
  updateSend();
  bottom();
})();
