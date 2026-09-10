#!/usr/bin/env python3
"""Create team logins from a sign-up sheet.

    python3 tools/make_teams.py teams.txt            # create them
    python3 tools/make_teams.py teams.txt --dry-run  # show what would happen
    python3 tools/make_teams.py --list               # existing teams

teams.txt is one team name per line; blank lines and # comments ignored.

This runs on your machine and reads SUPABASE_SERVICE_ROLE_KEY from .env,
because creating auth users needs that key and it must never reach a browser.

The login email is derived from the team name using exactly the same rule as
assets/config.js (lowercase, strip anything not a letter or digit). That is
what keeps "what the student types" and "the account that exists" in step --
get them out of step and the team simply cannot log in.

Passwords are shown once here and stored hashed in Supabase. The files written
to tools/out/ are the only copy, and that folder is gitignored.
"""

import json, os, re, secrets, sys, urllib.request as u
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "tools", "out")
DOMAIN = "hunt.invalid"

# No 0/O/1/l/i: these get typed on phones, by tired teenagers, from paper.
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def slugify(name):
    return re.sub(r"[^a-z0-9]", "", name.strip().lower())


def make_password():
    pick = lambda n: "".join(secrets.choice(ALPHABET) for _ in range(n))
    return f"{pick(4)}-{pick(4)}"


def env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        sys.exit("No .env found next to the project. Cannot continue.")
    e = dict(l.strip().split("=", 1) for l in open(path) if "=" in l and not l.startswith("#"))
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not e.get(k):
            sys.exit(f"{k} missing from .env")
    return e


def api(e, path, data=None, method=None):
    body = json.dumps(data).encode() if data is not None else None
    r = u.Request(e["SUPABASE_URL"] + path, data=body, method=method or ("POST" if body else "GET"))
    r.add_header("apikey", e["SUPABASE_SERVICE_ROLE_KEY"])
    r.add_header("Authorization", "Bearer " + e["SUPABASE_SERVICE_ROLE_KEY"])
    if body:
        r.add_header("Content-Type", "application/json")
    try:
        with u.urlopen(r) as resp:
            txt = resp.read().decode()
            return resp.status, (json.loads(txt) if txt.strip() else None)
    except Exception as ex:
        detail = ex.read().decode()[:300] if hasattr(ex, "read") else str(ex)
        return getattr(ex, "code", 0), detail


def existing(e):
    _, teams = api(e, "/rest/v1/teams?select=id,name,slug")
    _, users = api(e, "/auth/v1/admin/users?per_page=500")
    emails = {x["email"].lower() for x in (users or {}).get("users", [])}
    return (teams or []), emails


def cmd_list(e):
    teams, emails = existing(e)
    if not teams:
        print("No teams yet.")
        return
    print(f"{'team':<24}{'slug':<18}{'login exists'}")
    for t in sorted(teams, key=lambda t: t["name"].lower()):
        print(f"{t['name']:<24}{t['slug']:<18}{'yes' if t['slug']+'@'+DOMAIN in emails else 'NO'}")


def write_outputs(rows):
    os.makedirs(OUT, exist_ok=True)
    stamp = date.today().isoformat()
    csv_path = os.path.join(OUT, f"logins-{stamp}.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        f.write("Team name,Password\r\n")
        for r in rows:
            f.write('"{}","{}"\r\n'.format(r["name"].replace('"', '""'), r["password"]))

    esc = lambda s: (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    cards = "\n".join(
        f'''  <div class="card">
    <p class="lbl">Team name &mdash; type it exactly</p>
    <p class="team">{esc(r["name"])}</p>
    <p class="lbl">Password</p>
    <p class="pw">{esc(r["password"])}</p>
  </div>''' for r in rows)

    html_path = os.path.join(OUT, f"logins-{stamp}.html")
    open(html_path, "w", encoding="utf-8").write(f"""<!doctype html>
<meta charset="utf-8"><title>The Last Draft &mdash; team cards</title>
<style>
  @page {{ margin: 12mm; }}
  body {{ font-family: Georgia, 'Times New Roman', serif; color:#111; background:#fff; margin:0; }}
  h1 {{ font-size:15pt; font-weight:500; margin:0 0 6mm; }}
  .sheet {{ display:grid; grid-template-columns:1fr 1fr; gap:6mm; }}
  .card {{ border:1px solid #999; padding:6mm; break-inside:avoid; }}
  .lbl {{ font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:#666; margin:0 0 1mm; }}
  .team {{ font-size:15pt; margin:0 0 4mm; }}
  .pw {{ font-family:'Courier New',monospace; font-size:15pt; letter-spacing:.06em; margin:0; }}
  @media print {{ .noprint {{ display:none; }} }}
</style>
<h1>The Last Draft &mdash; team cards</h1>
<p class="noprint" style="font-size:9pt;color:#666">
  {len(rows)} card(s). Print this page, cut along the boxes, hand one to each team.
  Keep the spare copy: passwords cannot be read back out of the system.</p>
<div class="sheet">
{cards}
</div>
""")
    return csv_path, html_path


def cmd_create(e, names, dry):
    teams, emails = existing(e)
    by_slug = {t["slug"]: t for t in teams}
    # Also index by name: an older team may have been created by hand with a
    # slug that does not match its name (e.g. "The Pemberleys" -> "pemberleys").
    # Matching on slug alone would then happily make a second team of the same
    # name, and the two would fight over the same sign-up sheet entry.
    by_name = {t["name"].strip().lower(): t for t in teams}

    planned, skipped = [], []
    seen = set()
    for name in names:
        slug = slugify(name)
        if not slug:
            skipped.append((name, "no usable characters in name"))
            continue
        if slug in seen:
            skipped.append((name, "duplicate in your list"))
            continue
        seen.add(slug)
        clash = by_name.get(name.strip().lower())
        if clash and clash["slug"] != slug:
            skipped.append((name, f"already exists but signs in as \"{clash['slug']}\" "
                                  f"— students typing \"{name.strip()}\" cannot log in"))
            continue
        if slug in by_slug or f"{slug}@{DOMAIN}" in emails:
            skipped.append((name, f"already exists as {slug}@{DOMAIN}"))
            continue
        planned.append({"name": name.strip(), "slug": slug,
                        "email": f"{slug}@{DOMAIN}", "password": make_password()})

    for name, why in skipped:
        print(f"  skip  {name}  ({why})")
    for p in planned:
        print(f"  make  {p['name']}  ->  {p['email']}")

    if dry:
        print(f"\nDry run: {len(planned)} would be created, {len(skipped)} skipped. Nothing written.")
        return
    if not planned:
        print("\nNothing to create.")
        return

    made = []
    for p in planned:
        status, body = api(e, "/auth/v1/admin/users",
                           {"email": p["email"], "password": p["password"], "email_confirm": True})
        if not isinstance(body, dict) or "id" not in body:
            print(f"  FAILED user {p['email']}: {body}")
            continue
        status, tbody = api(e, "/rest/v1/teams",
                            [{"auth_uid": body["id"], "name": p["name"], "slug": p["slug"]}])
        if status not in (200, 201):
            print(f"  FAILED team {p['name']}: {tbody}")
            api(e, f"/auth/v1/admin/users/{body['id']}", method="DELETE")   # don't leave an orphan
            continue
        made.append(p)
        print(f"  created {p['name']}")

    if made:
        csv_path, html_path = write_outputs(made)
        print(f"\nCreated {len(made)} team(s).")
        print(f"  {csv_path}")
        print(f"  {html_path}   <- print this and cut it up")
        print("\nThese files are the only copy of the passwords. They are gitignored; keep them safe.")


def main():
    args = [a for a in sys.argv[1:]]
    e = env()
    if "--list" in args:
        return cmd_list(e)
    dry = "--dry-run" in args
    files = [a for a in args if not a.startswith("--")]
    if not files:
        return print(__doc__)
    names = []
    for path in files:
        if not os.path.exists(path):
            sys.exit(f"No such file: {path}")
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                names.append(line)
    if not names:
        sys.exit("No team names found in that file.")
    print(f"{len(names)} name(s) read.\n")
    cmd_create(e, names, dry)


if __name__ == "__main__":
    main()
