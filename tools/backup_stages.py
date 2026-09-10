#!/usr/bin/env python3
"""Back up and restore stage content.

    python3 tools/backup_stages.py                 # save a snapshot
    python3 tools/backup_stages.py --list          # snapshots on disk
    python3 tools/backup_stages.py --show 3 FILE   # print stage 3 from a snapshot
    python3 tools/backup_stages.py --restore 3 FILE   # put stage 3 back

Stage text lives in exactly one database row with no history behind it, so a
bad save or a re-run of a seed file loses it outright. Run this before and
after a writing session.

Snapshots go in tools/backups/ and are gitignored: they contain your answers.
--restore touches only the single stage you name, never the whole database.
"""

import json, os, sys, urllib.request as u, urllib.parse as up
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR  = os.path.join(ROOT, "tools", "backups")


def env():
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        sys.exit("No .env found.")
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
        r.add_header("Prefer", "return=representation")
    try:
        with u.urlopen(r) as resp:
            txt = resp.read().decode()
            return resp.status, (json.loads(txt) if txt.strip() else None)
    except Exception as ex:
        return getattr(ex, "code", 0), (ex.read().decode()[:300] if hasattr(ex, "read") else str(ex))


def snapshot(e):
    _, stages = api(e, "/rest/v1/stages?select=*&order=number")
    _, answers = api(e, "/rest/v1/stage_answers?select=*&order=stage_number")
    if not isinstance(stages, list):
        sys.exit(f"Could not read stages: {stages}")
    os.makedirs(DIR, exist_ok=True)
    name = datetime.now().strftime("stages-%Y-%m-%d-%H%M%S.json")
    path = os.path.join(DIR, name)
    json.dump({"taken": datetime.now().isoformat(), "stages": stages,
               "answers": answers or []}, open(path, "w", encoding="utf-8"), indent=2)
    written = sum(1 for s in stages if len(s.get("body_html") or "") > 200)
    print(f"Saved {len(stages)} stages ({written} with real content) "
          f"and {len(answers or [])} answers")
    print(" ", path)
    return path


def load(path):
    if not os.path.exists(path):
        sys.exit(f"No such snapshot: {path}")
    return json.load(open(path, encoding="utf-8"))


def cmd_list():
    if not os.path.isdir(DIR):
        return print("No snapshots yet. Run with no arguments to make one.")
    for f in sorted(os.listdir(DIR)):
        d = load(os.path.join(DIR, f))
        print(f"{f}   {len(d['stages'])} stages, {len(d['answers'])} answers   {d['taken'][:19]}")


def cmd_show(num, path):
    d = load(path)
    s = next((x for x in d["stages"] if x["number"] == num), None)
    if not s:
        sys.exit(f"Stage {num} not in that snapshot.")
    print(f"--- stage {num}: {s['title']} ({s['kind']}, min {s['min_seconds']}s) ---")
    print(s["subtitle"] or "(no subtitle)")
    print()
    print(s["body_html"])
    ans = [a for a in d["answers"] if a["stage_number"] == num]
    print("\nanswers:", ", ".join(f"{a['normalised']}{' [honeypot]' if a['is_honeypot'] else ''}"
                                  for a in ans) or "(none)")


def cmd_restore(e, num, path):
    d = load(path)
    s = next((x for x in d["stages"] if x["number"] == num), None)
    if not s:
        sys.exit(f"Stage {num} not in that snapshot.")
    _, live = api(e, "/rest/v1/stages?" + up.urlencode({"select": "title,body_html", "number": f"eq.{num}"}))
    print(f"live now : {live[0]['title']!r}, {len(live[0]['body_html'] or '')} chars")
    print(f"snapshot : {s['title']!r}, {len(s['body_html'] or '')} chars")
    if input(f"\nOverwrite stage {num} with the snapshot? [y/N] ").strip().lower() != "y":
        return print("Left alone.")
    status, body = api(e, f"/rest/v1/stages?number=eq.{num}", {
        "title": s["title"], "subtitle": s["subtitle"], "body_html": s["body_html"],
        "kind": s["kind"], "payload": s["payload"], "min_seconds": s["min_seconds"],
    }, "PATCH")
    print("restored." if status in (200, 204) else f"FAILED: {body}")


def main():
    a = sys.argv[1:]
    e = env()
    if not a:
        return snapshot(e)
    if a[0] == "--list":
        return cmd_list()
    if a[0] == "--show" and len(a) == 3:
        return cmd_show(int(a[1]), a[2])
    if a[0] == "--restore" and len(a) == 3:
        return cmd_restore(e, int(a[1]), a[2])
    print(__doc__)


if __name__ == "__main__":
    main()
