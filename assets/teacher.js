import { sb, clock } from './config.js?v=15';
import { showConfirm, showPrompt } from './modal.js?v=1';

const el = id => document.getElementById(id);
let teams = [], attempts = [], hints = [], completions = [], settings = null, stages = [];
let stagesByNumber = {};

// ---------------------------------------------------------------------------
// Tab-title flash when work arrives while this tab isn't focused
// ---------------------------------------------------------------------------
let openHintCount = 0, pendingCompletionCount = 0;
let flashTimer = null, flashOn = false, flashCount = 0;
const baseTitle = document.title;

function clearFlash() {
  flashCount = 0;
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = baseTitle;
}

function markFlash() {
  flashCount++;
  if (flashTimer) return;
  flashTimer = setInterval(() => {
    flashOn = !flashOn;
    document.title = flashOn ? `New activity${flashCount > 1 ? ` (${flashCount})` : ''}` : baseTitle;
  }, 1000);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) clearFlash(); });

// Last line of defence: closing or reloading with unsaved stage edits.
window.addEventListener('beforeunload', e => {
  if (editorDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const { data: t, error: te } = await sb.from('teachers').select('auth_uid').maybeSingle();
  if (te) console.error('teacher lookup error', te);
  if (!t) {
    el('loginmsg').innerHTML =
      `<div class="notice bad">Signed in as ${session.user.email}, but the teacher check returned nothing.${te ? ' Error: ' + te.message : ''}</div>`;
    return;
  }
  el('login').hidden = true;
  el('panel').hidden = false;
  const { data: sAll } = await sb.from('stages').select('number, title, body_html').order('number');
  stagesByNumber = Object.fromEntries((sAll || []).map(s => [s.number, s]));
  await refresh();
  live();
  setInterval(tickTimers, 1000);
  initTabs();
  initChat();
  initBroadcast();
  el('export-csv').onclick = exportCsv;
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

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      el('tab-dashboard').hidden = tab !== 'dashboard';
      el('tab-content').hidden   = tab !== 'content';
      if (tab === 'content') loadContentEditor();
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard refresh
// ---------------------------------------------------------------------------
async function refresh() {
  const [t, a, h, c, s] = await Promise.all([
    sb.from('teams').select('*').order('current_stage', { ascending: false }),
    sb.from('attempts').select('*').order('created_at', { ascending: false }).limit(400),
    sb.from('hints').select('*').order('requested_at', { ascending: false }).limit(60),
    sb.from('completions').select('*').order('created_at', { ascending: false }).limit(60),
    sb.from('settings').select('*').eq('id', 1).single()
  ]);
  teams = t.data || []; attempts = a.data || []; hints = h.data || [];
  completions = c.data || []; settings = s.data;

  const nowOpenHints = hints.filter(h => h.status === 'requested').length;
  const nowPendingCompletions = completions.filter(c => c.status === 'pending').length;
  if (document.hidden && (nowOpenHints > openHintCount || nowPendingCompletions > pendingCompletionCount)) {
    markFlash();
  }
  openHintCount = nowOpenHints;
  pendingCompletionCount = nowPendingCompletions;

  paintTeams(); paintHints(); paintCompletions(); paintControls(); paintLog();
  paintChatTeamPicker(); paintSettings();
}

// ---------------------------------------------------------------------------
// Hunt window + leaderboard toggle
// ---------------------------------------------------------------------------
// <input type="datetime-local"> speaks local wall-clock with no zone, so both
// directions have to go through Date rather than slicing the ISO string.
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function paintSettings() {
  const on = !!settings.window_on;
  el('hunt-settings').innerHTML = `
    <div class="row" style="align-items:flex-end;gap:1rem;margin-top:1.5rem">
      <label class="tickbox" for="win-on">
        <input type="checkbox" id="win-on" ${on ? 'checked' : ''}>
        <span>Use opening times</span>
      </label>
      <div>
        <label for="win-open">Opens</label>
        <input type="datetime-local" id="win-open" value="${toLocalInput(settings.opens_at)}"
               ${on ? '' : 'disabled'}>
      </div>
      <div>
        <label for="win-close">Closes</label>
        <input type="datetime-local" id="win-close" value="${toLocalInput(settings.closes_at)}"
               ${on ? '' : 'disabled'}>
      </div>
      <button id="win-save" ${on ? '' : 'disabled'}>Save window</button>
      <button id="board-toggle" class="quiet">
        ${settings.leaderboard_on ? 'Hide standings' : 'Show standings'}</button>
      <span id="win-msg" class="aside"></span>
    </div>
    <p class="aside">${on
      ? 'Before it opens, teams see a countdown instead of the sign-in box. Checked in the database, not the browser.'
      : 'Off: the hunt is reachable whenever it is not frozen. The times above are kept but ignored.'}</p>`;

  el('win-on').onchange = async () => {
    const next = el('win-on').checked;
    const { error } = await sb.from('settings').update({ window_on: next }).eq('id', 1);
    if (error) {
      el('win-msg').textContent = /window_on/.test(error.message)
        ? 'Run supabase/08_window_and_announcements.sql first.' : 'Error: ' + error.message;
      el('win-on').checked = !next;
      return;
    }
    settings.window_on = next;
    paintSettings();
    el('win-msg').textContent = next ? 'Opening times in force.' : 'Opening times off.';
  };

  el('win-save').onclick = async () => {
    const o = el('win-open').value, c = el('win-close').value;
    const { error } = await sb.from('settings').update({
      opens_at:  o ? new Date(o).toISOString() : null,
      closes_at: c ? new Date(c).toISOString() : null
    }).eq('id', 1);
    if (error) { el('win-msg').textContent = 'Error: ' + error.message; return; }
    settings.opens_at  = o ? new Date(o).toISOString() : null;
    settings.closes_at = c ? new Date(c).toISOString() : null;
    paintSettings();
    el('win-msg').textContent = 'Saved.';
  };

  el('board-toggle').onclick = async () => {
    const next = !settings.leaderboard_on;
    const { error } = await sb.from('settings').update({ leaderboard_on: next }).eq('id', 1);
    if (error) { el('win-msg').textContent = 'Error: ' + error.message; return; }
    settings.leaderboard_on = next;
    paintSettings();
    el('win-msg').textContent = next ? 'Standings shown to teams.' : 'Standings hidden.';
  };
}

// ---------------------------------------------------------------------------
// Broadcast: one message row per team, so it lands in each team's own thread
// and trips their unread flash like any other message.
// ---------------------------------------------------------------------------
function initBroadcast() {
  el('broadcast-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = el('broadcast-input');
    const body = input.value.trim();
    if (!body) return;
    if (!teams.length) { el('broadcast-msg').textContent = 'No teams to send to.'; return; }

    const ok = await showConfirm({
      title: 'Send to every team',
      body: `This goes to all ${teams.length} team${teams.length === 1 ? '' : 's'} at once.`,
      confirmLabel: 'Send to all'
    });
    if (!ok) return;

    input.value = '';
    const { error } = await sb.from('messages').insert(
      teams.map(t => ({ team_id: t.id, sender: 'teacher', body, is_announcement: true })));
    el('broadcast-msg').textContent = error
      ? 'Error: ' + error.message
      : `Sent to ${teams.length} team${teams.length === 1 ? '' : 's'}.`;
    setTimeout(() => { el('broadcast-msg').textContent = ''; }, 4000);
  });
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
    return `<tr class="${flagged ? 'flagged' : ''}" data-team="${t.id}">
      <td>${t.name}${t.locked ? ' <span class="chip alert">locked</span>' : ''}</td>
      <td>${t.finished_at ? 'done' : t.current_stage}</td>
      <td data-on-stage>${on}</td>
      <td>${wrongCount(t.id, t.current_stage)}</td>
      <td>${t.flags ? `<span class="chip alert">${t.flags}</span>` : '0'}</td>
      <td>${Math.round(t.penalty_ms / 60000)} min</td>
      <td class="acts">
        <button class="quiet" data-act="lock" data-id="${t.id}" data-on="${t.locked ? 0 : 1}">
          ${t.locked ? 'Unlock' : 'Lock'}</button>
        <button class="quiet" data-act="pen" data-id="${t.id}">Penalty</button>
        <button class="quiet" data-act="stage" data-id="${t.id}">Set stage</button>
        <button class="quiet" data-act="history" data-id="${t.id}">History</button>
        <button class="quiet" data-act="reset" data-id="${t.id}">Reset</button>
      </td></tr>`;
  }).join('');
  el('teams').querySelectorAll('button').forEach(b => b.onclick = () => act(b.dataset));
}

// Runs every second without rebuilding the table, so a teacher mid-click or
// mid-scroll doesn't have the row yanked out from under them each tick.
function tickTimers() {
  teams.forEach(t => {
    if (t.finished_at) return;
    const cell = el('teams').querySelector(`tr[data-team="${t.id}"] [data-on-stage]`);
    if (cell) cell.textContent = clock(Date.now() - new Date(t.stage_entered_at).getTime());
  });
}

async function act(d) {
  if (d.act === 'lock') {
    let reason = null;
    if (d.on === '1') {
      reason = await showPrompt({
        title: 'Lock this team', body: 'Reason shown to the team:',
        defaultValue: 'Wait for your teacher.', confirmLabel: 'Lock'
      });
      if (reason === null) return;
    }
    await sb.rpc('set_lock', { p_team: d.id, p_locked: d.on === '1', p_reason: reason });
  }
  if (d.act === 'pen') {
    const mins = await showPrompt({ title: 'Apply a penalty', body: 'Minutes to add:', defaultValue: '5', confirmLabel: 'Next' });
    if (!mins) return;
    const why = await showPrompt({ title: 'Apply a penalty', body: 'Reason (recorded):', confirmLabel: 'Apply' });
    if (why === null) return;
    await sb.rpc('apply_penalty', { p_team: d.id, p_ms: Number(mins) * 60000, p_reason: why });
  }
  if (d.act === 'stage') {
    const n = await showPrompt({ title: 'Move team', body: 'Move team to stage:', confirmLabel: 'Move' });
    if (!n) return;
    await sb.rpc('set_stage', { p_team: d.id, p_stage: Number(n) });
  }
  if (d.act === 'history') { showHistory(d.id); return; }
  if (d.act === 'reset') {
    const team = teams.find(t => t.id === d.id);
    const ok = await showConfirm({
      title: `Reset ${team ? esc(team.name) : 'team'}?`,
      body: 'Puts them back to stage 1 and permanently deletes their attempts, '
          + 'hints, completions, penalties and messages. Cannot be undone.',
      confirmLabel: 'Reset team'
    });
    if (!ok) return;
    const { data, error } = await sb.rpc('reset_team', { p_team: d.id });
    if (error || data?.error) {
      await showConfirm({
        title: 'Reset failed',
        body: (error?.message || data.error) + '. If this says the function is missing, '
            + 'run supabase/07_reset_team.sql in the SQL editor.',
        confirmLabel: 'OK', cancelLabel: 'Close'
      });
    }
  }
  refresh();
}

// ---------------------------------------------------------------------------
// Results export
// ---------------------------------------------------------------------------
// Reads fresh rather than reusing the dashboard's arrays: those are capped at
// 400 attempts for display, which would quietly under-count a long hunt.
async function exportCsv() {
  const btn = el('export-csv');
  btn.disabled = true; btn.textContent = 'Building…';

  const [{ data: att }, { data: hn }] = await Promise.all([
    sb.from('attempts').select('*').limit(20000),
    sb.from('hints').select('*').limit(5000)
  ]);
  const A = att || [], H = hn || [];

  // clock() is MM:SS, which turns a two-day-old start into "2632:24". An export
  // that gets read in a spreadsheet needs hours.
  const duration = ms => {
    const s = Math.max(0, Math.floor(ms / 1000)), p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`;
  };

  const cols = ['Team','Stage reached','Finished','Total time','Total minutes','Penalty (min)',
                'Flags','Wrong answers','Honeypots hit','Pasted','Hints sent'];
  const rows = teams.map(t => {
    const mine = A.filter(a => a.team_id === t.id);
    const end = t.finished_at ? new Date(t.finished_at) : new Date();
    return [
      t.name,
      t.finished_at ? 'finished' : t.current_stage,
      t.finished_at ? new Date(t.finished_at).toLocaleString('en-AU') : '',
      t.started_at ? duration(end - new Date(t.started_at)) : '',
      t.started_at ? Math.round((end - new Date(t.started_at)) / 60000) : '',
      Math.round((t.penalty_ms || 0) / 60000),
      t.flags || 0,
      mine.filter(a => !a.correct).length,
      mine.filter(a => a.honeypot).length,
      mine.filter(a => a.pasted).length,
      H.filter(h => h.team_id === t.id && h.status === 'sent').length
    ];
  });

  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols, ...rows].map(r => r.map(cell).join(',')).join('\r\n');

  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `last-draft-results-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);

  btn.disabled = false; btn.textContent = 'Export results';
}

// ---------------------------------------------------------------------------
// One team's full trail, for when a flag is disputed
// ---------------------------------------------------------------------------
async function showHistory(teamId) {
  const team = teams.find(t => t.id === teamId);
  const box = el('history');
  box.hidden = false;
  box.innerHTML = `<h2>History — ${esc(team ? team.name : '')}</h2><p class="aside">Loading…</p>`;

  const [{ data: att }, { data: ev }] = await Promise.all([
    sb.from('attempts').select('*').eq('team_id', teamId).order('created_at', { ascending: false }).limit(200),
    sb.from('events').select('*').eq('team_id', teamId).order('created_at', { ascending: false }).limit(200)
  ]);

  const when = ts => new Date(ts).toLocaleString('en-AU',
    { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit' });

  box.innerHTML = `
    <h2>History — ${esc(team ? team.name : '')}</h2>
    <div class="row" style="margin:0 0 1rem"><button class="quiet" id="hist-close">Close</button></div>
    <h2 class="sub-h">Answers tried (${(att || []).length})</h2>
    <div class="table-scroll">
      <table class="teams"><thead><tr>
        <th>When</th><th>Stage</th><th>Typed</th><th>Result</th>
        <th>On stage</th><th>Pasted</th><th>Tab hidden</th>
      </tr></thead><tbody>
        ${(att || []).map(a => `<tr class="${a.honeypot ? 'flagged' : ''}">
          <td>${when(a.created_at)}</td>
          <td>${a.stage_number}</td>
          <td style="font-family:var(--mono);font-size:.8rem;white-space:normal">${esc(a.submitted)}</td>
          <td>${a.correct ? 'correct'
                : a.honeypot ? '<span class="chip alert">honeypot</span>' : 'wrong'}</td>
          <td>${a.seconds_on_stage != null ? clock(a.seconds_on_stage * 1000) : ''}</td>
          <td>${a.pasted ? '<span class="chip alert">pasted</span>' : ''}</td>
          <td>${a.hidden_ms ? Math.round(a.hidden_ms / 1000) + 's' : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="aside">No attempts recorded.</td></tr>'}
      </tbody></table>
    </div>
    <h2 class="sub-h">Log (${(ev || []).length})</h2>
    <div class="log">${(ev || []).map(e => `
      <div class="${e.severity}"><time>${when(e.created_at)}</time>${esc(e.detail || e.kind)}</div>`).join('')
      || '<p class="aside">Nothing logged.</p>'}</div>`;

  el('hist-close').onclick = () => { box.hidden = true; box.innerHTML = ''; };
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function paintCompletions() {
  const open = completions.filter(c => c.status === 'pending');
  el('completions').innerHTML = open.length
    ? open.map(c => {
        const team = teams.find(t => t.id === c.team_id);
        const stage = stagesByNumber[c.stage_number];
        return `<div class="notice hint">
          <strong>${team ? team.name : '?'}</strong> &mdash; stage ${c.stage_number}${stage ? ' &middot; ' + esc(stage.title) : ''}
          <div style="color:var(--ink);margin-top:.5rem">${stage ? stage.body_html : ''}</div>
          <p style="color:var(--alarm);margin:.5rem 0;font-weight:600">${esc(c.text)}</p>
          <div class="row">
            <button data-approve="${c.id}">Approve</button>
            <button class="quiet" data-reject="${c.id}" style="color:var(--alarm)">Send back</button>
          </div></div>`;
      }).join('')
    : '<p class="aside">No completions waiting.</p>';

  el('completions').querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    await sb.rpc('approve_completion', { p_id: Number(b.dataset.approve) });
    refresh();
  });
  el('completions').querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
    const reason = await showPrompt({
      title: 'Send back', body: 'Reason (shown in the log, not to the team):', confirmLabel: 'Send back'
    });
    if (reason === null) return;
    await sb.rpc('reject_completion', { p_id: Number(b.dataset.reject), p_reason: reason || null });
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

// ---------------------------------------------------------------------------
// Content editor
// ---------------------------------------------------------------------------
let editorDirty = false;      // unsaved edits in the stage form
let currentStageNum = null;

// The classes that make stage text look right live in styles.css, which is no
// help while writing a stage. Keep them to hand instead.
const CHEATS = [
  { label: 'p.aside',  what: 'small muted note',           snip: '<p class="aside"></p>' },
  { label: 'div.verse',what: 'indented italic verse',      snip: '<div class="verse">\n<p></p>\n</div>' },
  { label: 'p.who',    what: 'small-caps speaker name',    snip: '<p class="who"></p>' },
  { label: 'p.ref',    what: 'monospace reference line',   snip: '<p class="ref">Page 87 &middot; line 12</p>' },
  { label: 'span.gap', what: 'blank to be filled in',      snip: '<span class="gap">1</span>' },
  { label: 'hr.rule',  what: 'short centred divider',      snip: '<hr class="rule">' },
];

// Starting point for a grid stage, so choosing the type does not leave you
// staring at an empty box wondering what shape the JSON is meant to be.
const GRID_TEMPLATE = JSON.stringify({
  categories: {
    Shelf:    ["1","2","3","4","5"],
    Author:   ["Bronte","Gaskell","Trollope","Eliot","Hardy"],
    Decade:   ["1840s","1850s","1860s","1870s","1880s"],
    Borrower: ["Kerr","Vance","Prynne","Hale","Osgood"]
  },
  clues: [
    "Prynne borrowed the volume two shelves to the right of Osgood's.",
    "Kerr borrowed Gaskell."
  ]
}, null, 2);

// Returns an error string, or null when the payload is usable.
function gridPayloadError(text) {
  let p;
  try { p = JSON.parse(text); }
  catch (e) { return 'Not valid JSON: ' + e.message; }
  if (!p || typeof p !== 'object') return 'Must be a JSON object.';
  if (!p.categories || typeof p.categories !== 'object')
    return 'Missing "categories" object.';
  const keys = Object.keys(p.categories);
  if (keys.length < 2) return 'Need at least two categories (rows plus one column).';
  for (const k of keys) {
    if (!Array.isArray(p.categories[k]) || !p.categories[k].length)
      return `Category "${k}" must be a non-empty array.`;
  }
  const n = p.categories[keys[0]].length;
  for (const k of keys) {
    if (p.categories[k].length !== n)
      return `Every category needs the same number of values; "${k}" has `
           + `${p.categories[k].length}, "${keys[0]}" has ${n}.`;
  }
  if (!Array.isArray(p.clues) || !p.clues.length) return 'Needs a non-empty "clues" array.';
  return null;
}

async function loadContentEditor() {
  const { data } = await sb.from('stages').select('*').order('number');
  stages = data || [];

  const pick = el('stage-pick');
  pick.innerHTML = stages.map(s =>
    `<option value="${s.number}">Stage ${s.number} — ${s.title}</option>`).join('');

  pick.onchange = async () => {
    const target = Number(pick.value);
    if (editorDirty) {
      const ok = await showConfirm({
        title: 'Discard changes?',
        body: 'This stage has edits you have not saved. Moving to another stage loses them.',
        confirmLabel: 'Discard and move'
      });
      if (!ok) { pick.value = String(currentStageNum); return; }
    }
    renderStageEditor(target);
  };

  paintReadiness();
  renderStageEditor(stages[0]?.number);
}

// Which stages are still unfinished. Saves going stage by stage to find out.
async function paintReadiness() {
  const { data: all } = await sb.from('stage_answers')
    .select('stage_number, normalised, is_honeypot');
  const answers = all || [];
  const isStub = h => /Replace this with|Paste your/i.test(h || '');

  const items = stages.map(s => {
    const real = answers.filter(a =>
      a.stage_number === s.number && !a.is_honeypot && a.normalised !== 'replaceme');
    const placeholder = answers.some(a =>
      a.stage_number === s.number && a.normalised === 'replaceme');
    const gaps = [];
    // A completion stage is marked by the teacher, so it has no password.
    if (s.kind !== 'completion' && !real.length)
      gaps.push(placeholder ? 'placeholder answer' : 'no answer');
    if (isStub(s.body_html)) gaps.push('stub text');
    return { n: s.number, title: s.title, gaps };
  });

  const left = items.filter(i => i.gaps.length);
  el('stage-readiness').innerHTML = `
    <div class="readiness">
      <h2>${left.length ? `${left.length} stage${left.length === 1 ? '' : 's'} still to finish`
                        : 'Every stage is ready'}</h2>
      <div class="readiness-list">
        ${items.map(i => `
          <button class="readiness-row${i.gaps.length ? '' : ' done'}" data-go="${i.n}">
            <span class="readiness-n">${i.n}</span>
            <span class="readiness-title">${esc(i.title)}</span>
            <span class="readiness-tags">${
              i.gaps.length ? i.gaps.map(g => `<span class="chip alert">${g}</span>`).join('')
                            : '<span class="chip">ready</span>'}</span>
          </button>`).join('')}
      </div>
    </div>`;

  el('stage-readiness').querySelectorAll('[data-go]').forEach(b => b.onclick = () => {
    el('stage-pick').value = b.dataset.go;
    el('stage-pick').onchange();
  });
}

async function renderStageEditor(num) {
  const stage = stages.find(s => s.number === num);
  if (!stage) return;

  // Fetch answers for this stage
  const { data: answers } = await sb
    .from('stage_answers')
    .select('id, normalised, is_honeypot, note')
    .eq('stage_number', num)
    .order('is_honeypot');

  const ed = el('stage-editor');
  ed.innerHTML = `
    <div class="editor-cols">
      <div class="editor-form">
        <h2>Stage ${stage.number} — content</h2>

        <label>Title</label>
        <input type="text" id="ed-title" value="${esc(stage.title)}">

        <label style="margin-top:1rem">Subtitle <span class="aside">(optional)</span></label>
        <input type="text" id="ed-subtitle" value="${esc(stage.subtitle || '')}">

        <label style="margin-top:1rem">Body HTML</label>
        <textarea id="ed-body" rows="12" style="width:100%;font-family:var(--mono);
          font-size:.82rem;background:var(--card);border:1px solid var(--edge);
          padding:.75rem;color:var(--ink);resize:vertical">${esc(stage.body_html)}</textarea>

        <details class="cheats">
          <summary>Styles you can use in the body</summary>
          <p class="aside">Click one to insert it where the cursor is.</p>
          ${CHEATS.map((c, i) => `
            <button type="button" class="cheat" data-cheat="${i}">
              <code>${esc(c.label)}</code><span>${esc(c.what)}</span>
            </button>`).join('')}
        </details>

        <label style="margin-top:1rem">Minimum seconds on stage</label>
        <input type="number" id="ed-floor" value="${stage.min_seconds}" style="width:8rem">

        <label style="margin-top:1rem">Stage type</label>
        <select id="ed-kind" style="width:auto;background:var(--card);border:1px solid var(--edge);padding:.5rem;color:var(--ink);font-family:var(--serif)">
          <option value="text" ${stage.kind==='text'?'selected':''}>Text (standard)</option>
          <option value="grid" ${stage.kind==='grid'?'selected':''}>Grid (logic puzzle)</option>
          <option value="completion" ${stage.kind==='completion'?'selected':''}>Completion (teacher-reviewed writing)</option>
        </select>

        <div id="ed-payload-wrap" ${stage.kind === 'grid' ? '' : 'hidden'}>
          <label style="margin-top:1rem">Grid definition (JSON)</label>
          <p class="aside" style="margin:.2rem 0 .4rem">
            First category is the row down the left; the rest become columns.
            Clues are shown as a tickable list.</p>
          <textarea id="ed-payload" rows="14" spellcheck="false"
            style="width:100%;font-family:var(--mono);font-size:.78rem;background:var(--card);
            border:1px solid var(--edge);padding:.75rem;color:var(--ink);resize:vertical"
            >${esc(stage.payload ? JSON.stringify(stage.payload, null, 2) : GRID_TEMPLATE)}</textarea>
          <div class="row" style="margin-top:.5rem">
            <button type="button" class="quiet" id="ed-payload-check">Check JSON</button>
            <span id="ed-payload-msg" class="aside"></span>
          </div>
        </div>

        <div class="row" style="margin-top:1.25rem">
          <button id="ed-save-stage">Save stage text</button>
          <span id="ed-stage-msg" class="aside"></span>
        </div>
      </div>

      <div class="editor-preview">
        <p class="aside" style="margin-bottom:.75rem;font-size:.75rem;
           text-transform:uppercase;letter-spacing:.1em">Live preview</p>
        <div class="preview-frame">
          <div class="preview-scale" id="prev-scale">
            <div class="preview-page" id="prev-page">
              <div class="stagehead" style="text-align:center;margin-bottom:1.5rem">
                <p class="numeral" id="prev-numeral" style="margin:0 auto 0.5rem"></p>
                <span class="of" id="prev-of"></span>
                <h2 id="prev-title" style="margin-top:.5rem"></h2>
                <p class="aside" id="prev-subtitle"></p>
                <hr class="rule">
              </div>
              <div class="body" id="prev-body"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="editor-section" style="margin-top:2.5rem">
      <h2>Stage ${stage.number} — passwords</h2>
      <p class="aside">Answers are compared with all spaces, punctuation and capitalisation stripped.
         Type the answer naturally and it will be normalised on save.</p>

      <table class="teams" id="ed-answers">
        <thead><tr>
          <th>Answer (stored normalised)</th>
          <th>Honeypot?</th>
          <th>Note</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${(answers || []).map(a => `
            <tr data-id="${a.id}">
              <td><input type="text" class="ans-val" value="${esc(a.normalised)}"
                   style="width:100%;font-family:var(--mono);font-size:.9rem;
                   background:var(--card);border:1px solid var(--edge);padding:.4rem"></td>
              <td style="text-align:center">
                <input type="checkbox" class="ans-honey" ${a.is_honeypot ? 'checked' : ''}></td>
              <td><input type="text" class="ans-note" value="${esc(a.note || '')}"
                   placeholder="Why this honeypot?"
                   style="width:100%;font-size:.85rem;background:var(--card);
                   border:1px solid var(--edge);padding:.4rem"></td>
              <td><button class="quiet ans-del" style="color:var(--alarm)">Remove</button></td>
            </tr>`).join('')}
        </tbody>
      </table>

      <div class="row" style="margin-top:1rem;flex-wrap:wrap;gap:.5rem">
        <button id="ed-add-answer" class="quiet">+ Add answer</button>
        <button id="ed-save-answers">Save all answers</button>
        <span id="ed-ans-msg" class="aside"></span>
      </div>
    </div>`;

  // Live preview
  const roman = n => ['','I','II','III','IV','V','VI','VII','VIII','IX','X'][n] || String(n);
  const totalStages = stages.length;
  // The preview renders at the student's real column width and type size, then
  // scales down to fit the panel. Rendering it small instead would change where
  // lines break and how far the drop cap reaches, i.e. it would lie.
  function fitPreview() {
    const page = el('prev-page'), scale = el('prev-scale');
    if (!page || !scale) return;
    const k = Math.min(1, scale.clientWidth / page.offsetWidth);
    page.style.transform = `scale(${k})`;
    scale.style.height = (page.offsetHeight * k) + 'px';
  }

  function updatePreview() {
    el('prev-numeral').textContent = roman(stage.number);
    el('prev-of').textContent = `Stage ${stage.number} of ${totalStages}`;
    el('prev-title').textContent = el('ed-title').value;
    const sub = el('ed-subtitle').value.trim();
    el('prev-subtitle').textContent = sub;
    el('prev-subtitle').hidden = !sub;
    el('prev-body').innerHTML = el('ed-body').value;
    fitPreview();
  }
  window.addEventListener('resize', fitPreview);
  ['ed-title','ed-subtitle','ed-body'].forEach(id =>
    el(id).addEventListener('input', updatePreview));
  updatePreview();

  // Anything typed or toggled anywhere in the editor counts as unsaved.
  currentStageNum = num;
  editorDirty = false;
  ed.addEventListener('input',  () => { editorDirty = true; });
  ed.addEventListener('change', () => { editorDirty = true; });
  el('ed-body').addEventListener('focus', e => { e.target.dataset.touched = '1'; });

  // Show the grid box only for grid stages, so the type is never a dead end.
  el('ed-kind').addEventListener('change', () => {
    el('ed-payload-wrap').hidden = el('ed-kind').value !== 'grid';
  });
  el('ed-payload-check').onclick = () => {
    const err = gridPayloadError(el('ed-payload').value);
    const msg = el('ed-payload-msg');
    msg.textContent = err || 'Looks valid.';
    msg.style.color = err ? 'var(--alarm)' : 'var(--ok)';
  };

  ed.querySelectorAll('[data-cheat]').forEach(b => b.onclick = () => {
    const { snip } = CHEATS[Number(b.dataset.cheat)];
    const box = el('ed-body');
    // With no cursor placed, selectionStart reads 0 and the snippet would land
    // before the opening paragraph. Append instead — that is what you meant.
    const placed = box.dataset.touched === '1';
    const at  = placed ? box.selectionStart : box.value.length;
    const end = placed ? box.selectionEnd   : box.value.length;
    box.value = box.value.slice(0, at) + snip + box.value.slice(end);
    box.focus();
    box.selectionStart = box.selectionEnd = at + snip.length;
    updatePreview();
    editorDirty = true;
  });

  // Wire save stage
  el('ed-save-stage').onclick = async () => {
    const msg = el('ed-stage-msg');
    const kind = el('ed-kind').value;

    // Refuse rather than save a grid stage students cannot solve.
    let payload = null;
    if (kind === 'grid') {
      const err = gridPayloadError(el('ed-payload').value);
      if (err) {
        msg.textContent = 'Not saved — ' + err;
        el('ed-payload-msg').textContent = err;
        el('ed-payload-msg').style.color = 'var(--alarm)';
        return;
      }
      payload = JSON.parse(el('ed-payload').value);
    }

    msg.textContent = 'Saving…';
    const { error } = await sb.from('stages').update({
      title:       el('ed-title').value.trim(),
      subtitle:    el('ed-subtitle').value.trim() || null,
      body_html:   el('ed-body').value,
      min_seconds: Number(el('ed-floor').value),
      kind,
      payload
    }).eq('number', num);
    msg.textContent = error ? 'Error: ' + error.message : 'Saved.';
    if (!error) {
      editorDirty = false;
      // Keep the local cache in step so the picker and the readiness list
      // both reflect what was just saved.
      const s = stages.find(s => s.number === num);
      if (s) {
        s.title     = el('ed-title').value.trim();
        s.body_html = el('ed-body').value;
        s.kind      = kind;
        s.payload   = payload;
      }
      el('stage-pick').querySelector(`option[value="${num}"]`).textContent =
        `Stage ${num} — ${el('ed-title').value.trim()}`;
      paintReadiness();
    }
    setTimeout(() => { msg.textContent = ''; }, 3000);
  };

  // Wire add answer row
  el('ed-add-answer').onclick = () => {
    const tbody = el('ed-answers').querySelector('tbody');
    const row = document.createElement('tr');
    row.dataset.id = 'new';
    row.innerHTML = `
      <td><input type="text" class="ans-val" placeholder="Answer"
           style="width:100%;font-family:var(--mono);font-size:.9rem;
           background:var(--card);border:1px solid var(--edge);padding:.4rem"></td>
      <td style="text-align:center"><input type="checkbox" class="ans-honey"></td>
      <td><input type="text" class="ans-note" placeholder="Why this honeypot?"
           style="width:100%;font-size:.85rem;background:var(--card);
           border:1px solid var(--edge);padding:.4rem"></td>
      <td><button class="quiet ans-del" style="color:var(--alarm)">Remove</button></td>`;
    tbody.appendChild(row);
    row.querySelector('.ans-del').onclick = () => row.remove();
  };

  // Wire delete on existing rows
  ed.querySelectorAll('.ans-del').forEach(b =>
    b.onclick = () => b.closest('tr').remove());

  // Wire save answers
  el('ed-save-answers').onclick = async () => {
    const msg = el('ed-ans-msg');
    msg.textContent = 'Saving…';

    // Collect rows
    const rows = [...el('ed-answers').querySelectorAll('tbody tr')];
    const toSave = rows.map(r => ({
      id:       r.dataset.id === 'new' ? null : Number(r.dataset.id),
      val:      r.querySelector('.ans-val').value.trim(),
      honey:    r.querySelector('.ans-honey').checked,
      note:     r.querySelector('.ans-note').value.trim() || null
    })).filter(r => r.val);

    // Delete removed existing answers (those no longer in DOM)
    const existingIds = (answers || []).map(a => a.id);
    const keptIds = toSave.filter(r => r.id).map(r => r.id);
    const toDelete = existingIds.filter(id => !keptIds.includes(id));
    if (toDelete.length) {
      await sb.from('stage_answers').delete().in('id', toDelete);
    }

    // Upsert remaining — normalise via SQL norm() function
    for (const r of toSave) {
      if (r.id) {
        // Update existing
        const { error } = await sb.rpc('update_answer', {
          p_id: r.id, p_val: r.val, p_honey: r.honey, p_note: r.note });
        if (error) { msg.textContent = 'Error: ' + error.message; return; }
      } else {
        // Insert new
        const { error } = await sb.rpc('insert_answer', {
          p_stage: num, p_val: r.val, p_honey: r.honey, p_note: r.note });
        if (error) { msg.textContent = 'Error: ' + error.message; return; }
      }
    }

    msg.textContent = 'Saved. Reloading…';
    editorDirty = false;
    paintReadiness();
    setTimeout(() => renderStageEditor(num), 800);
  };
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
function live() {
  sb.channel('control')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hints' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'completions' }, refresh)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, paintLog)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
      if (payload.new.sender === 'team' && document.hidden) markFlash();
      if (el('chat-team-pick').value) loadChatThread(el('chat-team-pick').value);
    })
    .subscribe();
}

// ---------------------------------------------------------------------------
// Chat with teams
// ---------------------------------------------------------------------------
function paintChatTeamPicker() {
  const pick = el('chat-team-pick');
  const current = pick.value;
  pick.innerHTML = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (current && teams.some(t => t.id === current)) pick.value = current;
}

function initChat() {
  el('chat-team-pick').addEventListener('change', () => loadChatThread(el('chat-team-pick').value));
  el('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const teamId = el('chat-team-pick').value;
    const input = el('chat-input');
    const body = input.value.trim();
    if (!body || !teamId) return;
    input.value = '';
    await sb.from('messages').insert({ team_id: teamId, sender: 'teacher', body });
    loadChatThread(teamId);
  });
  if (el('chat-team-pick').value) loadChatThread(el('chat-team-pick').value);
}

async function loadChatThread(teamId) {
  if (!teamId) return;
  const { data } = await sb.from('messages').select('*')
    .eq('team_id', teamId).order('created_at', { ascending: true }).limit(200);
  const log = el('chat-log');
  log.innerHTML = (data || []).map(m => `
    <div class="chat-msg ${m.sender}">
      ${esc(m.body)}
      <time>${new Date(m.created_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>`).join('');
  log.scrollTop = log.scrollHeight;
}

boot();
