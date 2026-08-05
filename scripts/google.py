#!/usr/bin/env python3
"""Marveen Google Workspace olvaso-CLI (Gmail / Calendar / Drive).

CSAK OLVASAS. A kuldes/modositas/megosztas az autonomy-config szerint level2
(jovahagyas) -- az itt nincs implementalva szandekosan.

A friss access_token-t a scripts/google-auth.py token adja (auto-refresh).
Minden parancs egy sort ir a store/event-log.txt esemeny-logba (ok/error).

Parancsok:
  mai-naptar           mai naptar-esemenyek (Europe/Budapest)
  kovetkezo-esemeny    a kovetkezo kozelgo esemeny
  utolso-emailek [N]   utolso N email (alap 5), spam/promo szurve
  olvasatlan [N]       olvasatlan / fontos emailek (alap 10)
  drive-legutobbi [N]  Drive legutobb modositott fajlok (alap 10)
  napi-osszefoglalo    rovid napi riport: fontos olvasatlan + kovetkezo esemeny
"""
import json, os, sys, subprocess, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Budapest")
except Exception:
    TZ = timezone(timedelta(hours=2))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENTLOG = os.path.join(ROOT, "store", "event-log.txt")


def _log(op, status, msg=""):
    """Egy sor a kozos esemeny-logba (ugyanaz a formatum mint scripts/eventlog.sh)."""
    try:
        ts = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
        msg = " ".join(str(msg).split())[:200]
        with open(EVENTLOG, "a") as f:
            f.write(f"{ts} | {op:<22} | {status.upper():<5} | {msg}\n")
    except Exception:
        pass  # a log sose bukjon el a fo muvelet miatt


def _token():
    out = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "google-auth.py"), "token"],
                         capture_output=True, text=True)
    if out.returncode != 0 or not out.stdout.strip():
        raise RuntimeError("nem sikerult access_token (lehet lejart -- ujra: python3 scripts/google-auth.py auth). " + out.stderr.strip()[:120])
    return out.stdout.strip()


def _get(url, at):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {at}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Google API {e.code}: {e.read().decode('utf-8','replace')[:120]}")


def _fmt_dt(s):
    if len(s) == 10:
        return s + " (egesz nap)"
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(TZ).strftime("%H:%M")
    except Exception:
        return s


def _headers(msg, want):
    h = {x["name"].lower(): x["value"] for x in msg.get("payload", {}).get("headers", [])}
    return {w: h.get(w, "") for w in want}


def _list_messages(at, query, n):
    q = urllib.parse.urlencode({"q": query, "maxResults": str(n)})
    data = _get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{q}", at)
    out = []
    for m in data.get("messages", [])[:n]:
        full = _get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m['id']}?format=metadata&metadataHeaders=From&metadataHeaders=Subject", at)
        hh = _headers(full, ["from", "subject"])
        frm = hh["from"].split("<")[0].strip().strip('"') or hh["from"]
        out.append((frm[:32], hh["subject"][:60] or "(nincs targy)"))
    return out


def _list_ids(at, query, cap=100):
    """Tenyleges uzenet-id-k (a resultSizeEstimate megbizhatatlan, ezert valodi listat szamolunk)."""
    q = urllib.parse.urlencode({"q": query, "maxResults": str(cap)})
    data = _get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages?{q}", at)
    return [m["id"] for m in data.get("messages", [])]


def _meta(at, mid):
    full = _get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject", at)
    hh = _headers(full, ["from", "subject"])
    frm = hh["from"].split("<")[0].strip().strip('"') or hh["from"]
    return frm[:32], hh["subject"][:60] or "(nincs targy)"


def _next_event(at):
    now = datetime.now(TZ)
    q = urllib.parse.urlencode({"timeMin": now.isoformat(), "maxResults": "1",
                                "singleEvents": "true", "orderBy": "startTime"})
    items = _get(f"https://www.googleapis.com/calendar/v3/calendars/primary/events?{q}", at).get("items", [])
    if not items:
        return None
    e = items[0]; st = e.get("start", {}); t = st.get("dateTime") or st.get("date", "")
    try:
        when = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(TZ).strftime("%Y-%m-%d %H:%M") if len(t) > 10 else t + " (egesz nap)"
    except Exception:
        when = t
    return when, e.get("summary", "(nincs cim)"), e.get("location", "")


IMPORTANT_UNREAD = "is:unread in:inbox -category:promotions -category:social"


def cmd_mai_naptar():
    at = _token()
    start = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    q = urllib.parse.urlencode({"timeMin": start.isoformat(), "timeMax": (start + timedelta(days=1)).isoformat(),
                                "singleEvents": "true", "orderBy": "startTime"})
    items = _get(f"https://www.googleapis.com/calendar/v3/calendars/primary/events?{q}", at).get("items", [])
    if not items:
        print("Ma nincs naptar-esemeny."); return
    print(f"Mai naptar ({start.strftime('%Y-%m-%d')}):")
    for e in items:
        st = e.get("start", {}); print(f"  {_fmt_dt(st.get('dateTime') or st.get('date',''))}  {e.get('summary','(nincs cim)')}")


def cmd_kovetkezo():
    ne = _next_event(_token())
    if not ne:
        print("Nincs kozelgo esemeny."); return
    when, summ, loc = ne
    print(f"Kovetkezo esemeny: {when} - {summ}")
    if loc: print(f"  Helyszin: {loc}")


def cmd_utolso(n=5):
    rows = _list_messages(_token(), "in:inbox -category:promotions -category:social", n)
    if not rows: print("Nincs friss email."); return
    print(f"Utolso {len(rows)} email:")
    for frm, subj in rows: print(f"  {frm} | {subj}")


def cmd_olvasatlan(n=10):
    rows = _list_messages(_token(), IMPORTANT_UNREAD, n)
    if not rows: print("Nincs olvasatlan email az Inboxban."); return
    print(f"Olvasatlan ({len(rows)}):")
    for frm, subj in rows: print(f"  {frm} | {subj}")


def cmd_drive(n=10):
    at = _token()
    q = urllib.parse.urlencode({"orderBy": "modifiedTime desc", "pageSize": str(n),
                                "fields": "files(name,modifiedTime,mimeType)", "q": "trashed=false"})
    files = _get(f"https://www.googleapis.com/drive/v3/files?{q}", at).get("files", [])
    if not files: print("Nincs Drive fajl."); return
    print(f"Drive legutobbi {len(files)} fajl:")
    for f in files:
        kind = f.get("mimeType", "").split(".")[-1].split("/")[-1]
        print(f"  {f.get('modifiedTime','')[:10]}  {f.get('name','')[:50]}  [{kind}]")


def cmd_napi():
    at = _token()
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    ids = _list_ids(at, IMPORTANT_UNREAD, 100)
    count = f"{len(ids)}+" if len(ids) >= 100 else str(len(ids))
    ne = _next_event(at)
    print(f"Napi osszefoglalo - {today}")
    print(f"Fontos olvasatlan email: {count}")
    for mid in ids[:5]:
        frm, subj = _meta(at, mid)
        print(f"  - {frm} | {subj}")
    if ne:
        when, summ, _ = ne
        print(f"Kovetkezo esemeny: {when} - {summ}")
    else:
        print("Kovetkezo esemeny: nincs kozelgo naptar-esemeny.")


DISPATCH = {
    "mai-naptar": cmd_mai_naptar, "today": cmd_mai_naptar,
    "kovetkezo-esemeny": cmd_kovetkezo, "next": cmd_kovetkezo,
    "utolso-emailek": lambda: cmd_utolso(_n(5)), "recent": lambda: cmd_utolso(_n(5)),
    "olvasatlan": lambda: cmd_olvasatlan(_n(10)), "unread": lambda: cmd_olvasatlan(_n(10)),
    "drive-legutobbi": lambda: cmd_drive(_n(10)), "drive": lambda: cmd_drive(_n(10)),
    "napi-osszefoglalo": cmd_napi, "daily": cmd_napi,
}


def _n(default):
    return int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else default


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "mai-naptar"
    fn = DISPATCH.get(cmd)
    if not fn:
        print("Ismeretlen parancs. Elerheto: mai-naptar, kovetkezo-esemeny, utolso-emailek [N], olvasatlan [N], drive-legutobbi [N], napi-osszefoglalo")
        sys.exit(1)
    try:
        fn()
        _log("google:" + cmd, "ok")
    except Exception as e:
        _log("google:" + cmd, "error", str(e))
        print(f"HIBA ({cmd}): {e}", file=sys.stderr)
        sys.exit(1)
