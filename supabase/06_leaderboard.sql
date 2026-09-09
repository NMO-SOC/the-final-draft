-- Leaderboard. Run this once, after 05_hardening.sql.
--
-- The public.leaderboard view already existed but nothing ever read it, and
-- it carries `flags` — which team has been caught doing what. That must never
-- reach a student, so students go through this function instead and the raw
-- view stops being readable by them.
--
-- The leaderboard_on toggle is honoured here rather than in the browser: a
-- client-side check would be one devtools call away from being ignored.

create or replace function public.get_leaderboard()
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg public.settings; rows jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('error','no_session'); end if;

  select * into cfg from public.settings where id = 1;
  if not cfg.leaderboard_on and not public.is_teacher() then
    return jsonb_build_object('error','off');
  end if;

  -- Finished teams first by finishing time, then everyone else by stage.
  -- Name, stage and finish only: no flags, no penalties, no answers.
  select coalesce(jsonb_agg(
           jsonb_build_object('name', t.name, 'stage', t.current_stage,
                              'finished_at', t.finished_at)
           order by (t.finished_at is null), t.finished_at asc, t.current_stage desc
         ), '[]'::jsonb)
    into rows
  from public.teams t;

  return jsonb_build_object('ok', true, 'teams', rows);
end $$;

revoke execute on function public.get_leaderboard() from public, anon;
grant execute on function public.get_leaderboard() to authenticated;

-- The view keeps flags, so it is for the service role and the SQL editor only.
revoke select on public.leaderboard from authenticated, anon;
