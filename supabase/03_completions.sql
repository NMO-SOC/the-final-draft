-- Stage kind 'completion': the student writes a free-text ending, a teacher
-- reads it against the original and decides whether it passes. There is no
-- password for these stages — the teacher's approval is what advances them.
-- Run this once, after 01_schema.sql and 02_seed.sql.

create table if not exists public.completions (
  id            bigserial primary key,
  team_id       uuid not null references public.teams(id) on delete cascade,
  stage_number  int not null,
  text          text not null,
  status        text not null default 'pending',   -- pending | approved | rejected
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid references auth.users(id)
);
create index if not exists completions_lookup on public.completions (team_id, stage_number, created_at desc);

alter table public.completions enable row level security;

create policy completions_own on public.completions for select
  using (public.is_teacher() or team_id = (select id from public.my_team()));
create policy completions_teacher_write on public.completions for update
  using (public.is_teacher()) with check (public.is_teacher());

-- ---------------------------------------------------------------------------
-- submit_completion(): queues the student's writing for teacher review.
-- Does not advance the stage — only approve_completion() does that.
-- ---------------------------------------------------------------------------
create or replace function public.submit_completion(p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.teams; s public.stages; cfg public.settings;
  existing public.completions;
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
  if s.kind is distinct from 'completion' then
    return jsonb_build_object('error','wrong_kind');
  end if;
  if trim(coalesce(p_text,'')) = '' then
    return jsonb_build_object('error','empty');
  end if;

  select * into existing from public.completions
    where team_id = t.id and stage_number = t.current_stage
    order by created_at desc limit 1;

  if existing.id is not null and existing.status = 'approved' then
    return jsonb_build_object('error','already_approved');
  end if;
  if existing.id is not null and existing.status = 'pending' then
    return jsonb_build_object('error','already_pending');
  end if;

  insert into public.completions (team_id, stage_number, text)
    values (t.id, t.current_stage, p_text);
  update public.teams set last_activity = now() where id = t.id;
  perform public.log(t.id, 'completion_submitted',
    format('Stage %s: submitted for review', t.current_stage));

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- approve_completion(): teacher gives the go-ahead. Advances the team's
-- stage exactly as a correct password would.
-- ---------------------------------------------------------------------------
create or replace function public.approve_completion(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.completions; t public.teams;
begin
  if not public.is_teacher() then return jsonb_build_object('error','not_teacher'); end if;

  select * into c from public.completions where id = p_id;
  if c.id is null then return jsonb_build_object('error','not_found'); end if;

  update public.completions set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where id = p_id;

  select * into t from public.teams where id = c.team_id;
  perform public.log(t.id, 'completion_approved', format('Stage %s approved', c.stage_number));

  if t.current_stage >= (select max(number) from public.stages) then
    update public.teams set finished_at = now(), last_activity = now() where id = t.id;
    perform public.log(t.id, 'finished', 'Hunt complete', 'info');
    return jsonb_build_object('ok', true, 'finished', true);
  end if;

  update public.teams
     set current_stage = current_stage + 1,
         stage_entered_at = now(),
         last_activity = now()
   where id = t.id;

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- reject_completion(): sends it back so the team can try again.
-- ---------------------------------------------------------------------------
create or replace function public.reject_completion(p_id bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.completions;
begin
  if not public.is_teacher() then return jsonb_build_object('error','not_teacher'); end if;

  update public.completions set status = 'rejected', decided_at = now(), decided_by = auth.uid()
   where id = p_id returning * into c;
  if c.id is null then return jsonb_build_object('error','not_found'); end if;

  perform public.log(c.team_id, 'completion_rejected',
    format('Stage %s rejected%s', c.stage_number, case when p_reason is not null then ': ' || p_reason else '' end),
    'warn');

  return jsonb_build_object('ok', true);
end $$;

alter publication supabase_realtime add table public.completions;

-- ---------------------------------------------------------------------------
-- get_stage(): add the team's latest completion status for the current stage.
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
              where h.team_id = t.id and h.stage_number = t.current_stage),
    'completion', (select jsonb_build_object('status', c.status, 'text', c.text)
                   from public.completions c
                   where c.team_id = t.id and c.stage_number = t.current_stage
                   order by c.created_at desc limit 1)
  );
end $$;
