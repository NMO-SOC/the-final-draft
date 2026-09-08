# The Great Literary Hunt

Ten-stage literary scavenger hunt. GitHub Pages serves the site; Supabase holds
the answers, the progress and the activity log. No answer is ever sent to the
browser.

## Set up

1. **Create the repo** — `NMO-SOC/literary-hunt`, push these files, then
   Settings → Pages → deploy from `main` / root. It lands at
   `https://nmo-soc.github.io/literary-hunt/`.

2. **Create a Supabase project.** In the SQL editor run `supabase/01_schema.sql`,
   then `supabase/02_seed.sql`.

3. **Fill in `assets/config.js`** with the project URL and the *anon* key from
   Project Settings → API. The anon key is meant to be public — RLS is what
   protects the data. The `service_role` key must never go in this repo.

4. **Make yourself a teacher.** Authentication → Users → Add user (your school
   email, any password). Then in SQL:
   ```sql
   insert into public.teachers (auth_uid, name)
   select id, 'Teacher' from auth.users where email = 'you@education.vic.gov.au';
   ```

5. **Make the teams.** One Auth user per team, using a synthetic address so
   students sign in with a team name:
   - email `pemberleys@hunt.invalid`, password whatever you print on their card
   - Auto-confirm the user (Supabase asks).
   Then link it:
   ```sql
   insert into public.teams (auth_uid, name, slug, started_at)
   select id, 'The Pemberleys', 'pemberleys', now()
   from auth.users where email = 'pemberleys@hunt.invalid';
   ```

6. **Set the answers.** In `02_seed.sql` every stage marked `REPLACEME` needs
   its real answer:
   ```sql
   update public.stage_answers set normalised = public.norm('Whitby')
   where stage_number = 1 and normalised = 'REPLACEME';
   ```
   Answers are compared with case, spacing and punctuation stripped.

7. **Set the window** so the hunt is unreachable in class time:
   ```sql
   update public.settings
   set opens_at = '2026-09-15 15:30+10', closes_at = '2026-09-19 21:00+10';
   ```
   This is checked in the database on every request, not in the browser.

## What stops cheating

| Device | What it does |
|---|---|
| Server-side answers | Nothing in the page source, DevTools or the network tab reveals a password. |
| Row Level Security | A team can read its own row and nothing else. |
| Escalating cooldowns | 15s, 30s, 60s, then 120s after each wrong answer. Guessing stops paying. |
| Minimum stage time | Solving under the floor is flagged, not blocked. |
| Honeypot answers | Confident wrong answers a machine produces are stored and flagged on submission. |
| Paste and blur logging | Recorded with the attempt. Context, not proof. |
| Teacher-applied penalties | The system flags, you decide. Nothing is punished automatically. |

Tell students that pasting and tab-switching are logged. The deterrent does
more work than the detection.

## What this does not do

It cannot stop a student photographing the screen and asking a model. Stages I,
V and VI defend against that by requiring something physically in the building;
Stage II by being text that exists nowhere else. Stage IV is deliberately the
weak one — see the comment at the top of `assets/grid.js`.

## Adding a hint

Hints are not automatic. A team requests one, it appears in your queue, you
type what they see and press send. The cost is applied when you send it.
