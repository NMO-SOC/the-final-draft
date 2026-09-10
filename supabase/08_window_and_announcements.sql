-- Window toggle, pre-login countdown, and on-screen announcements.
-- Run this once, after 07_reset_team.sql.

-- ---------------------------------------------------------------------------
-- 1. An explicit on/off for the window, so the dates can be set in advance and
--    left there. Previously "enabled" just meant "opens_at is not null", which
--    forced you to clear the dates to run outside the window.
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists window_on boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. Announcements ride in the messages table so each team keeps a copy in its
--    own thread, but carry a flag the student page uses to raise them on screen
--    rather than leaving them to be noticed in the chat log.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists is_announcement boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. The countdown has to render BEFORE anyone logs in, and the settings table
--    is deliberately not readable without a session. This exposes the window
--    and nothing else: no answers, no team data, no open/close of anything.
-- ---------------------------------------------------------------------------
create or replace function public.get_hunt_window()
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg public.settings;
begin
  select * into cfg from public.settings where id = 1;
  return jsonb_build_object(
    'window_on', coalesce(cfg.window_on, false),
    'opens_at',  cfg.opens_at,
    'closes_at', cfg.closes_at,
    'frozen',    coalesce(cfg.frozen, false),
    'server_now', now(),          -- so a wrong device clock cannot skew the countdown
    'open_now', not coalesce(cfg.window_on, false)
                or ((cfg.opens_at  is null or now() >= cfg.opens_at)
                and (cfg.closes_at is null or now() <= cfg.closes_at))
  );
end $$;

revoke execute on function public.get_hunt_window() from public;
grant execute on function public.get_hunt_window() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_stage() honours the toggle. Identical to the version in
--    03_completions.sql apart from the two window checks.
-- ---------------------------------------------------------------------------
create or replace function public.get_stage()
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams; s public.stages; cfg public.settings; cooldown int;
begin
  select * into t from public.teams where auth_uid = auth.uid();
  if t.id is null then return jsonb_build_object('error','no_team'); end if;
  select * into cfg from public.settings where id = 1;

  if cfg.frozen then return jsonb_build_object('error','frozen'); end if;
  if cfg.window_on and cfg.opens_at is not null and now() < cfg.opens_at then
    return jsonb_build_object('error','not_open','opens_at',cfg.opens_at,'server_now',now());
  end if;
  if cfg.window_on and cfg.closes_at is not null and now() > cfg.closes_at then
    return jsonb_build_object('error','closed');
  end if;
  if t.locked then
    return jsonb_build_object('error','locked','reason',coalesce(t.lock_reason,''));
  end if;
  if t.finished_at is not null then
    return jsonb_build_object('finished',true,'team',t.name);
  end if;

  select * into s from public.stages where number = t.current_stage;

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
