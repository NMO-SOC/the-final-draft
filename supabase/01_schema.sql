-- The Great Literary Hunt — database schema
-- Run this in the Supabase SQL editor, in order: 01_schema.sql then 02_seed.sql
-- Every answer lives here, never in the frontend.

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  id              int primary key default 1,
  opens_at        timestamptz,          -- hunt is unreachable outside this window
  closes_at       timestamptz,
  frozen          boolean not null default false,   -- global panic button
  leaderboard_on  boolean not null default true,
  constraint settings_singleton check (id = 1)
);

create table if not exists public.teachers (
  auth_uid  uuid primary key references auth.users(id) on delete cascade,
  name      text
);

create table if not exists public.teams (
  id             uuid primary key default gen_random_uuid(),
  auth_uid       uuid unique references auth.users(id) on delete set null,
  name           text not null,
  slug           text not null unique,
  current_stage  int  not null default 1,
  locked         boolean not null default false,
  lock_reason    text,
  penalty_ms     bigint not null default 0,        -- added to elapsed time
  flags          int not null default 0,           -- honeypot / anomaly count
  started_at     timestamptz,
  finished_at    timestamptz,
  stage_entered_at timestamptz default now(),
  last_activity  timestamptz default now(),
  session_token  uuid                              -- single active session per team
);

create table if not exists public.stages (
  number        int primary key,
  title         text not null,
  subtitle      text,
  body_html     text not null,
  kind          text not null default 'text',      -- 'text' | 'grid' | 'cipher'
  payload       jsonb,                             -- puzzle data for interactive kinds
  min_seconds   int not null default 30,           -- floor below which a solve is flagged
  hint_costs_ms int[] not null default '{120000,300000,600000}'
);

-- PRIVATE. No RLS policy is ever created for this table, so PostgREST refuses
-- all access. Only SECURITY DEFINER functions below can read it.
create table if not exists public.stage_answers (
  id            bigserial primary key,
  stage_number  int not null references public.stages(number) on delete cascade,
  normalised    text not null,
  is_honeypot   boolean not null default false,
  note          text                                -- why this honeypot exists
);
create index if not exists stage_answers_lookup on public.stage_answers (stage_number, normalised);

create table if not exists public.attempts (
  id            bigserial primary key,
  team_id       uuid not null references public.teams(id) on delete cascade,
  stage_number  int  not null,
  submitted     text not null,
  correct       boolean not null,
  honeypot      boolean not null default false,
  seconds_on_stage int,
  pasted        boolean not null default false,
  hidden_ms     int not null default 0,             -- time with tab not visible
  created_at    timestamptz not null default now()
);
create index if not exists attempts_team on public.attempts (team_id, created_at desc);

create table if not exists public.hints (
  id            bigserial primary key,
  team_id       uuid not null references public.teams(id) on delete cascade,
  stage_number  int not null,
  tier          int not null,
  status        text not null default 'requested',  -- requested | sent | refused
  message       text,
  cost_ms       bigint not null default 0,
  requested_at  timestamptz not null default now(),
  answered_at   timestamptz
);

create table if not exists public.penalties (
  id          bigserial primary key,
  team_id     uuid not null references public.teams(id) on delete cascade,
  ms          bigint not null,
  reason      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id          bigserial primary key,
  team_id     uuid references public.teams(id) on delete cascade,
  kind        text not null,
  detail      text,
  severity    text not null default 'info',         -- info | warn | alert
  created_at  timestamptz not null default now()
);
create index if not exists events_recent on public.events (created_at desc);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.norm(t text)
returns text language sql immutable as $$
  select regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]', '', 'g');
$$;

create or replace function public.is_teacher()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teachers where auth_uid = auth.uid());
$$;

create or replace function public.my_team()
returns public.teams language sql stable security definer set search_path = public as $$
  select * from public.teams where auth_uid = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.teams          enable row level security;
alter table public.stages         enable row level security;
alter table public.stage_answers  enable row level security;   -- no policies: fully denied
alter table public.attempts       enable row level security;
alter table public.hints          enable row level security;
alter table public.penalties      enable row level security;
alter table public.events         enable row level security;
alter table public.settings       enable row level security;
alter table public.teachers       enable row level security;

-- Teams see only themselves. Teachers see all.
create policy teams_self_read on public.teams for select
  using (auth_uid = auth.uid() or public.is_teacher());
create policy teams_teacher_write on public.teams for update
  using (public.is_teacher()) with check (public.is_teacher());
create policy teams_teacher_insert on public.teams for insert
  with check (public.is_teacher());

-- Stage text is NOT readable directly; students go through get_stage().
create policy stages_teacher_read on public.stages for select using (public.is_teacher());

create policy attempts_own on public.attempts for select
  using (public.is_teacher() or team_id = (select id from public.my_team()));
create policy hints_own on public.hints for select
  using (public.is_teacher() or team_id = (select id from public.my_team()));
create policy hints_teacher_write on public.hints for update
  using (public.is_teacher()) with check (public.is_teacher());
create policy penalties_own on public.penalties for select
  using (public.is_teacher() or team_id = (select id from public.my_team()));
create policy penalties_teacher_write on public.penalties for insert
  with check (public.is_teacher());
create policy events_teacher on public.events for select using (public.is_teacher());
create policy settings_read on public.settings for select using (true);
create policy settings_teacher_write on public.settings for update
  using (public.is_teacher()) with check (public.is_teacher());
create policy teachers_self on public.teachers for select using (auth_uid = auth.uid());

-- ---------------------------------------------------------------------------
-- log(): internal activity log
-- ---------------------------------------------------------------------------

create or replace function public.log(p_team uuid, p_kind text, p_detail text, p_sev text default 'info')
returns void language sql security definer set search_path = public as $$
  insert into public.events (team_id, kind, detail, severity)
  values (p_team, p_kind, p_detail, p_sev);
$$;

-- ---------------------------------------------------------------------------
-- get_stage(): returns the team's CURRENT stage only. No reading ahead.
-- ---------------------------------------------------------------------------

create or replace function public.get_stage()
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams; s public.stages; cfg public.settings; cooldown int;
begin
  select * into t from public.teams where auth_uid = auth.uid();
  if t.id is null then return jsonb_build_object('error','no_team'); end if;
  select * into cfg from public.settings where id = 1;

  if cfg.frozen then return jsonb_build_object('error','frozen'); end if;
  if cfg.opens_at is not null and now() < cfg.opens_at then
    return jsonb_build_object('error','not_open','opens_at',cfg.opens_at);
  end if;
  if cfg.closes_at is not null and now() > cfg.closes_at then
    return jsonb_build_object('error','closed');
  end if;
  if t.locked then
    return jsonb_build_object('error','locked','reason',coalesce(t.lock_reason,''));
  end if;
  if t.finished_at is not null then
    return jsonb_build_object('finished',true,'team',t.name);
  end if;

  select * into s from public.stages where number = t.current_stage;

  -- remaining cooldown from consecutive wrong answers on this stage
  select greatest(0, ceil(extract(epoch from (
      max(a.created_at) + make_interval(secs => public.cooldown_seconds(t.id, t.current_stage))
      - now())))::int)
    into cooldown
  from public.attempts a
  where a.team_id = t.id and a.stage_number = t.current_stage and not a.correct;

  return jsonb_build_object(
    'team', t.name,
    'stage', s.number,
    'total', (select count(*) from public.stages),
    'title', s.title,
    'subtitle', s.subtitle,
    'body_html', s.body_html,
    'kind', s.kind,
    'payload', s.payload,
    'hint_costs_ms', s.hint_costs_ms,
    'stage_entered_at', t.stage_entered_at,
    'penalty_ms', t.penalty_ms,
    'started_at', t.started_at,
    'cooldown', coalesce(cooldown,0),
    'hints', (select coalesce(jsonb_agg(jsonb_build_object(
                'tier',h.tier,'status',h.status,'message',h.message) order by h.tier),'[]'::jsonb)
              from public.hints h
              where h.team_id = t.id and h.stage_number = t.current_stage)
  );
end $$;

create or replace function public.cooldown_seconds(p_team uuid, p_stage int)
returns int language sql stable security definer set search_path = public as $$
  select case count(*)
    when 0 then 0 when 1 then 15 when 2 then 30 when 3 then 60 else 120 end
  from public.attempts
  where team_id = p_team and stage_number = p_stage and not correct;
$$;

-- ---------------------------------------------------------------------------
-- submit_answer(): the only path by which a stage can be cleared
-- ---------------------------------------------------------------------------

create or replace function public.submit_answer(
  p_answer text, p_pasted boolean default false, p_hidden_ms int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.teams; s public.stages; cfg public.settings;
  n text; hit public.stage_answers; wait int; secs int; last_wrong timestamptz;
begin
  select * into t from public.teams where auth_uid = auth.uid();
  if t.id is null then return jsonb_build_object('error','no_team'); end if;
  select * into cfg from public.settings where id = 1;
  if cfg.frozen then return jsonb_build_object('error','frozen'); end if;
  if t.locked then return jsonb_build_object('error','locked'); end if;
  if cfg.opens_at is not null and now() < cfg.opens_at then
    return jsonb_build_object('error','not_open'); end if;
  if cfg.closes_at is not null and now() > cfg.closes_at then
    return jsonb_build_object('error','closed'); end if;

  select * into s from public.stages where number = t.current_stage;
  n := public.norm(p_answer);
  if n = '' then return jsonb_build_object('error','empty'); end if;

  -- escalating cooldown
  wait := public.cooldown_seconds(t.id, t.current_stage);
  select max(created_at) into last_wrong from public.attempts
    where team_id = t.id and stage_number = t.current_stage and not correct;
  if last_wrong is not null and now() < last_wrong + make_interval(secs => wait) then
    return jsonb_build_object('error','cooldown',
      'seconds', ceil(extract(epoch from (last_wrong + make_interval(secs => wait) - now())))::int);
  end if;

  secs := greatest(0, extract(epoch from (now() - t.stage_entered_at)))::int;

  select * into hit from public.stage_answers
   where stage_number = t.current_stage and normalised = n limit 1;

  -- honeypot: a confident wrong answer that a machine would produce
  if hit.id is not null and hit.is_honeypot then
    insert into public.attempts (team_id, stage_number, submitted, correct, honeypot,
                                 seconds_on_stage, pasted, hidden_ms)
      values (t.id, t.current_stage, p_answer, false, true, secs, p_pasted, p_hidden_ms);
    update public.teams set flags = flags + 1, last_activity = now() where id = t.id;
    perform public.log(t.id, 'honeypot',
      format('Stage %s: submitted "%s" (%s)', t.current_stage, p_answer, coalesce(hit.note,'')), 'alert');
    return jsonb_build_object('correct', false, 'cooldown',
      public.cooldown_seconds(t.id, t.current_stage));
  end if;

  if hit.id is null then
    insert into public.attempts (team_id, stage_number, submitted, correct, seconds_on_stage, pasted, hidden_ms)
      values (t.id, t.current_stage, p_answer, false, secs, p_pasted, p_hidden_ms);
    update public.teams set last_activity = now() where id = t.id;
    perform public.log(t.id, 'wrong', format('Stage %s: "%s"', t.current_stage, p_answer));
    return jsonb_build_object('correct', false,
      'cooldown', public.cooldown_seconds(t.id, t.current_stage));
  end if;

  -- correct
  insert into public.attempts (team_id, stage_number, submitted, correct, seconds_on_stage, pasted, hidden_ms)
    values (t.id, t.current_stage, p_answer, true, secs, p_pasted, p_hidden_ms);

  if secs < s.min_seconds then
    update public.teams set flags = flags + 1 where id = t.id;
    perform public.log(t.id, 'too_fast',
      format('Stage %s cleared in %ss (floor %ss)', t.current_stage, secs, s.min_seconds), 'warn');
  end if;
  if p_pasted then
    perform public.log(t.id, 'paste', format('Stage %s: answer pasted', t.current_stage), 'warn');
  end if;

  perform public.log(t.id, 'cleared', format('Stage %s cleared in %ss', t.current_stage, secs));

  if t.current_stage >= (select max(number) from public.stages) then
    update public.teams set finished_at = now(), last_activity = now() where id = t.id;
    perform public.log(t.id, 'finished', 'Hunt complete', 'info');
    return jsonb_build_object('correct', true, 'finished', true);
  end if;

  update public.teams
     set current_stage = current_stage + 1,
         stage_entered_at = now(),
         last_activity = now()
   where id = t.id;

  return jsonb_build_object('correct', true, 'stage', t.current_stage + 1);
end $$;

-- ---------------------------------------------------------------------------
-- request_hint(): queues a request; the teacher decides
-- ---------------------------------------------------------------------------

create or replace function public.request_hint(p_tier int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams; s public.stages; existing int;
begin
  select * into t from public.teams where auth_uid = auth.uid();
  if t.id is null then return jsonb_build_object('error','no_team'); end if;
  if t.locked then return jsonb_build_object('error','locked'); end if;
  if p_tier not between 1 and 3 then return jsonb_build_object('error','bad_tier'); end if;

  select count(*) into existing from public.hints
   where team_id = t.id and stage_number = t.current_stage and tier = p_tier;
  if existing > 0 then return jsonb_build_object('error','already_requested'); end if;

  select * into s from public.stages where number = t.current_stage;

  insert into public.hints (team_id, stage_number, tier, cost_ms)
    values (t.id, t.current_stage, p_tier, s.hint_costs_ms[p_tier]);
  perform public.log(t.id, 'hint_requested',
    format('Stage %s: hint %s', t.current_stage, p_tier), 'info');
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Teacher actions
-- ---------------------------------------------------------------------------

create or replace function public.send_hint(p_hint bigint, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare h public.hints;
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  update public.hints set status='sent', message=p_message, answered_at=now()
   where id = p_hint returning * into h;
  update public.teams set penalty_ms = penalty_ms + h.cost_ms where id = h.team_id;
  perform public.log(h.team_id, 'hint_sent', format('Stage %s: hint %s sent', h.stage_number, h.tier));
end $$;

create or replace function public.apply_penalty(p_team uuid, p_ms bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  insert into public.penalties (team_id, ms, reason) values (p_team, p_ms, p_reason);
  update public.teams set penalty_ms = penalty_ms + p_ms where id = p_team;
  perform public.log(p_team, 'penalty', format('%s min: %s', round(p_ms/60000.0,1), p_reason), 'warn');
end $$;

create or replace function public.set_lock(p_team uuid, p_locked boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  update public.teams set locked = p_locked, lock_reason = p_reason where id = p_team;
  perform public.log(p_team, case when p_locked then 'locked' else 'unlocked' end,
                     coalesce(p_reason,''), 'warn');
end $$;

create or replace function public.set_stage(p_team uuid, p_stage int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  update public.teams set current_stage = p_stage, stage_entered_at = now(),
         finished_at = null where id = p_team;
  perform public.log(p_team, 'stage_set', format('Moved to stage %s', p_stage), 'warn');
end $$;

-- Leaderboard: progress only, never answers.
create or replace view public.leaderboard as
  select name, current_stage, finished_at, flags
  from public.teams order by current_stage desc, finished_at nulls last;

grant select on public.leaderboard to authenticated;

-- Realtime for the dashboard
alter publication supabase_realtime add table public.teams;
alter publication supabase_realtime add table public.hints;
alter publication supabase_realtime add table public.events;
