// Fill these in from Supabase → Project Settings → API.
// The anon key is designed to be public; it is safe in a GitHub repo.
// Row Level Security is what protects your data, not the secrecy of this key.
// Never put the service_role key anywhere near this repository.

export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';

// Team logins are real Supabase Auth accounts using a synthetic address,
// so a team signs in with a name rather than an email.
export const TEAM_DOMAIN = 'hunt.invalid';

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const slugToEmail = s =>
  `${s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')}@${TEAM_DOMAIN}`;

export const roman = n =>
  ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'][n] || String(n);

export const clock = ms => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
