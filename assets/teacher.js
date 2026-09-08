import { sb, clock } from './config.js?v=4';

const el = id => document.getElementById(id);
let teams = [], attempts = [], hints = [], settings = null;

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const { data: t, error: te } = await sb.from('teachers').select('auth_uid').maybeSingle();
  if (te) console.error('teacher lookup error', te);
  if (!t) { el('loginmsg').innerHTML =
    `<div class="notice bad">Signed in as ${session.user.email}, but the teacher check returned nothing.${te ? ' Error: ' + te.message : ''}</div>`; return; }
  el('login').hidden = true;
  el('panel').hidden = false;
  await refresh();
  live();
  setInterval(paintTeams, 1000);
}

el('login').addEventListener('submit', async e => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({
    email: el('em').value.trim(), password: el('pw').value });
  el('loginmsg').innerHTML = error
    ? `<div class="notice bad">Sign-in failed: ${error.message} (${error.status || 'no status'})</div>`
    : '';
  if (error) console.error('auth error', error);
  if (!error) boot();
});

async function refresh() {
  const [t, a, h, s] = await Promise.all([
    sb.from('teams').select('*').order('current_stage', { ascending: false }),
    sb.from('attempts').select('*').order('created_at', { ascending: false }).limit(400),
    sb.from('hints').select('*').order('requested_at', { ascending: false }).limit(60),
    sb.from('settings').select('*').eq('id', 1).single()
  ]);
  teams = t.data || []; attempts = a.data || []; hints = h.data || []; settings = s.data;
  paintTeams(); paintHints(); paintControls(); paintLog();
}

function paintControls() {
  el('controls').innerHTML = `
    <button id="freeze" class="${settings.frozen ? '' : 'quiet'}">
      ${settings.frozen ? 'Resume hunt' : 'Freeze hunt'}</button>
    <span class="aside">${settings.frozen
      ? 'Every team is held on a waiting screen.'
      : 'The hunt is running.'}</span>`;
  el('freeze').onclick = async () => {
    await sb.from('settings').update({ frozen: !settings.frozen }).eq('id', 1);
    refresh();
  };
}

function wrongCount(id, stage) {
  return attempts.filter(a => a.team_id === id && a.stage_number === stage && !a.correct).length;
}

function paintTeams() {
  el('teams').innerHTML = teams.map(t => {
    const flagged = t.flags > 0;
    const on = t.finished_at ? '&mdash;' : clock(Date.now() - new Date(t.stage_entered_at).getTime());
    return `<tr class="${flagged ? 'flagged' : ''}">
      <td>${t.name}${t.locked ? ' <span class="chip alert">locked</span>' : ''}</td>
      <td>${t.finished_at ? 'done' : t.current_stage}</td>
      <td>${on}</td>
      <td>${wrongCount(t.id, t.current_stage)}</td>
      <td>${t.flags ? `<span class="chip alert">${t.flags}</span>` : '0'}</td>
      <td>${Math.round(t.penalty_ms / 60000)} min</td>
      <td>
        <button class="quiet" data-act="lock" data-id="${t.id}" data-on="${t.locked ? 0 : 1}">
          ${t.locked ? 'Unlock' : 'Lock'}</button>
        <button class="quiet" data-act="pen" data-id="${t.id}">Penalty</button>
        <button class="quiet" data-act="stage" data-id="${t.id}">Set stage</button>
      </td></tr>`;
  }).join('');

  el('teams').querySelectorAll('button').forEach(b => b.onclick = () => act(b.dataset));
}

async function act(d) {
  if (d.act === 'lock') {
    const reason = d.on === '1' ? prompt('Reason shown to the team:', 'Wait for your teacher.') : null;
    if (d.on === '1' && reason === null) return;
    await sb.rpc('set_lock', { p_team: d.id, p_locked: d.on === '1', p_reason: reason });
  }
  if (d.act === 'pen') {
    const mins = prompt('Penalty in minutes:', '5');
    if (!mins) return;
    const why = prompt('Reason (recorded):', '');
    if (why === null) return;
    await sb.rpc('apply_penalty', { p_team: d.id, p_ms: Number(mins) * 60000, p_reason: why });
  }
  if (d.act === 'stage') {
    const n = prompt('Move team to stage:');
    if (!n) return;
    await sb.rpc('set_stage', { p_team: d.id, p_stage: Number(n) });
  }
  refresh();
}

function paintHints() {
  const open = hints.filter(h => h.status === 'requested');
  el('hints').innerHTML = open.length
    ? open.map(h => {
        const team = teams.find(t => t.id === h.team_id);
        return `<div class="notice hint">
          <strong>${team ? team.name : '?'}</strong> &mdash; stage ${h.stage_number}, hint ${h.tier}
          (costs ${Math.round(h.cost_ms / 60000)} min)
          <div class="row">
            <input type="text" id="m${h.id}" placeholder="What the team will see">
            <button data-send="${h.id}">Send hint</button>
          </div></div>`;
      }).join('')
    : '<p class="aside">No hint requests waiting.</p>';

  el('hints').querySelectorAll('[data-send]').forEach(b => b.onclick = async () => {
    const id = b.dataset.send;
    const msg = el('m' + id).value.trim();
    if (!msg) return;
    await sb.rpc('send_hint', { p_hint: Number(id), p_message: msg });
    refresh();
  });
}

async function paintLog() {
  const { data } = await sb.from('events').select('*')
    .order('created_at', { ascending: false }).limit(120);
  const byId = Object.fromEntries(teams.map(t => [t.id, t.name]));
  el('log').innerHTML = (data || []).map(e => `
    <div class="${e.severity}">
      <time>${new Date(e.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</time>
      ${byId[e.team_id] || ''} &middot; ${e.detail || e.kind}
    </div>`).join('');
}

function live() {
  sb.channel('control')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hints' }, refresh)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, paintLog)
    .subscribe();
}

boot();
