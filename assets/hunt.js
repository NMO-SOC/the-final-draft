import { sb, roman, clock } from './config.js?v=12';
import { renderGrid } from './grid.js?v=12';

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
      && JSON.stringify(data.hints) === JSON.stringify(state.hints);
    if (same) { state = data; return; }
  }

  state = data;

  if (data.error) return blocked(data);
  if (data.finished) return finished(data);

  nameEl.textContent = data.team;
  render();
}

function blocked(d) {
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
      <form id="answer">
        <label for="ans">Password</label>
        <input id="ans" type="text" autocomplete="off" autocapitalize="characters"
               spellcheck="false" ${d.cooldown > 0 ? 'disabled' : ''}>
        <div class="row">
          <button type="submit" id="go" ${d.cooldown > 0 ? 'disabled' : ''}>Submit answer</button>
          <button type="button" class="quiet" id="hint">Ask for a hint</button>
          <span id="cool" class="aside"></span>
        </div>
      </form>
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
  if (d.cooldown > 0) cooldown(d.cooldown);

  document.getElementById('ans').addEventListener('paste', () => { pasted = true; });
  document.getElementById('answer').addEventListener('submit', submit);
  document.getElementById('hint').addEventListener('click', askHint);
  document.getElementById('out').addEventListener('click', async e => {
    e.preventDefault(); await sb.auth.signOut(); location.href = 'index.html';
  });
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
  if (!confirm(`Hint ${tier} costs ${cost} minutes. Ask for it?`)) return;
  await sb.rpc('request_hint', { p_tier: tier });
  load();
}

function fail(t) { stageEl.innerHTML = `<div class="notice bad">${t}</div>`; }

// Live: hints arriving, locks, teacher moving your stage
sb.channel('realtime:public')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, () => load(true))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'hints' }, () => load(true))
  .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => load(true))
  .subscribe();

load();
