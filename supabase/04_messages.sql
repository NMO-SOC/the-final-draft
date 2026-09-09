-- Direct chat between a team and the teacher. Not part of the puzzle logic —
-- just a way for a team to ask something and a teacher to answer, per team.
-- Run this once, after 03_completions.sql.

create table if not exists public.messages (
  id            bigserial primary key,
  team_id       uuid not null references public.teams(id) on delete cascade,
  sender        text not null check (sender in ('team','teacher')),
  body          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists messages_lookup on public.messages (team_id, created_at);

alter table public.messages enable row level security;

create policy messages_select on public.messages for select
  using (public.is_teacher() or team_id = (select id from public.my_team()));

-- No update/delete policy for anyone: messages are append-only, so neither
-- side can go back and rewrite what was actually said.
create policy messages_team_insert on public.messages for insert
  with check (sender = 'team' and team_id = (select id from public.my_team()));

create policy messages_teacher_insert on public.messages for insert
  with check (public.is_teacher() and sender = 'teacher');

alter publication supabase_realtime add table public.messages;
