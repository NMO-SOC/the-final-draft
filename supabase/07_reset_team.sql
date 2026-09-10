-- reset_team(): put one team back to the start. Run after 06_leaderboard.sql.
--
-- Needed because a dry run leaves flags, penalties and attempts behind, and
-- there was no way to clear them except hand-written SQL. Note this cannot be
-- done from the client: penalties, attempts and events have no delete policy
-- for anyone, deliberately, so a team can never erase its own trail. This
-- function is the one sanctioned exception and it checks is_teacher() first.

create or replace function public.reset_team(p_team uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if not public.is_teacher() then return jsonb_build_object('error','not_teacher'); end if;

  select * into t from public.teams where id = p_team;
  if t.id is null then return jsonb_build_object('error','not_found'); end if;

  delete from public.penalties   where team_id = p_team;
  delete from public.attempts    where team_id = p_team;
  delete from public.hints       where team_id = p_team;
  delete from public.completions where team_id = p_team;
  delete from public.messages    where team_id = p_team;

  update public.teams
     set current_stage = 1, stage_entered_at = now(), started_at = now(),
         finished_at = null, penalty_ms = 0, flags = 0,
         locked = false, lock_reason = null, last_activity = now()
   where id = p_team;

  -- Clear the old trail last, then record that the reset happened, so the log
  -- explains why a team's history vanished.
  delete from public.events where team_id = p_team;
  perform public.log(p_team, 'team_reset', format('%s reset to stage 1', t.name), 'warn');

  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.reset_team(uuid) from public, anon;
grant execute on function public.reset_team(uuid) to authenticated;
