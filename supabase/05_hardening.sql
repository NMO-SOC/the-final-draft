-- Hardening pass. Run this once, after 04_messages.sql.
--
-- Two problems this fixes.
--
-- 1. insert_answer() and update_answer() were created directly in the SQL
--    editor while building the stage editor, so they never went through the
--    same review as the rest. Both are SECURITY DEFINER and neither checked
--    is_teacher(). Postgres grants EXECUTE to PUBLIC by default, so ANY
--    caller — a signed-in student, or an anonymous visitor holding the anon
--    key that ships in assets/config.js — could set or overwrite the answer
--    to any stage:
--
--      sb.rpc('insert_answer', {p_stage:10, p_val:'x', p_honey:false, p_note:null})
--
--    That is a total break: instant win, and worse, marking a correct answer
--    as a honeypot would silently flag every honest team that submitted it.
--    The RLS on stage_answers did not help — SECURITY DEFINER bypasses it.
--
-- 2. Every RPC was executable by the anon role, i.e. before logging in at all.
--    Nothing here needs that; the hunt requires a session.

-- ---------------------------------------------------------------------------
-- 1. Put the teacher check inside the two answer functions.
--    (sql -> plpgsql so they can raise.)
-- ---------------------------------------------------------------------------
create or replace function public.insert_answer(
  p_stage integer, p_val text, p_honey boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  insert into public.stage_answers (stage_number, normalised, is_honeypot, note)
  values (p_stage, public.norm(p_val), p_honey, p_note);
end $$;

create or replace function public.update_answer(
  p_id bigint, p_val text, p_honey boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_teacher() then raise exception 'not authorised'; end if;
  update public.stage_answers
     set normalised = public.norm(p_val), is_honeypot = p_honey, note = p_note
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Nothing is callable before signing in. The internal helpers are not
--    callable by anyone: the functions that use them are SECURITY DEFINER and
--    run as the owner, so the caller never needs EXECUTE of their own.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.get_stage(), public.submit_answer(text, boolean, int),
  public.request_hint(int), public.submit_completion(text),
  public.send_hint(bigint, text), public.apply_penalty(uuid, bigint, text),
  public.set_lock(uuid, boolean, text), public.set_stage(uuid, int),
  public.approve_completion(bigint), public.reject_completion(bigint, text),
  public.insert_answer(integer, text, boolean, text),
  public.update_answer(bigint, text, boolean, text)
from public, anon;

grant execute on function
  public.get_stage(), public.submit_answer(text, boolean, int),
  public.request_hint(int), public.submit_completion(text),
  public.send_hint(bigint, text), public.apply_penalty(uuid, bigint, text),
  public.set_lock(uuid, boolean, text), public.set_stage(uuid, int),
  public.approve_completion(bigint), public.reject_completion(bigint, text),
  public.insert_answer(integer, text, boolean, text),
  public.update_answer(bigint, text, boolean, text)
to authenticated;

-- Internal only. log() in particular: a student could otherwise write
-- arbitrary lines into the activity feed the teacher uses as evidence,
-- including lines attributed to another team.
revoke execute on function
  public.log(uuid, text, text, text), public.cooldown_seconds(uuid, int)
from public, anon, authenticated;

-- is_teacher() and my_team() are used inside the RLS policies themselves, so
-- they must stay executable by the role doing the querying.
grant execute on function public.is_teacher(), public.my_team() to authenticated;
revoke execute on function public.is_teacher(), public.my_team() from anon;

-- ---------------------------------------------------------------------------
-- 3. settings held the open/close window and the freeze flag and was readable
--    with `using (true)` — i.e. by the whole internet. Only a signed-in user
--    needs it.
-- ---------------------------------------------------------------------------
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select
  using (auth.uid() is not null);
