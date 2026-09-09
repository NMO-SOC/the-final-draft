import { sb, clock } from './config.js?v=13';

const el = id => document.getElementById(id);
let teams = [], attempts = [], hints = [], settings = null, stages = [];

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
  await refresh();
  live();
  setInterval(paintTeams, 1000);
  initTabs();
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

// ---------------------------------------------------------------------------
// Content editor
// ---------------------------------------------------------------------------
async function loadContentEditor() {
  const { data } = await sb.from('stages').select('*').order('number');
  stages = data || [];

  const pick = el('stage-pick');
  pick.innerHTML = stages.map(s =>
    `<option value="${s.number}">Stage ${s.number} — ${s.title}</option>`).join('');

  pick.onchange = () => renderStageEditor(Number(pick.value));
  renderStageEditor(stages[0]?.number);
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
          font-size:.82rem;background:#FBFAF7;border:1px solid var(--edge);
          padding:.75rem;color:var(--ink);resize:vertical">${esc(stage.body_html)}</textarea>

        <label style="margin-top:1rem">Minimum seconds on stage</label>
        <input type="number" id="ed-floor" value="${stage.min_seconds}" style="width:8rem">

        <label style="margin-top:1rem">Stage type</label>
        <select id="ed-kind" style="width:auto;background:#FBFAF7;border:1px solid var(--edge);padding:.5rem;color:var(--ink);font-family:var(--serif)">
          <option value="text" ${stage.kind==='text'?'selected':''}>Text (standard)</option>
          <option value="grid" ${stage.kind==='grid'?'selected':''}>Grid (logic puzzle)</option>
        </select>

        <div class="row" style="margin-top:1.25rem">
          <button id="ed-save-stage">Save stage text</button>
          <span id="ed-stage-msg" class="aside"></span>
        </div>
      </div>

      <div class="editor-preview">
        <p class="aside" style="margin-bottom:.75rem;font-size:.75rem;
           text-transform:uppercase;letter-spacing:.1em">Live preview</p>
        <div class="preview-frame">
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
                   background:#FBFAF7;border:1px solid var(--edge);padding:.4rem"></td>
              <td style="text-align:center">
                <input type="checkbox" class="ans-honey" ${a.is_honeypot ? 'checked' : ''}></td>
              <td><input type="text" class="ans-note" value="${esc(a.note || '')}"
                   placeholder="Why this honeypot?"
                   style="width:100%;font-size:.85rem;background:#FBFAF7;
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
  function updatePreview() {
    el('prev-numeral').textContent = roman(stage.number);
    el('prev-of').textContent = `Stage ${stage.number} of ${totalStages}`;
    el('prev-title').textContent = el('ed-title').value;
    const sub = el('ed-subtitle').value.trim();
    el('prev-subtitle').textContent = sub;
    el('prev-subtitle').hidden = !sub;
    el('prev-body').innerHTML = el('ed-body').value;
  }
  ['ed-title','ed-subtitle','ed-body'].forEach(id =>
    el(id).addEventListener('input', updatePreview));
  updatePreview();

  // Wire save stage
  el('ed-save-stage').onclick = async () => {
    const msg = el('ed-stage-msg');
    msg.textContent = 'Saving…';
    const { error } = await sb.from('stages').update({
      title:       el('ed-title').value.trim(),
      subtitle:    el('ed-subtitle').value.trim() || null,
      body_html:   el('ed-body').value,
      min_seconds: Number(el('ed-floor').value),
      kind:        el('ed-kind').value,
      payload:     el('ed-kind').value === 'grid' ? stage.payload : null
    }).eq('number', num);
    msg.textContent = error ? 'Error: ' + error.message : 'Saved.';
    if (!error) {
      // Update local cache so dropdown reflects new title
      const s = stages.find(s => s.number === num);
      if (s) s.title = el('ed-title').value.trim();
      el('stage-pick').querySelector(`option[value="${num}"]`).textContent =
        `Stage ${num} — ${el('ed-title').value.trim()}`;
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
           background:#FBFAF7;border:1px solid var(--edge);padding:.4rem"></td>
      <td style="text-align:center"><input type="checkbox" class="ans-honey"></td>
      <td><input type="text" class="ans-note" placeholder="Why this honeypot?"
           style="width:100%;font-size:.85rem;background:#FBFAF7;
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
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, paintLog)
    .subscribe();
}

boot();
