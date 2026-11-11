import { ApiError, LIMITS, createApi, redact, normalizePath, parentPath, parseListing, parseChat, parseStt, parsePoll, pollWithinBounds, canInstallSecurely, delay, isImageDataUrl } from './helpers.js?v=2';

const $ = id => document.getElementById(id);
const VERSION = '1.8.0';
const TOKEN_KEY = 'fennec.workspace.tab-token';
let token = '';
try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* Storage is optional. */ }
$('token').value = token;
$('remember-token').checked = Boolean(token);
$('server-origin').textContent = location.origin;
const api = createApi({ origin: location.origin, getToken: () => token });
const sessions = [];
let current;
let connected = false;
let engineReady = false;
let engineStarting = false;
let connecting = false;
let healthTimer;
let healthController;
let fileController;
let fileBusy = false;
let directory = '';
let activeRun = null;
let installPrompt = null;
let sequence = 0;
let attachments = [];
let imageAttachment = null;
let recording = null;
let sttBusy = false;
let speech = null;
let noticeTimer;

const safe = value => redact(value, token);
function showError(id, message = '') {
  $(id).textContent = safe(message);
  $(id).hidden = !message;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = safe(text);
  return element;
}
function showNotice(message = '') {
  clearTimeout(noticeTimer);
  $('composer-notice').textContent = safe(message);
  $('composer-notice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => showNotice(), 15000);
}
function renderChips() {
  const box = $('attachment-chips');
  box.replaceChildren();
  const chips = attachments.map(file => ({
    kind: 'text', name: file.name,
    remove: () => { attachments = attachments.filter(entry => entry !== file); renderChips(); },
  }));
  if (imageAttachment) chips.push({
    kind: 'image', name: imageAttachment.name, src: imageAttachment.dataUrl,
    remove: () => { imageAttachment = null; renderChips(); },
  });
  for (const chip of chips) {
    const element = node('span', `chip chip-${chip.kind}`);
    if (chip.src) {
      const preview = node('img', 'chip-preview');
      preview.src = chip.src; preview.alt = '';
      element.append(preview);
    }
    element.append(node('span', 'chip-name', chip.name));
    const remove = node('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${chip.name}`);
    remove.addEventListener('click', chip.remove);
    element.append(remove);
    box.append(element);
  }
  box.hidden = !chips.length;
  updateControls();
}
function clearAttachments() {
  attachments = [];
  imageAttachment = null;
  renderChips();
}
function updateMic() {
  const button = $('mic-button');
  button.textContent = recording ? 'Stop dictation' : sttBusy ? 'Transcribing…' : 'Mic';
  button.classList.toggle('recording', Boolean(recording));
  button.disabled = Boolean(activeRun) || sttBusy || !connected || !navigator.onLine;
}
async function addTextFile(file) {
  showNotice();
  if (file.size > 1_000_000) { showNotice('Text attachments must be at most 1 MB.'); return; }
  if (attachments.length >= 3) { showNotice('At most three text attachments per message.'); return; }
  try {
    const text = await file.text();
    if (text.includes('\0')) { showNotice('That looks like a binary file; attach text or an image.'); return; }
    const content = text.length > 24000 ? `${text.slice(0, 24000)}\n… truncated` : text;
    attachments = [...attachments.filter(entry => entry.name !== file.name), { name: file.name.slice(0, 120), content }];
    renderChips();
  } catch (error) {
    showNotice(`Could not read that file: ${error.message}`);
  }
}
async function addImageFile(file) {
  showNotice();
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) { showNotice('Use a PNG, JPEG, WebP or GIF image.'); return; }
  if (file.size > LIMITS.imageBytes) { showNotice('Images must be at most 6 MB.'); return; }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    if (!isImageDataUrl(dataUrl)) throw new Error('the browser produced an unexpected data URL');
    imageAttachment = { name: file.name.slice(0, 120), dataUrl };
    renderChips();
  } catch (error) {
    showNotice(`Could not read that image: ${error.message}`);
  }
}
function stopSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (speech) speech.button.textContent = 'Read aloud';
  speech = null;
}
function toggleSpeech(item, button) {
  if (!('speechSynthesis' in window)) { showNotice('This browser has no speech synthesis.'); return; }
  if (speech?.id === item.id) { stopSpeech(); return; }
  stopSpeech();
  const text = String(item.content || '').replace(/```[\s\S]*?```/g, ' code block ').slice(0, 20000);
  if (!text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.03;
  utterance.lang = 'en-US';
  utterance.onend = utterance.onerror = () => { if (speech?.id === item.id) stopSpeech(); };
  speech = { id: item.id, button };
  button.textContent = 'Stop reading';
  window.speechSynthesis.speak(utterance);
}
async function toggleMic() {
  showNotice();
  if (recording) { recording.recorder.stop(); return; }
  if (!connected || !navigator.onLine) { showNotice('Connect to the server before dictating.'); return; }
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) { showNotice('This browser cannot record audio.'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      recording = null; updateControls(); updateMic();
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (!blob.size || !connected) return;
      sttBusy = true; updateControls(); updateMic();
      try {
        const data = await api('/api/stt', {
          method: 'POST', body: blob, raw: true, contentType: blob.type || 'audio/webm',
          timeout: 180000, allowEmpty: true,
        });
        const transcript = parseStt(data);
        if (transcript.text) {
          const existing = $('prompt').value;
          $('prompt').value = `${existing.trimEnd()}${existing.trim() ? ' ' : ''}${transcript.text}`.slice(0, 32000);
          $('prompt').focus();
        } else showNotice('No speech was recognized.');
      } catch (error) {
        reportApiFailure(error);
        showNotice(`Speech recognition failed: ${error.message}`);
      } finally {
        sttBusy = false; updateControls(); updateMic();
      }
    };
    recorder.start();
    recording = { recorder, stream };
    updateControls(); updateMic();
  } catch (error) {
    showNotice(`Microphone unavailable: ${error.message}`);
  }
}
function setStatus(message, session = current) {
  session.status = safe(message);
  if (session === current) $('run-status').textContent = session.status;
}
function updateControls() {
  const busy = Boolean(activeRun);
  $('send-button').disabled = busy || !connected || !navigator.onLine || !$('prompt').value.trim() || connecting || engineStarting;
  $('prompt').disabled = busy;
  for (const id of ['mode-chat', 'mode-agent', 'new-session', 'clear-sessions', 'allow-write', 'allow-shell', 'max-tokens', 'temperature', 'thinking', 'attach-button', 'image-button']) $(id).disabled = busy;
  updateMic();
  const locked = busy && activeRun.phase !== 'pending';
  for (const id of ['token', 'remember-token', 'connect-button', 'disconnect-button']) $(id).disabled = connecting || locked;
  $('refresh-status').disabled = connecting || !connected;
  $('stop-button').hidden = !busy;
  $('stop-button').disabled = activeRun?.cancelBusy || activeRun?.stopRequested && activeRun?.phase === 'starting';
  $('stop-button').textContent = activeRun?.phase === 'pending' ? 'Retry cancel' : activeRun?.phase === 'starting' && activeRun.stopRequested ? 'Waiting for task ID…' : activeRun?.cancelBusy ? 'Cancelling…' : 'Stop';
  for (const id of ['files-refresh', 'directory-open']) $(id).disabled = !connected || fileBusy;
  $('files-up').disabled = !connected || fileBusy || !directory;
  $('session-list').querySelectorAll('button').forEach(button => { button.disabled = busy; });
}
function connectionState(message, state = 'offline') {
  $('connection-badge').textContent = message;
  $('connection-badge').dataset.state = state;
  $('connection-notice').textContent = !navigator.onLine ? 'Offline shell only. Inference and server files need a connection; nothing is queued.' : !connected ? 'Not connected to the server. Inference needs a connection; messages are not queued.' : !engineReady ? 'Server connected, engine offline. It starts on this device when you send a message.' : 'Connected to your server. Inference runs on this device; workspace files stay there too.';
  updateControls();
}
function resetPermissions() {
  $('allow-write').checked = false;
  $('allow-shell').checked = false;
}
function renderSessions() {
  $('session-list').replaceChildren();
  for (const session of [...sessions].reverse()) {
    const item = node('li');
    const button = node('button', session === current ? 'active' : '');
    button.type = 'button';
    button.append(node('small', '', session.mode.toUpperCase()), document.createTextNode(safe(session.title)));
    button.setAttribute('aria-current', session === current ? 'true' : 'false');
    button.addEventListener('click', () => { if (!activeRun) { current = session; renderSession(); closeMenu(); } });
    item.append(button);
    $('session-list').append(item);
  }
  updateControls();
}
function newSession(mode = 'chat') {
  if (activeRun) return;
  stopSpeech();
  clearAttachments();
  showNotice();
  current = { id: ++sequence, mode, title: 'New session', messages: [], items: [], status: 'Ready when connected' };
  sessions.push(current);
  if (sessions.length > 20) sessions.shift();
  $('prompt').value = '';
  renderSession();
}
function renderWelcome() {
  const welcome = node('div', 'welcome');
  const image = node('img', 'welcome-mark');
  image.src = './icons/icon.svg?v=1'; image.alt = ''; image.width = 56; image.height = 56;
  welcome.append(image, node('h2', '', 'From an idea to a next step.'), node('p', '', 'Ask a question in Chat, or give the Agent a focused task. See what it actually does, one tool result at a time.'), node('p', 'welcome-hint', 'Start read-only. You decide whether each agent run may write files or execute commands. No simulated activity, no automatic approvals.'));
  $('timeline').append(welcome);
}
function renderItem(item) {
  if (item.type === 'tool') {
    const card = node('details', 'tool-card');
    card.dataset.ok = String(item.ok);
    card.open = item.ok === false;
    const outcome = item.ok === true ? 'Server reports OK' : item.ok === false ? 'Server reports failure' : 'Outcome not reported';
    card.append(node('summary', '', `${item.name || 'Tool'} · ${outcome}`));
    for (const [label, value] of [['Arguments', item.args], ['Result', item.result]]) {
      card.append(node('div', 'tool-caption', label), node('pre', '', value === undefined ? 'Not provided by server.' : value));
    }
    if (item.content) card.append(node('pre', '', item.content));
    return card;
  }
  const message = node('article', `message ${item.type}`);
  const labels = { user: 'You', assistant: 'Fennec', final: 'Fennec · final response', error: 'Error', system: 'Session' };
  message.append(node('div', 'message-label', labels[item.type] || item.type));
  if (item.reasoning) {
    const reasoning = node('details', 'reasoning-card');
    reasoning.append(node('summary', '', 'Reasoning'), node('pre', '', item.reasoning));
    message.append(reasoning);
  }
  if (item.image && isImageDataUrl(item.image)) {
    const preview = node('img', 'message-image');
    preview.src = item.image;
    preview.alt = item.imageName || 'Attached image';
    message.append(preview);
  }
  message.append(node('div', 'message-body', item.content || '(Empty event from server.)'));
  if (['assistant', 'final'].includes(item.type) && item.content) {
    const actions = node('div', 'message-actions');
    const button = node('button', 'text-button', 'Read aloud');
    button.type = 'button';
    button.addEventListener('click', () => toggleSpeech(item, button));
    actions.append(button);
    message.append(actions);
  }
  return message;
}
function renderSession() {
  resetPermissions();
  $('timeline').replaceChildren();
  if (!current.items.length) renderWelcome();
  else current.items.forEach(item => $('timeline').append(renderItem(item)));
  $('session-title').textContent = current.title === 'New session' ? 'A little space to build.' : current.title;
  $('run-status').textContent = current.status;
  const agent = current.mode === 'agent';
  $('mode-caption').textContent = agent ? 'AGENT' : 'CHAT';
  for (const mode of ['chat', 'agent']) {
    $(`mode-${mode}`).classList.toggle('active', current.mode === mode);
    $(`mode-${mode}`).setAttribute('aria-pressed', String(current.mode === mode));
  }
  $('mode-description').textContent = agent ? 'Real tools. Explicit permissions.' : 'Talk to the engine. No tools.';
  $('agent-permissions').hidden = !agent;
  $('generation-settings').hidden = agent;
  $('max-tokens').required = !agent;
  $('temperature').required = !agent;
  $('agent-limit').hidden = !agent;
  $('send-button').replaceChildren(document.createTextNode(agent ? 'Run agent ↑' : 'Send message ↑'));
  $('prompt').placeholder = agent ? 'Describe a focused task for your server workspace…' : 'What would you like to work on?';
  showError('composer-error');
  renderSessions();
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
function appendItem(session, event) {
  const item = { type: event.type, id: ++sequence, ok: event.ok };
  // Keep only bounded, redacted display strings, never executable markup.
  for (const key of ['content', 'name', 'args', 'result', 'reasoning']) {
    if (event[key] !== undefined) {
      const text = safe(event[key]);
      item[key] = text.length > 64000 ? `${text.slice(0, 64000)}\n[Display truncated at 64,000 characters.]` : text;
    }
  }
  if (typeof event.image === 'string' && isImageDataUrl(event.image)) {
    item.image = event.image;
    item.imageName = typeof event.imageName === 'string' ? event.imageName.slice(0, 120) : 'Attached image';
  }
  session.items.push(item);
  const trimmed = session.items.length > 400;
  if (trimmed) session.items.shift();
  if (session === current) {
    const timeline = $('timeline');
    const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 100;
    timeline.querySelector('.welcome')?.remove();
    if (trimmed) timeline.firstElementChild?.remove();
    timeline.append(renderItem(item));
    if (atBottom || item.type === 'user') timeline.scrollTop = timeline.scrollHeight;
  }
}
function finishRun(run, message) {
  if (activeRun !== run) return;
  setStatus(message, run.session);
  activeRun = null;
  resetPermissions();
  updateControls();
  $('prompt').focus();
}
function pendingCancellation(run, message) {
  if (activeRun !== run) return;
  run.controller.abort();
  run.phase = 'pending';
  run.cancelBusy = false;
  appendItem(run.session, { type: 'error', content: message });
  setStatus('Cancellation unconfirmed', run.session);
  showError('composer-error', 'This task may still run on the server. Reconnect if needed, then Retry cancel. New submissions are blocked until a terminal status is confirmed.');
  updateControls();
}
function reportApiFailure(error) {
  if (error.status === 401 || error.status === 403 || ['NETWORK', 'TIMEOUT'].includes(error.code)) {
    connected = false; engineReady = false; clearTimeout(healthTimer);
    connectionState(error.status ? 'Access denied' : 'Connection lost', 'error');
    showError('connect-error', error.message);
  }
}

async function refreshHealth() {
  clearTimeout(healthTimer);
  healthController?.abort();
  const controller = new AbortController();
  healthController = controller;
  try {
    const health = await api('/api/health', { signal: controller.signal, timeout: 10000 });
    if (controller.signal.aborted) return;
    if (health.app !== 'Fennec' || typeof health.engine_running !== 'boolean') throw new Error('This origin did not return a valid Fennec health response.');
    connected = true; engineReady = health.engine_running;
    $('workspace-root').textContent = safe(typeof health.workspace === 'string' ? health.workspace : 'Root configured on the server');
    connectionState(engineReady ? 'Engine online' : 'Engine offline', engineReady ? 'online' : 'offline');
    showError('connect-error');
    try {
      const telemetry = await api('/api/engine', { signal: controller.signal, timeout: 10000 });
      if (!controller.signal.aborted) $('engine-telemetry').textContent = safe(telemetry);
    } catch (error) {
      if (controller.signal.aborted) return;
      $('engine-telemetry').textContent = safe(`Telemetry unavailable: ${error.message}`);
      reportApiFailure(error);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    connected = false; engineReady = false;
    connectionState('Not connected', 'error');
    showError('connect-error', error.message);
  } finally {
    if (!controller.signal.aborted && connected) healthTimer = setTimeout(refreshHealth, 15000);
    updateControls();
  }
}
async function connect(event) {
  event?.preventDefault();
  if (connecting || activeRun && activeRun.phase !== 'pending') return;
  const nextToken = $('token').value.trim();
  if (/[\x00-\x1f\x7f]/.test(nextToken)) { showError('connect-error', 'Token contains invalid characters.'); return; }
  token = nextToken;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    if ($('remember-token').checked && token) sessionStorage.setItem(TOKEN_KEY, token);
  } catch { $('remember-token').checked = false; }
  // Do not leave the token in a form control once connected.
  $('token').value = '';
  $('token').placeholder = token ? 'Token set · enter again to replace' : 'Enter server bearer token';
  connecting = true;
  updateControls();
  await refreshHealth();
  connecting = false;
  updateControls();
  if (connected) {
    closeMenu();
    await loadDirectory(directory);
  }
}
function disconnect() {
  if (activeRun && activeRun.phase !== 'pending') return;
  if (recording) { recording.recorder.stop(); }
  stopSpeech();
  healthController?.abort(); fileController?.abort(); clearTimeout(healthTimer);
  connected = false; engineReady = false; token = ''; fileBusy = false;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Optional storage. */ }
  $('token').value = ''; $('token').placeholder = 'Enter server bearer token'; $('remember-token').checked = false;
  $('workspace-root').textContent = 'Root set by the server';
  $('engine-telemetry').textContent = 'Disconnected.';
  $('file-list').replaceChildren(node('li', 'empty-files', 'Connect to inspect files.'));
  $('file-name').textContent = 'No file selected'; $('file-content').textContent = 'Disconnected. No files are cached.';
  showError('connect-error'); showError('files-error');
  connectionState('Disconnected');
}

async function loadDirectory(path) {
  if (!connected) return;
  let normalized;
  try { normalized = normalizePath(path); } catch (error) { showError('files-error', error.message); return; }
  fileController?.abort();
  const controller = new AbortController(); fileController = controller;
  fileBusy = true; updateControls(); showError('files-error');
  $('file-list').replaceChildren(node('li', 'empty-files', 'Loading directory…'));
  $('file-name').textContent = 'No file selected'; $('file-content').textContent = 'Select a file to view its text.';
  try {
    const data = await api(`/api/files?${new URLSearchParams({ path: normalized })}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const entries = parseListing(data, normalized);
    directory = normalized; $('directory-path').value = directory; $('directory-label').textContent = `/${directory}`;
    $('file-list').replaceChildren();
    for (const entry of entries) {
      const item = node('li'); const button = node('button'); button.type = 'button';
      button.append(node('span', '', entry.directory ? 'DIR' : 'FILE'), node('span', '', entry.name));
      button.addEventListener('click', () => entry.directory ? loadDirectory(entry.path) : loadFile(entry.path));
      item.append(button); $('file-list').append(item);
    }
    if (!entries.length) $('file-list').append(node('li', 'empty-files', 'This directory is empty.'));
  } catch (error) {
    if (controller.signal.aborted) return;
    $('file-list').replaceChildren(node('li', 'empty-files', 'Directory not loaded.'));
    showError('files-error', error.message); reportApiFailure(error);
  } finally {
    if (fileController === controller) { fileBusy = false; updateControls(); }
  }
}
async function loadFile(path) {
  if (!connected) return;
  fileController?.abort();
  const controller = new AbortController(); fileController = controller;
  fileBusy = true; updateControls(); showError('files-error');
  $('file-name').textContent = safe(path); $('file-content').textContent = 'Loading…';
  try {
    const normalized = normalizePath(path);
    const data = await api(`/api/file?${new URLSearchParams({ path: normalized })}`, { text: true, signal: controller.signal });
    if (controller.signal.aborted) return;
    const content = typeof data === 'string' ? data : data?.content;
    if (typeof content !== 'string') throw new Error('This file has no text content. Binary previews are not supported.');
    if (content.includes('\0')) throw new Error('Binary file preview is not supported.');
    $('file-content').textContent = safe(content || '(Empty file.)') + (data?.truncated ? '\n[Content truncated by server.]' : '');
  } catch (error) {
    if (controller.signal.aborted) return;
    $('file-content').textContent = 'File not loaded.';
    showError('files-error', error.message); reportApiFailure(error);
  } finally {
    if (fileController === controller) { fileBusy = false; updateControls(); }
  }
}

async function pollAgent(run, cancelling = false) {
  const controller = run.controller;
  const cancelStart = Date.now();
  let cancelPolls = 0;
  while (activeRun === run && !controller.signal.aborted) {
    if (cancelling ? cancelPolls >= 12 || Date.now() - cancelStart >= 30000 : !pollWithinBounds(run.polls, run.started)) {
      if (cancelling) pendingCancellation(run, 'Cancellation was requested, but no terminal status was confirmed within the monitoring limit.');
      else await cancelRun(run, 'Monitoring reached its limit (300 polls / 10 minutes). Requesting cancellation.');
      return;
    }
    if (cancelling) cancelPolls++; else run.polls++;
    try {
      const data = await api(`/api/agent/poll?${new URLSearchParams({ id: run.id, after: String(run.after) })}`, { signal: controller.signal, timeout: 15000 });
      if (controller.signal.aborted || activeRun !== run) return;
      const poll = parsePoll(data, run.id, run.after);
      for (const event of poll.events) {
        if (event.type === 'assistant' && !String(event.content || '').trim() && (event.tool_calls || []).length) continue;
        appendItem(run.session, event);
        if (['assistant', 'final'].includes(event.type) && typeof event.content === 'string' && event.content.trim()) run.hasOutput = true;
      }
      run.after = poll.next;
      setStatus(`Agent: ${poll.status}`, run.session);
      if (poll.terminal) {
        appendItem(run.session, { type: 'system', content: `Server status: ${poll.status}.${!run.hasOutput ? ' No assistant text was returned.' : ''}${poll.usage ? `\nUsage: ${safe(poll.usage)}` : ''}` });
        showError('composer-error');
        finishRun(run, `Agent: ${poll.status}`);
        return;
      }
      await delay(LIMITS.pollMs, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || activeRun !== run) return;
      reportApiFailure(error);
      if (cancelling) pendingCancellation(run, `Could not confirm cancellation: ${error.message}`);
      else await cancelRun(run, `Monitoring failed: ${error.message}`);
      return;
    }
  }
}
async function cancelRun(run, reason = 'Stop requested. Requesting server cancellation.') {
  if (activeRun !== run || run.cancelBusy) return;
  run.stopRequested = true;
  if (!run.id) {
    setStatus('Stopping after task ID arrives', run.session);
    showError('composer-error', 'Waiting for the start response so the task ID can be cancelled. Do not close this tab yet.');
    updateControls();
    return;
  }
  run.controller.abort();
  run.cancelBusy = true; run.phase = 'stopping';
  appendItem(run.session, { type: 'system', content: reason });
  setStatus('Requesting cancellation', run.session); updateControls();
  try {
    await api('/api/agent/cancel', { method: 'POST', body: { id: run.id }, timeout: 10000, allowEmpty: true });
    if (activeRun !== run) return;
    appendItem(run.session, { type: 'system', content: 'Cancellation request accepted. Waiting for a terminal server status; a running command may not stop immediately.' });
    run.controller = new AbortController();
    await pollAgent(run, true);
  } catch (error) {
    reportApiFailure(error);
    pendingCancellation(run, `Cancellation not confirmed: ${error.message}`);
  } finally {
    run.cancelBusy = false; updateControls();
  }
}
async function stopRun() {
  const run = activeRun;
  if (!run) return;
  if (run.phase === 'engine') {
    run.controller.abort();
    appendItem(run.session, { type: 'system', content: 'Stopped while the local engine was starting. It may finish loading in the background; the service stops it when it exits.' });
    finishRun(run, 'Stopped');
    return;
  }
  if (run.kind === 'chat') {
    run.controller.abort();
    appendItem(run.session, { type: 'system', content: 'Stopped waiting for the chat response. Server inference may continue; this API has no chat cancellation endpoint.' });
    finishRun(run, 'Chat response stopped');
  } else await cancelRun(run);
}
// The engine is local and on demand: the first message starts it through the core service.
async function ensureEngine(run) {
  if (engineReady) return;
  engineStarting = true;
  updateControls();
  const startedAt = Date.now();
  const graceUntil = startedAt + 10000;
  try {
    await api('/api/engine/start', { method: 'POST', timeout: 10000, signal: run.controller.signal });
    while (Date.now() - startedAt < 240000) {
      setStatus(`Starting the local engine… ${Math.round((Date.now() - startedAt) / 1000)}s`, run.session);
      await delay(2000, run.controller.signal);
      const health = await api('/api/health', { timeout: 10000, signal: run.controller.signal });
      if (health.app !== 'Fennec') throw new Error('This origin did not return a valid Fennec health response.');
      if (health.engine_running) {
        engineReady = true;
        connectionState('Engine online', 'online');
        return;
      }
      if (Date.now() > graceUntil) {
        const status = await api('/api/engine/status', { timeout: 10000, signal: run.controller.signal });
        if (!status.running && !status.owned) throw new Error('The local engine could not start. Select an installed model on the server and check the engine log.');
      }
    }
    throw new Error('The local engine did not become ready within 4 minutes. Check the engine log on the server, then retry.');
  } finally {
    engineStarting = false;
    updateControls();
  }
}
async function submit(event) {
  event.preventDefault();
  const typed = $('prompt').value.trim();
  if (!typed || activeRun || !connected || !navigator.onLine) return;
  if (!$('composer').reportValidity()) return;
  if (current.mode === 'agent' && $('allow-shell').checked && !window.confirm('Commands are NOT sandboxed. They can change or delete files with the server user’s permissions, including outside the workspace. Allow commands for this task?')) return;
  showError('composer-error');
  showNotice();
  const session = current;
  const context = attachments.map(file => `--- ${file.name} ---\n${file.content}`).join('\n\n');
  const outgoing = context ? `${typed}\n\n${context}` : typed;
  const image = imageAttachment;
  const display = attachments.length ? `${typed}\n\nAttached: ${attachments.map(file => file.name).join(', ')}` : typed;
  const run = { kind: session.mode, session, controller: new AbortController(), phase: 'engine', id: null, after: 0, polls: 0, started: Date.now(), stopRequested: false, cancelBusy: false, hasOutput: false };
  activeRun = run;
  if (session.title === 'New session') { session.title = safe(typed.slice(0, 58)); $('session-title').textContent = session.title; }
  appendItem(session, { type: 'user', content: display, image: image?.dataUrl, imageName: image?.name });
  $('prompt').value = '';
  clearAttachments();
  renderSessions();
  setStatus(run.kind === 'agent' ? 'Starting agent…' : 'Waiting for engine…', session);
  try {
    await ensureEngine(run);
    if (activeRun !== run || run.controller.signal.aborted) return;
    run.phase = run.kind === 'agent' ? 'starting' : 'running';
    if (run.kind === 'chat') {
      // Only successful exchanges become context. A failed send remains visible but isn't silently retried.
      const currentTurn = image && isImageDataUrl(image.dataUrl)
        ? { role: 'user', content: [
            { type: 'text', text: outgoing },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ] }
        : { role: 'user', content: outgoing };
      const messages = [...session.messages, currentTurn].slice(-39);
      while (messages.length > 1 && messages[0].role !== 'user') messages.shift();
      const body = { messages, max_tokens: Number($('max-tokens').value), temperature: Number($('temperature').value) };
      const thinking = $('thinking').value;
      if (thinking === 'off') body.reasoning_effort = 'none';
      else if (thinking === 'high') body.reasoning_effort = 'high';
      const data = await api('/api/chat', { method: 'POST', body, timeout: 180000, signal: run.controller.signal });
      if (activeRun !== run || run.controller.signal.aborted) return;
      const answer = parseChat(data);
      session.messages = [...messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : outgoing })), { role: 'assistant', content: answer.content }];
      appendItem(session, { type: 'assistant', content: answer.content, reasoning: answer.reasoning });
      if (data.usage) appendItem(session, { type: 'system', content: `Usage: ${safe(data.usage)}` });
      finishRun(run, 'Response received');
    } else {
      appendItem(session, { type: 'system', content: `Requested permissions · file writes: ${$('allow-write').checked ? 'allowed' : 'off'} · commands: ${$('allow-shell').checked ? 'allowed (NOT sandboxed)' : 'off'} · maximum 14 steps. Workspace root is selected by the server.` });
      // Do not abort an in-flight start on Stop: first recover its ID, then cancel it.
      const data = await api('/api/agent/start', { method: 'POST', body: { task: outgoing, allow_write: $('allow-write').checked, allow_shell: $('allow-shell').checked, max_steps: 14 }, timeout: 30000, signal: run.controller.signal });
      if (typeof data.id !== 'string' || !data.id || data.id.length > 256) throw new ApiError('Start returned no valid task ID. The server may have started a task; inspect it before retrying.', 0, 'UNKNOWN_START');
      run.id = data.id; run.phase = 'running';
      appendItem(session, { type: 'system', content: `Server task ID: ${run.id}` });
      if (run.stopRequested) await cancelRun(run);
      else await pollAgent(run);
    }
  } catch (error) {
    if (activeRun !== run || run.controller.signal.aborted) return;
    reportApiFailure(error);
    let message = error.message;
    if (run.kind === 'agent' && !run.id && (!error.status || error.status >= 500)) message += ' Start outcome is unknown. No task ID is available to cancel; check the server before retrying or leaving.';
    appendItem(session, { type: 'error', content: message });
    showError('composer-error', message);
    finishRun(run, 'Request failed');
  }
}

function closeMenu() {
  const wasOpen = document.body.classList.contains('menu-open');
  document.body.classList.remove('menu-open');
  $('sidebar-backdrop').hidden = true;
  $('menu-toggle').setAttribute('aria-expanded', 'false');
  if (wasOpen) $('menu-toggle').focus();
}
function openMenu() {
  document.body.classList.add('menu-open');
  $('sidebar-backdrop').hidden = false;
  $('menu-toggle').setAttribute('aria-expanded', 'true');
  $('menu-close').focus();
}
function setView(view) {
  document.body.dataset.view = view;
  for (const name of ['workspace', 'files']) {
    $(`view-${name}`).classList.toggle('active', name === view);
    $(`view-${name}`).setAttribute('aria-pressed', String(name === view));
  }
}
$('connect-form').addEventListener('submit', connect);
$('disconnect-button').addEventListener('click', disconnect);
$('remember-token').addEventListener('change', () => {
  if (!$('remember-token').checked) { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Optional storage. */ } }
});
$('refresh-status').addEventListener('click', refreshHealth);
$('composer').addEventListener('submit', submit);
$('prompt').addEventListener('input', updateControls);
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!$('send-button').disabled) $('composer').requestSubmit(); }
});
$('prompt').addEventListener('paste', event => {
  const file = [...(event.clipboardData?.files || [])].find(entry => entry.type.startsWith('image/'));
  if (file) { event.preventDefault(); void addImageFile(file); }
});
$('attach-button').addEventListener('click', () => $('attach-file').click());
$('image-button').addEventListener('click', () => $('attach-image').click());
$('mic-button').addEventListener('click', () => void toggleMic());
$('attach-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) void addTextFile(file);
});
$('attach-image').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) void addImageFile(file);
});
$('stop-button').addEventListener('click', stopRun);
$('new-session').addEventListener('click', () => { newSession(current.mode); closeMenu(); });
$('clear-sessions').addEventListener('click', () => {
  if (activeRun || !window.confirm('Clear all conversations from this tab? This does not remove server files or server logs.')) return;
  sessions.length = 0; newSession();
});
for (const mode of ['chat', 'agent']) $(`mode-${mode}`).addEventListener('click', () => {
  if (activeRun || current.mode === mode) return;
  if (current.items.length) newSession(mode);
  else { current.mode = mode; renderSession(); }
});
$('directory-form').addEventListener('submit', event => { event.preventDefault(); loadDirectory($('directory-path').value); });
$('files-refresh').addEventListener('click', () => loadDirectory(directory));
$('files-up').addEventListener('click', () => loadDirectory(parentPath(directory)));
$('menu-toggle').addEventListener('click', () => document.body.classList.contains('menu-open') ? closeMenu() : openMenu());
$('menu-close').addEventListener('click', closeMenu);
$('sidebar-backdrop').addEventListener('click', closeMenu);
for (const view of ['workspace', 'files']) $(`view-${view}`).addEventListener('click', () => setView(view));
document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('menu-open')) return;
  if (event.key === 'Escape') { closeMenu(); return; }
  if (event.key === 'Tab') {
    const focusable = [...$('sidebar').querySelectorAll('button:not(:disabled),input:not(:disabled),a,summary')].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) closeMenu(); });
window.addEventListener('offline', () => {
  healthController?.abort(); fileController?.abort(); clearTimeout(healthTimer);
  connected = false; engineReady = false; fileBusy = false;
  connectionState('Offline');
  if (activeRun?.kind === 'chat') stopRun();
  else if (activeRun?.id) pendingCancellation(activeRun, 'Connection lost. Polling stopped; cancellation cannot be confirmed offline. Reconnect and Retry cancel.');
  else if (activeRun) { activeRun.stopRequested = true; updateControls(); }
});
window.addEventListener('online', () => { connectionState('Reconnect required'); showError('connect-error', 'Connection available again. Connect to refresh engine status. Pending messages will not be replayed.'); });
window.addEventListener('beforeunload', event => { if (activeRun) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  clearTimeout(healthTimer); healthController?.abort(); fileController?.abort();
  if (activeRun) {
    activeRun.controller.abort();
    if (activeRun.id) {
      // Best effort only; mobile browsers may terminate without delivering pagehide.
      api('/api/agent/cancel', { method: 'POST', body: { id: activeRun.id }, keepalive: true, timeout: 3000, allowEmpty: true }).catch(() => {});
      activeRun.phase = 'pending'; activeRun.cancelBusy = false;
    }
  }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  connected = false; engineReady = false; connecting = false; fileBusy = false;
  if (activeRun?.id) pendingCancellation(activeRun, 'Tab restored. Verify cancellation with the server before starting another task.');
  else if (activeRun) finishRun(activeRun, 'Interrupted. Check the server before retrying.');
  connectionState('Reconnect required');
});

const secureInstall = canInstallSecurely(location, window.isSecureContext);
const installExplanation = secureInstall
  ? 'Install from a supported browser to open Fennec in its own window. There is no model download to your device.'
  : 'Installation and offline support need a secure context. A LAN IP over plain HTTP is not secure. Configure trusted HTTPS on the server (including a certificate trusted by this device); localhost/loopback is only for the device running the server.';
$('install-message').textContent = installExplanation;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); if (secureInstall) installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('install-button').textContent = 'Installed'; });
$('install-button').addEventListener('click', async () => {
  if (installPrompt) {
    const prompt = installPrompt; installPrompt = null;
    try { await prompt.prompt(); await prompt.userChoice; } catch { /* Browser instructions remain available. */ }
  } else $('install-dialog').showModal();
});
$('install-close').addEventListener('click', () => $('install-dialog').close());
if (secureInstall && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js', { scope: './', updateViaCache: 'none' })
    .then(() => { $('pwa-status').textContent = 'Service worker registered. Only the versioned static shell is cached; no API responses, tokens, or conversation history.'; })
    .catch(() => { $('pwa-status').textContent = 'Offline shell could not be registered. Check server static routes and HTTPS. Connected use may still work.'; });
} else $('pwa-status').textContent = secureInstall ? 'This browser does not support a service worker. Use the connected web app.' : 'No service worker registered on this origin. Trusted HTTPS is required for LAN installation.';

$('app-version').textContent = `Fennec ${VERSION}`;
newSession();
connectionState('Not connected');
if (navigator.onLine) connect();
