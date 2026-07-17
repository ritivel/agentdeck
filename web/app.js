// AgentDeck mobile web client. Speaks the bridge WebSocket protocol
// (PROTOCOL.md) — the same one the iOS and Mac apps use.

const PLATFORMS = {
  claude: { name: 'Claude', color: 'var(--claude)' },
  cursor: { name: 'Cursor', color: 'var(--cursor)' },
  codex:  { name: 'Codex',  color: 'var(--codex)' },
};
const MAX_RECONNECT_DELAY = 15000;

// ---------- state ----------

const state = {
  target: null,            // { host, token }
  ws: null,
  connected: false,
  explicitlyClosed: false,
  reconnectAttempt: 0,
  serverName: '',
  platforms: {},           // name -> { available }
  sessions: [],            // SessionInfo[]
  transcripts: new Map(),  // sessionId -> StoredEvent[]
  requestedHistory: new Set(),
  redirects: new Map(),    // takeover: old id -> new id
  suggestedDirs: [],
  openSessionId: null,     // chat currently on screen
  permissions: new Map(),  // id -> PermissionRequest awaiting an answer
};

const $ = (id) => document.getElementById(id);

// ---------- connection ----------

function savedTarget() {
  try { return JSON.parse(localStorage.getItem('agentdeck.target')); } catch { return null; }
}

function connect(target) {
  state.target = target;
  state.explicitlyClosed = false;
  openSocket();
}

function openSocket() {
  const { host, token } = state.target;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  setDot('wait');
  let ws;
  try {
    ws = new WebSocket(`${scheme}://${host}/ws?token=${encodeURIComponent(token)}`);
  } catch (err) {
    pairError(`Bad address: ${err.message}`);
    return;
  }
  state.ws = ws;
  ws.onopen = () => send({ type: 'hello', clientName: 'web' });
  ws.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch { /* ignore */ } };
  ws.onclose = () => {
    state.connected = false;
    setDot('bad');
    if (!state.explicitlyClosed) scheduleReconnect();
  };
  ws.onerror = () => {
    if (!state.connected) pairError('Could not reach the bridge. Same network? Token right?');
  };
}

function scheduleReconnect() {
  state.reconnectAttempt++;
  const delay = Math.min(MAX_RECONNECT_DELAY, 1000 * 2 ** Math.min(state.reconnectAttempt, 4));
  setTimeout(() => {
    if (!state.explicitlyClosed && !state.connected && state.target) openSocket();
  }, delay);
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

setInterval(() => send({ type: 'ping' }), 20000);

// ---------- protocol ----------

function apply(msg) {
  switch (msg.type) {
    case 'welcome':
      state.serverName = msg.serverName ?? 'AgentDeck';
      state.platforms = msg.platforms ?? {};
      state.sessions = (msg.sessions ?? []).sort(bySessionOrder);
      state.permissions = new Map((msg.permissions ?? []).map((r) => [r.id, r]));
      state.connected = true;
      state.reconnectAttempt = 0;
      localStorage.setItem('agentdeck.target', JSON.stringify(state.target));
      setDot('ok');
      showScreen(state.openSessionId ? 'chat' : 'deck');
      send({ type: 'dirs.suggest' });
      sendPresence();
      requestNotificationPermission();
      renderAll();
      break;
    case 'sessions':
      state.sessions = (msg.sessions ?? []).sort(bySessionOrder);
      renderAll();
      break;
    case 'session.created':
    case 'session.updated':
      upsert(msg.session);
      renderAll();
      break;
    case 'session.removed':
      state.sessions = state.sessions.filter((s) => s.id !== msg.sessionId);
      if (!state.redirects.has(msg.sessionId)) state.transcripts.delete(msg.sessionId);
      if (state.openSessionId === msg.sessionId && !state.redirects.has(msg.sessionId)) showScreen('deck');
      renderAll();
      break;
    case 'session.takeover':
      state.redirects.set(msg.fromSessionId, msg.session.id);
      upsert(msg.session);
      if (!state.transcripts.has(msg.session.id) && state.transcripts.has(msg.fromSessionId)) {
        state.transcripts.set(msg.session.id, state.transcripts.get(msg.fromSessionId));
      }
      send({ type: 'session.history', sessionId: msg.session.id });
      if (state.openSessionId === msg.fromSessionId) state.openSessionId = msg.session.id;
      renderAll();
      break;
    case 'event': {
      const list = state.transcripts.get(msg.sessionId) ?? [];
      if (!list.some((e) => e.seq === msg.seq)) {
        list.push({ seq: msg.seq, ts: msg.ts, event: msg.event });
        list.sort((a, b) => a.seq - b.seq);
      }
      state.transcripts.set(msg.sessionId, list);
      maybeNotify(msg.sessionId, msg.event);
      if (resolveId(state.openSessionId) === msg.sessionId) renderChatEvents();
      renderDeck();
      break;
    }
    case 'history':
      state.transcripts.set(msg.sessionId, (msg.events ?? []).sort((a, b) => a.seq - b.seq));
      if (resolveId(state.openSessionId) === msg.sessionId) renderChatEvents();
      break;
    case 'dirs':
      state.suggestedDirs = msg.dirs ?? [];
      renderDirSuggestions();
      break;
    case 'permission.request':
      state.permissions.set(msg.request.id, msg.request);
      notifyPermission(msg.request);
      renderPermissions();
      break;
    case 'permission.resolved':
      state.permissions.delete(msg.id);
      if (msg.resolvedBy === 'timeout') toast('Approval expired — answer it in the terminal');
      renderPermissions();
      break;
    case 'alert':
      toast(msg.body ? `${msg.title}: ${msg.body}` : msg.title);
      notifyAlert(msg);
      break;
    case 'error':
      toast(msg.message ?? 'error');
      break;
  }
}

function upsert(s) {
  const idx = state.sessions.findIndex((x) => x.id === s.id);
  if (idx >= 0) state.sessions[idx] = s;
  else state.sessions.push(s);
  state.sessions.sort(bySessionOrder);
}

const bySessionOrder = (a, b) => b.updatedAt - a.updatedAt;

function resolveId(id) {
  let cur = id;
  for (let i = 0; i < 10 && state.redirects.has(cur); i++) cur = state.redirects.get(cur);
  return cur;
}

function sessionById(id) {
  const resolved = resolveId(id);
  return state.sessions.find((s) => s.id === resolved);
}

function requestHistoryIfNeeded(id) {
  const resolved = resolveId(id);
  if (!state.transcripts.has(resolved) && !state.requestedHistory.has(resolved)) {
    state.requestedHistory.add(resolved);
    send({ type: 'session.history', sessionId: resolved });
  }
}

// ---------- permissions (phone approvals) ----------

function permissionSession(req) {
  if (req.sessionId) return sessionById(req.sessionId);
  if (req.nativeSessionId) return state.sessions.find((s) => s.nativeSessionId === req.nativeSessionId);
  return undefined;
}

function respondPermission(id, decision) {
  send({ type: 'permission.respond', id, decision });
  state.permissions.delete(id);
  renderPermissions();
}

function permCard(req) {
  const card = el('div', 'perm-card');
  const head = el('div', 'perm-head');
  head.append(el('span', null, '✋'), el('span', 'perm-tool', req.toolName));
  const s = permissionSession(req);
  head.append(el('span', 'perm-session', s ? s.title : (req.cwd ?? '')));
  card.append(head);
  const detail = permDetail(req);
  if (detail) card.append(el('div', 'perm-detail', detail));
  const actions = el('div', 'perm-actions');
  const allow = el('button', 'allow', 'Allow');
  allow.onclick = (e) => { e.stopPropagation(); respondPermission(req.id, 'allow'); };
  const deny = el('button', 'deny', 'Deny');
  deny.onclick = (e) => { e.stopPropagation(); respondPermission(req.id, 'deny'); };
  actions.append(allow, deny);
  card.append(actions);
  return card;
}

function permDetail(req) {
  const input = req.input;
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 600);
  if (typeof input.command === 'string') return input.command.slice(0, 600);   // Bash
  if (typeof input.file_path === 'string') return input.file_path;             // Edit/Write
  if (typeof input.url === 'string') return input.url;                         // WebFetch
  return compactJSON(input).slice(0, 600);
}

function renderPermissions() {
  // Deck: strip of every pending approval, one tap from anywhere.
  const strip = $('perm-strip');
  strip.textContent = '';
  strip.hidden = state.permissions.size === 0;
  for (const req of state.permissions.values()) strip.append(permCard(req));
  // Chat: cards for the open session render inline with the transcript.
  if (state.openSessionId) renderChatEvents();
}

function notifyPermission(req) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const s = permissionSession(req);
  if (!document.hidden && s && resolveId(state.openSessionId) === s.id) return; // already looking at it
  new Notification(`✋ ${req.toolName} wants to run`, {
    body: `${s ? s.title + ' — ' : ''}${permDetail(req)}`.slice(0, 140),
    tag: req.id,
  });
}

function notifyAlert(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  new Notification(msg.title ?? 'AgentDeck', { body: (msg.body ?? '').slice(0, 140) });
}

// ---------- presence ----------

function sendPresence() {
  send({ type: 'presence', active: !document.hidden });
}
document.addEventListener('visibilitychange', sendPresence);

// ---------- notifications ----------

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function maybeNotify(sessionId, event) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Only notify when the page is hidden or another session is open.
  if (!document.hidden && resolveId(state.openSessionId) === sessionId) return;
  let body = null;
  if (event.kind === 'turn.end') body = event.isError ? 'Turn ended with an error.' : (event.result ?? 'Agent finished — needs input.');
  else if (event.kind === 'permission.denied') body = `Blocked: ${event.toolName}`;
  else if (event.kind === 'error') body = event.message;
  if (!body) return;
  const s = state.sessions.find((x) => x.id === sessionId);
  const platform = PLATFORMS[s?.platform]?.name ?? 'Agent';
  new Notification(`${platform} · ${s?.title ?? 'Session'}`, { body: body.slice(0, 140) });
}

// ---------- rendering ----------

function showScreen(name) {
  for (const id of ['pair-screen', 'deck-screen', 'chat-screen']) $(id).hidden = true;
  $(`${name}-screen`).hidden = false;
  if (name !== 'chat') state.openSessionId = null;
}

function setDot(cls) {
  $('conn-dot').className = `dot ${cls}`;
}

function renderAll() {
  $('server-name').textContent = state.serverName || 'AgentDeck';
  renderDeck();
  renderPermissions();
  if (state.openSessionId) renderChatHeader();
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statePill(s) {
  const pill = el('span', `state-pill state-${s.state}`, s.state);
  return pill;
}

function renderDeck() {
  const root = $('deck-list');
  root.textContent = '';
  const platforms = Object.keys(PLATFORMS).filter(
    (p) => state.platforms[p]?.available || state.sessions.some((s) => s.platform === p),
  );
  if (!platforms.length) {
    root.append(el('div', 'empty', state.connected
      ? 'No coding agents found on the Mac. Install claude, cursor-agent, or codex.'
      : 'Connecting…'));
    return;
  }
  for (const p of platforms) {
    const sessions = state.sessions.filter((s) => s.platform === p);
    const head = el('div', 'platform-head');
    const dot = el('span', 'pdot');
    dot.style.background = PLATFORMS[p].color;
    head.append(dot, el('span', null, PLATFORMS[p].name),
      el('span', 'count', `${sessions.length} session${sessions.length === 1 ? '' : 's'}`));
    root.append(head);
    for (const s of sessions) {
      const card = el('div', 'card');
      card.style.setProperty('--accent', PLATFORMS[p].color);
      const row = el('div', 'row1');
      row.append(el('span', 'title', s.title));
      if (s.attached) row.append(el('span', 'live-badge', 'LIVE'));
      row.append(statePill(s));
      card.append(row, el('div', 'cwd', s.cwd));
      if (s.lastText) card.append(el('div', 'preview', s.lastText));
      card.onclick = () => openChat(s.id);
      root.append(card);
      requestHistoryIfNeeded(s.id);
    }
    if (state.platforms[p]?.available) {
      const add = el('div', 'card new-card', `＋ New ${PLATFORMS[p].name} session`);
      add.onclick = () => openNewSession(p);
      root.append(add);
    }
  }
}

// ---------- chat ----------

function openChat(id) {
  showScreen('chat');
  state.openSessionId = id;
  requestHistoryIfNeeded(id);
  renderChatHeader();
  renderChatEvents(true);
}

function renderChatHeader() {
  const s = sessionById(state.openSessionId);
  if (!s) return;
  $('chat-name').textContent = s.title;
  $('chat-cwd').textContent = s.cwd;
  $('chat-live').hidden = !s.attached;
  const pill = $('chat-state');
  pill.className = `state-pill state-${s.state}`;
  pill.textContent = s.state;
  $('takeover-hint').hidden = !s.readOnly;
  const busy = s.state === 'working' || s.state === 'starting';
  $('chat-stop').hidden = !(busy && !s.readOnly);
  $('chat-send').hidden = busy && !s.readOnly;
  const accent = PLATFORMS[s.platform]?.color ?? 'var(--claude)';
  $('chat-transcript').style.setProperty('--accent', accent);
  $('chat-send').style.background = accent;
}

function eventNode(stored) {
  const e = stored.event;
  switch (e.kind) {
    case 'user': return el('div', 'ev-user', e.text);
    case 'text': return el('div', 'ev-text', e.text);
    case 'thinking': return el('div', 'ev-thinking', e.text);
    case 'tool.start': {
      const node = el('div', 'ev-tool');
      const body = el('div', 'body');
      body.append(el('div', 'name', e.toolName ?? 'tool'));
      if (e.input !== undefined) body.append(el('div', 'detail', compactJSON(e.input)));
      node.append(el('span', 'icon', '🔧'), body);
      return node;
    }
    case 'tool.end': {
      const node = el('div', 'ev-tool');
      const body = el('div', 'body');
      body.append(el('div', 'detail', (e.output ?? (e.isError ? 'error' : 'done')).slice(0, 400)));
      node.append(el('span', 'icon', e.isError ? '❌' : '✅'), body);
      return node;
    }
    case 'turn.end': {
      const parts = [];
      if (e.costUsd != null) parts.push(`$${e.costUsd.toFixed(4)}`);
      if (e.durationMs != null) parts.push(`${(e.durationMs / 1000).toFixed(1)}s`);
      return el('div', `ev-turn${e.isError ? ' err' : ''}`,
        e.isError ? 'turn failed' : (parts.join(' · ') || 'turn ended'));
    }
    case 'permission.denied':
      return el('div', 'ev-notice warn', `✋ Permission denied: ${e.toolName}${e.detail ? ` — ${e.detail}` : ''}`);
    case 'error':
      return el('div', 'ev-notice err', `⚠️ ${e.message}`);
    case 'status':
      return el('div', 'ev-turn', `status: ${e.state}`);
    default:
      return null;
  }
}

function compactJSON(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function renderChatEvents(jump = false) {
  const root = $('chat-transcript');
  const openId = resolveId(state.openSessionId);
  const events = state.transcripts.get(openId) ?? [];
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 160;
  root.textContent = '';
  for (const stored of events) {
    const node = eventNode(stored);
    if (node) root.append(node);
  }
  const open = sessionById(state.openSessionId);
  for (const req of state.permissions.values()) {
    const s = permissionSession(req);
    if (s && (s.id === openId || (open?.nativeSessionId && s.nativeSessionId === open.nativeSessionId))) {
      root.append(permCard(req));
    }
  }
  if (jump || nearBottom) root.scrollTop = root.scrollHeight;
  renderChatHeader();
}

function sendPrompt() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !state.openSessionId) return;
  send({ type: 'prompt', sessionId: resolveId(state.openSessionId), text });
  input.value = '';
  input.style.height = 'auto';
}

// ---------- new session ----------

let nsPlatform = 'claude';

function openNewSession(platform) {
  const available = Object.keys(PLATFORMS).filter((p) => state.platforms[p]?.available);
  if (!available.length) return toast('No agent CLIs available on the Mac');
  nsPlatform = available.includes(platform) ? platform : available[0];
  const picker = $('platform-picker');
  picker.textContent = '';
  for (const p of available) {
    const b = el('button', p === nsPlatform ? 'sel' : '', PLATFORMS[p].name);
    b.onclick = () => { nsPlatform = p; openNewSession(p); };
    picker.append(b);
  }
  $('ns-cwd').value = localStorage.getItem(`agentdeck.cwd.${nsPlatform}`) ?? state.suggestedDirs[0] ?? '';
  $('sheet-backdrop').hidden = false;
}

function renderDirSuggestions() {
  const dl = $('dir-suggestions');
  dl.textContent = '';
  for (const d of state.suggestedDirs) {
    const opt = document.createElement('option');
    opt.value = d;
    dl.append(opt);
  }
}

// ---------- pairing ----------

function pairError(msg) {
  const p = $('pair-error');
  p.textContent = msg;
  p.hidden = false;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- wire up ----------

$('pair-connect').onclick = () => {
  const host = $('pair-host').value.trim() || location.host;
  const token = $('pair-token').value.trim();
  if (!token) return pairError('Token required.');
  $('pair-error').hidden = true;
  connect({ host, token });
};

$('new-session-btn').onclick = () => openNewSession(nsPlatform);
$('ns-cancel').onclick = () => { $('sheet-backdrop').hidden = true; };
$('sheet-backdrop').onclick = (e) => { if (e.target === $('sheet-backdrop')) $('sheet-backdrop').hidden = true; };
$('ns-create').onclick = () => {
  const cwd = $('ns-cwd').value.trim();
  if (!cwd) return toast('Working directory required');
  localStorage.setItem(`agentdeck.cwd.${nsPlatform}`, cwd);
  const msg = { type: 'session.create', platform: nsPlatform, cwd, permissionMode: $('ns-mode').value };
  const prompt = $('ns-prompt').value.trim();
  if (prompt) msg.prompt = prompt;
  send(msg);
  $('ns-prompt').value = '';
  $('sheet-backdrop').hidden = true;
};

$('chat-back').onclick = () => { showScreen('deck'); renderDeck(); };
$('chat-send').onclick = sendPrompt;
$('chat-stop').onclick = () => send({ type: 'interrupt', sessionId: resolveId(state.openSessionId) });
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$('chat-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
});

// ---------- boot ----------

(function boot() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  const host = params.get('host') ?? location.host;
  if (token) {
    // Strip the token from the address bar (stays in localStorage).
    history.replaceState(null, '', location.pathname);
    connect({ host, token });
    showScreen('deck');
    return;
  }
  const saved = savedTarget();
  if (saved?.token) {
    connect(saved);
    showScreen('deck');
    return;
  }
  $('pair-host').value = location.host;
  showScreen('pair');
})();
