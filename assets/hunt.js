import { sb, roman, clock } from './config.js?v=15';
import { renderGrid } from './grid.js?v=16';
import { showConfirm } from './modal.js?v=1';
import { startCountdown } from './countdown.js?v=1';

let stopCountdown = null;

const stageEl = document.getElementById('stage');
const nameEl  = document.getElementById('teamname');

let state = null;
let hiddenMs = 0, hiddenSince = null, pasted = false, tick = null;

// Time spent with the tab out of view. Not proof of anything on its own —
// it is context for the teacher when a stage falls in forty seconds.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenSince = Date.now();
  else if (hiddenSince) { hiddenMs += Date.now() - hiddenSince; hiddenSince = null; }
});

const { data: { session } } = await sb.auth.getSession();
if (!session) location.href = 'index.html';

async function load(soft) {
  const { data, error } = await sb.rpc('get_stage');
  if (error) { fail('Something went wrong reaching the hunt. Tell your teacher.'); return; }

  // Soft reload: only redraw if stage/lock/freeze state changed.
  // This prevents wrong-answer messages being wiped by background team updates.
  if (soft && state) {
    const same = data.stage === state.stage
      && data.error === state.error
      && !data.finished
      && JSON.stringify(data.hints) === JSON.stringify(state.hints)
      && JSON.stringify(data.completion) === JSON.stringify(state.completion);
    if (same) { state = data; return; }
  }

  state = data;

  if (data.error) return blocked(data);
  if (data.finished) return finished(data);

  nameEl.textContent = data.team;
  render();
}

function blocked(d) {
  // Before opening, the page is a countdown rather than a notice.
  if (d.error === 'not_open' && d.opens_at) {
    document.getElementById('board').hidden = true;
    document.getElementById('chat').hidden = true;
    if (stopCountdown) stopCountdown();
    stopCountdown = startCountdown(stageEl, d.opens_at, d.server_now, () => load());
    return;
  }
  document.getElementById('chat').hidden = false;

  const words = {
    frozen:    'The hunt is paused. Wait for your teacher.',
    not_open:  'The hunt is not open yet.',
    closed:    'The hunt has closed.',
    locked:    `Your team is locked. ${d.reason || 'Speak to your teacher.'}`,
    no_team:   'This account is not attached to a team. Tell your teacher.'
  };
  stageEl.innerHTML = `<div class="notice bad">${words[d.error] || 'Unavailable.'}</div>
    ${ d.error === 'no_team'
      ? `<p class="aside" style="text-align:center;margin-top:1.5rem">
           <a href="#" id="signout">Sign out and return to login</a></p>`
      : '' }`;
  if (d.error === 'no_team') {
    document.getElementById('signout').addEventListener('click', async e => {
      e.preventDefault(); await sb.auth.signOut(); location.href = 'index.html';
    });
  }
  setTimeout(load, 10000);
}

function finished(d) {
  stageEl.innerHTML = `<p class="numeral">&#10003;</p>
    <h2>The last draft is finished</h2>
    <p>Every stage cleared. Your finishing time is with your teacher.</p>`;
}

function render() {
  const d = state;
  // Coming back from the countdown: stop it and restore the page furniture.
  if (stopCountdown) { stopCountdown(); stopCountdown = null; }
  document.getElementById('chat').hidden = false;
  stageEl.innerHTML = `
    <div class="reveal">
      <div class="stagehead">
        <p class="numeral">${roman(d.stage)}</p>
        <span class="of">Stage ${d.stage} of ${d.total}</span>
        <h2>${d.title}</h2>
        ${d.subtitle ? `<p class="aside">${d.subtitle}</p>` : ''}
        <hr class="rule">
      </div>
      <div class="body">${d.body_html}</div>
      <div id="puzzle"></div>
      <div id="hintbox"></div>
      ${d.kind === 'completion' ? renderCompletionForm(d) : `
      <form id="answer">
        <label for="ans">Password</label>
        <input id="ans" type="text" autocomplete="off" autocapitalize="characters"
               spellcheck="false" ${d.cooldown > 0 ? 'disabled' : ''}>
        <div class="row">
          <button type="submit" id="go" ${d.cooldown > 0 ? 'disabled' : ''}>Submit answer</button>
          <button type="button" class="quiet" id="hint">Ask for a hint</button>
          <span id="cool" class="aside"></span>
        </div>
      </form>`}
      <div id="result"></div>
      <div class="status">
        <span id="elapsed">&mdash;</span>
        <span>Penalties ${Math.round((d.penalty_ms || 0) / 60000)} min</span>
        <span><a href="#" id="out">Sign out</a></span>
      </div>
    </div>`;

  if (d.kind === 'grid' && d.payload) renderGrid(document.getElementById('puzzle'), d.payload);
  drawHints();
  startClock();

  if (d.kind === 'completion') {
    wireCompletionForm(d);
  } else {
    if (d.cooldown > 0) cooldown(d.cooldown);
    document.getElementById('ans').addEventListener('paste', () => { pasted = true; });
    document.getElementById('answer').addEventListener('submit', submit);
    document.getElementById('hint').addEventListener('click', askHint);
  }
  document.getElementById('out').addEventListener('click', async e => {
    e.preventDefault(); await sb.auth.signOut(); location.href = 'index.html';
  });
}

function renderCompletionForm(d) {
  const status = d.completion?.status;
  if (status === 'pending') {
    return `<div class="notice">Sent to your teacher. Waiting for the go-ahead.</div>
      <p class="aside" style="margin-top:.5rem">What you sent:</p>
      <p style="color:var(--alarm)">${escHtml(d.completion.text)}</p>`;
  }
  const rejectedNote = status === 'rejected'
    ? `<div class="notice bad">Not yet. Read it again and try another ending.</div>` : '';
  return `${rejectedNote}
    <form id="completion">
      <label for="comp">Your ending</label>
      <textarea id="comp" rows="3" style="width:100%;font-family:var(--serif);font-size:1rem;
        padding:.6rem;border:1px solid var(--edge);background:var(--card);color:var(--ink);
        resize:vertical">${status === 'rejected' ? '' : ''}</textarea>
      <div class="row">
        <button type="submit" id="go">Send to your teacher</button>
        <button type="button" class="quiet" id="hint">Ask for a hint</button>
      </div>
    </form>`;
}

function wireCompletionForm(d) {
  const status = d.completion?.status;
  if (status === 'pending') return;
  const form = document.getElementById('completion');
  if (!form) return;
  form.addEventListener('submit', submitCompletion);
  document.getElementById('hint').addEventListener('click', askHint);
}

async function submitCompletion(e) {
  e.preventDefault();
  const input = document.getElementById('comp');
  const text = input.value;
  if (!text.trim()) return;
  document.getElementById('go').disabled = true;

  const { data, error } = await sb.rpc('submit_completion', { p_text: text });
  const out = document.getElementById('result');
  if (error || data.error) {
    out.innerHTML = `<div class="notice bad">That did not reach the hunt. Try once more.</div>`;
    document.getElementById('go').disabled = false;
    return;
  }
  load();
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function drawHints() {
  const box = document.getElementById('hintbox');
  const hints = state.hints || [];
  box.innerHTML = hints.map(h => h.status === 'sent'
    ? `<div class="notice hint"><strong>Hint ${h.tier}.</strong> ${h.message}</div>`
    : `<div class="notice">Hint ${h.tier} requested. Your teacher will decide.</div>`
  ).join('');
}

function startClock() {
  clearInterval(tick);
  const from = new Date(state.stage_entered_at).getTime();
  const el = document.getElementById('elapsed');
  tick = setInterval(() => {
    el.textContent = `On this stage ${clock(Date.now() - from)}`;
  }, 1000);
}

function cooldown(secs) {
  const input = document.getElementById('ans');
  const go = document.getElementById('go');
  const label = document.getElementById('cool');
  input.disabled = go.disabled = true;
  let left = secs;
  const id = setInterval(() => {
    label.textContent = `Locked for ${left}s`;
    if (--left < 0) {
      clearInterval(id);
      label.textContent = '';
      input.disabled = go.disabled = false;
      input.focus();
    }
  }, 1000);
  label.textContent = `Locked for ${left}s`;
}

async function submit(e) {
  e.preventDefault();
  const input = document.getElementById('ans');
  const answer = input.value;
  if (!answer.trim()) return;
  document.getElementById('go').disabled = true;

  const { data, error } = await sb.rpc('submit_answer', {
    p_answer: answer, p_pasted: pasted, p_hidden_ms: Math.round(hiddenMs)
  });
  pasted = false; hiddenMs = 0;

  const out = document.getElementById('result');
  if (error) { out.innerHTML = `<div class="notice bad">That did not reach the hunt. Try once more.</div>`;
               document.getElementById('go').disabled = false; return; }

  if (data.error === 'cooldown') { cooldown(data.seconds); return; }
  if (data.error) { blocked(data); return; }

  if (data.correct) {
    out.innerHTML = `<div class="notice good">Correct. Opening the next stage.</div>`;
    setTimeout(load, 900);
  } else {
    out.innerHTML = `<div class="notice bad">Not the password. Read again before you guess.</div>`;
    input.value = '';
    cooldown(data.cooldown || 15);
  }
}

async function askHint() {
  const used = (state.hints || []).length;
  const tier = used + 1;
  if (tier > 3) return;
  const cost = Math.round((state.hint_costs_ms[tier - 1] || 0) / 60000);
  const ok = await showConfirm({
    title: `Hint ${tier}`,
    body: `This costs ${cost} minute${cost === 1 ? '' : 's'}, added to your time. Ask for it?`,
    confirmLabel: 'Ask for it'
  });
  if (!ok) return;
  await sb.rpc('request_hint', { p_tier: tier });
  load();
}

function fail(t) { stageEl.innerHTML = `<div class="notice bad">${t}</div>`; }

// ---------------------------------------------------------------------------
// Standings. Progress only — the server strips flags and penalties out.
// ---------------------------------------------------------------------------
async function loadBoard() {
  const box = document.getElementById('board');
  const { data, error } = await sb.rpc('get_leaderboard');
  if (error || !data || data.error) { box.hidden = true; return; }

  box.hidden = false;
  document.getElementById('board-list').innerHTML = data.teams.map((t, i) => `
    <div class="board-row${state && t.name === state.team ? ' you' : ''}">
      <span class="board-pos">${i + 1}</span>
      <span class="board-name">${escHtml(t.name)}</span>
      <span class="board-stage">${t.finished_at ? 'Finished' : 'Stage ' + t.stage}</span>
    </div>`).join('');
}

// Live: hints arriving, locks, teacher moving your stage
sb.channel('realtime:public')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, () => { load(true); loadBoard(); })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'hints' }, () => load(true))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'completions' }, () => load(true))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => { load(true); loadBoard(); })
  .subscribe();

load().then(loadBoard);

// ---------------------------------------------------------------------------
// Chat with the teacher
// ---------------------------------------------------------------------------
let myTeamId = null;
let chatOpen = false;
let unread = 0;
let flashTimer = null;
let flashOn = false;
const baseTitle = document.title;

function clearUnread() {
  unread = 0;
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = baseTitle;
}

function markUnread() {
  unread++;
  if (flashTimer) return; // already flashing
  flashTimer = setInterval(() => {
    flashOn = !flashOn;
    document.title = flashOn ? `New message${unread > 1 ? ` (${unread})` : ''}` : baseTitle;
  }, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && chatOpen) clearUnread();
});

async function initChat() {
  // Wire the toggle first and unconditionally: it only flips visibility,
  // so a failure below must not leave the button silently dead.
  document.getElementById('chat-toggle').addEventListener('click', () => {
    chatOpen = !chatOpen;
    document.getElementById('chat-panel').hidden = !chatOpen;
    if (chatOpen) { loadChat(); if (!document.hidden) clearUnread(); }
  });

  const { data: t, error } = await sb.from('teams').select('id').single();
  if (error || !t) {
    console.error('chat: could not resolve team id', error);
    document.getElementById('chat-panel').innerHTML =
      '<div class="notice bad">Messaging is unavailable right now. Try reloading the page.</div>';
    return;
  }
  myTeamId = t.id;

  document.getElementById('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    const { error } = await sb.from('messages').insert({ team_id: myTeamId, sender: 'team', body });
    if (error) console.error('chat: send failed', error);
    loadChat();
  });

  sb.channel('realtime:messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      const m = payload.new;
      if (chatOpen) loadChat();
      if (m.sender === 'teacher' && m.is_announcement) showAnnouncement(m.body);
      if (m.sender === 'teacher' && (!chatOpen || document.hidden)) markUnread();
    })
    .subscribe();
}

// An announcement has to be seen, not discovered later in the chat log.
function showAnnouncement(body) {
  document.getElementById('announce')?.remove();
  const el = document.createElement('div');
  el.id = 'announce';
  el.className = 'announce';
  el.innerHTML = `
    <div class="announce-card" role="alert">
      <p class="announce-from">From your teacher</p>
      <p class="announce-body">${escHtml(body)}</p>
      <div class="row"><button type="button" id="announce-ok">Got it</button></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#announce-ok').addEventListener('click', () => el.remove());
}

async function loadChat() {
  const { data } = await sb.from('messages').select('*')
    .eq('team_id', myTeamId).order('created_at', { ascending: true }).limit(200);
  const log = document.getElementById('chat-log');
  log.innerHTML = (data || []).map(m => `
    <div class="chat-msg ${m.sender}${m.is_announcement ? ' announcement' : ''}">
      <span class="who">${m.sender === 'team' ? 'You'
                         : m.is_announcement ? 'Announcement' : 'Teacher'}</span>
      ${escHtml(m.body)}
      <time>${new Date(m.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

initChat();
