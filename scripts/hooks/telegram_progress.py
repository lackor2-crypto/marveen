#!/usr/bin/env python3
"""
UserPromptSubmit hook — Telegram "processing" indicator.

When an inbound Telegram channel message is delivered to the agent, this:
  1) reacts with ✍️ on the user's message (a persistent "received" marker), and
  2) posts a "✍️ Dolgozom rajta…" placeholder message,
then records the placeholder id so the Stop hook can delete it when the turn
ends. This is the honest alternative to a "typing…" action (which only lasts
~5s and lies, since the model is thinking, not typing).

Kanban 34f8f2dc (Boss, Telegram uzenet 808, 2026-09-08): "megneztem es 100%
on alsz! tehat eselyed sincs hogy dolgozz rajta ahogyan most allitja ez az
uzenet ... ez bug, mert hazudik a telegram. ilyenkor nem ezt kelene kuldeni
hogy dolgozom rajta, hanem azt hogy jelenleg kifogytam a tokenekbol, 100%-on
vagyok, es nem tudom fogadni a kereseidet eddig es eddig." Before posting the
placeholder, this hook now checks the agent's OWN 5-hour rate-limit snapshot
(the same file rate-limit-guard.py reads, store/rate-limit-status/<agent>.json)
-- if it is fresh AND at/over the CRITICAL threshold (mirrors
CRITICAL_THRESHOLD_PCT in rate-limit-guard.py / src/rate-limit-status.ts), it
sends an honest status message with a concrete "X ora Y percig" ETA instead of
the placeholder, and does NOT track it for the Stop-hook cleanup path (it is a
real, permanent status message, not a "still working" placeholder to delete).
If the snapshot is missing, stale or the window has already rolled over, this
falls through to the normal placeholder -- an unreliable number must not be
guessed at (see recheck-before-restating doctrine), it must simply not gate
anything.

MUST stay silent on stdout — stdout from UserPromptSubmit is injected into the
model prompt. All diagnostics go to a debug log file under the state dir.

Token/state dir resolution mirrors the telegram plugin: honor TELEGRAM_STATE_DIR
(set per-agent), else default to ~/.claude/channels/telegram. This keeps the
hook correct even if installed globally across agents with different bots.
"""
import sys, os, json, re, time, urllib.request

PLACEHOLDER = "✍️ Dolgozom rajta…"   # ✍️ Dolgozom rajta…
REACTION = "✍️"                            # ✍️

CRITICAL_THRESHOLD_PCT = 95  # mirrors rate-limit-guard.py / src/rate-limit-status.ts
STALE_AFTER_MS = 30 * 60_000


# --- Rate-limit snapshot reading (mirrors rate-limit-guard.py) --------------

def read_env_value(env_path, key):
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line.startswith(key + '='):
                    continue
                v = line[len(key) + 1:]
                if v[:1] in ('"', "'") and v[-1:] == v[:1]:
                    v = v[1:-1]
                return v
    except OSError:
        pass
    return None


def find_project_root(cwd):
    """Same walk-upward-for-.env logic as rate-limit-guard.py's
    find_project_root -- kept as a separate copy on purpose, since each hook
    is copied standalone to ~/.claude/hooks/ at install time and must not
    depend on a sibling file being present there."""
    if not cwd:
        return None
    d = os.path.abspath(cwd)
    while True:
        env_path = os.path.join(d, '.env')
        if os.path.isfile(env_path) and read_env_value(env_path, 'MAIN_AGENT_ID') is not None:
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def resolve_agent_id(cwd, project_root):
    if os.path.abspath(cwd) == os.path.abspath(project_root):
        return read_env_value(os.path.join(project_root, '.env'), 'MAIN_AGENT_ID') or 'main'
    agents_base = os.path.abspath(os.path.join(project_root, 'agents')) + os.sep
    if os.path.abspath(cwd).startswith(agents_base):
        return os.path.abspath(cwd)[len(agents_base):].split(os.sep)[0]
    return None


def five_hour_state(snap, now_ms):
    """(used_pct, resets_at_ms) for the 5-hour window if the snapshot is fresh
    and the window has not already rolled over, else None. Mirrors pct_of() +
    the resetsAt-authority rule in rate-limit-guard.py: usedPct only means
    anything while resetsAt is still in the future."""
    if not isinstance(snap, dict):
        return None
    updated_at = snap.get('updatedAt')
    if not isinstance(updated_at, (int, float)):
        return None
    if now_ms - updated_at >= STALE_AFTER_MS:
        return None
    window = snap.get('fiveHour')
    if not isinstance(window, dict):
        return None
    resets_at = window.get('resetsAt')
    used_pct = window.get('usedPct')
    if not isinstance(resets_at, (int, float)) or resets_at <= now_ms:
        return None
    if not isinstance(used_pct, (int, float)):
        return None
    return used_pct, resets_at


def format_wait_hu(resets_at_ms, now_ms):
    """'{H} ora {M} percig' / '{M} percig' -- the ETA phrasing Boss asked for
    (uzenet 808: "3 ora 35 perc ig")."""
    remaining_min = max(0, round((resets_at_ms - now_ms) / 60_000))
    hours, minutes = divmod(remaining_min, 60)
    if hours > 0:
        return f"{hours} óra {minutes} percig"
    return f"{minutes} percig"


def quota_honest_message(used_pct, resets_at_ms, now_ms):
    eta = format_wait_hu(resets_at_ms, now_ms)
    try:
        import datetime
        from zoneinfo import ZoneInfo
        local = datetime.datetime.fromtimestamp(
            resets_at_ms / 1000, tz=ZoneInfo("Europe/Budapest")
        ).strftime("%H:%M")
        until = f" (kb. {local}-ig, Europe/Budapest)"
    except Exception:
        until = ""
    return (
        f"⏳ Jelenleg kifogytam a token-keretemből: az 5 órás keretem {round(used_pct)}%-on áll. "
        f"Kb. {eta} nem tudom rendesen fogadni/feldolgozni a kéréseidet{until}, utána újra itt vagyok."
    )


def quota_status_message_if_critical(cwd, now_ms=None):
    """Returns the honest status text if the agent's own 5-hour snapshot is
    fresh and at/over CRITICAL_THRESHOLD_PCT, else None (proceed normally)."""
    if now_ms is None:
        now_ms = time.time() * 1000
    project_root = find_project_root(cwd)
    if not project_root:
        return None
    agent_id = resolve_agent_id(cwd, project_root)
    if not agent_id:
        return None
    snapshot_path = os.path.join(project_root, 'store', 'rate-limit-status', f'{agent_id}.json')
    try:
        with open(snapshot_path) as f:
            snap = json.load(f)
    except (OSError, ValueError):
        return None
    state = five_hour_state(snap, now_ms)
    if state is None:
        return None
    used_pct, resets_at = state
    if used_pct < CRITICAL_THRESHOLD_PCT:
        return None
    return quota_honest_message(used_pct, resets_at, now_ms)


def state_dir():
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    return os.path.expanduser("~/.claude/channels/telegram")


def log(sd, msg):
    try:
        os.makedirs(os.path.join(sd, "progress"), exist_ok=True)
        with open(os.path.join(sd, "progress", "debug.log"), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass


def token(sd):
    try:
        for line in open(os.path.join(sd, ".env"), encoding="utf-8"):
            line = line.strip()
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception:
        return None
    return None


def api(tok, method, payload):
    url = f"https://api.telegram.org/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def claim(progress_dir, sid, src_mid):
    """Atomic per-inbound-message guard. Returns True if THIS invocation claimed
    the message (proceed), False if another already did (skip). Prevents double
    placeholders if the hook is ever registered at two scopes (global + project)
    that both fire for the same prompt. O_EXCL makes the claim race-safe."""
    if not src_mid:
        return True
    try:
        os.makedirs(progress_dir, exist_ok=True)
        marker = os.path.join(progress_dir, f"seen-{sid}-{src_mid}.marker")
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        return True
    except FileExistsError:
        return False
    except Exception:
        return True  # never let the guard block the indicator


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        return
    prompt = ev.get("prompt") or ""
    sid = ev.get("session_id") or "default"
    # Stash the transcript path so the standalone watchdog (which gets no hook
    # event) can read the agent's final answer + detect a hung reply tool call
    # for a placeholder that never got cleared. Absent on some CC versions ->
    # the watchdog just falls back to its generic-error behavior.
    transcript_path = ev.get("transcript_path") or ""
    sd = state_dir()

    blocks = re.findall(r'<channel\b[^>]*\bsource="[^"]*telegram[^"]*"[^>]*>', prompt)
    if not blocks:
        return  # not a telegram turn — stay silent
    log(sd, f"[submit] sid={sid} blocks={len(blocks)} state_dir={sd}")

    tok = token(sd)
    if not tok:
        log(sd, "[submit] no token found")
        return

    # Kanban 34f8f2dc: know BEFORE sending anything whether our own 5-hour
    # frame is already critical -- if so, the placeholder would be a lie.
    honest_status = quota_status_message_if_critical(os.getcwd())
    if honest_status:
        log(sd, "[submit] critical quota -- sending honest status instead of placeholder")

    pending = []
    for b in blocks:
        cid = re.search(r'\bchat_id="([^"]+)"', b)
        mid = re.search(r'\bmessage_id="([^"]+)"', b)
        if not cid:
            continue
        chat_id = cid.group(1)
        src_mid = mid.group(1) if mid else None
        # Dedup: skip if a sibling invocation already handled this inbound msg.
        if not claim(os.path.join(sd, "progress"), sid, src_mid):
            log(sd, f"[submit] dedup skip src={src_mid}")
            continue
        if honest_status:
            # A real, permanent status message -- not a "still working"
            # placeholder, so it is NOT stored in pending for the Stop hook to
            # delete later.
            try:
                api(tok, "sendMessage", {"chat_id": chat_id, "text": honest_status})
            except Exception as e:
                log(sd, f"[submit] honest status send failed: {e}")
            continue
        # Note: no reaction on the user's message — the "Dolgozom rajta…"
        # placeholder already signals receipt, so a reaction would be redundant
        # (per user preference 2026-06-07).
        try:
            resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": PLACEHOLDER, "disable_notification": True})
            pmid = resp.get("result", {}).get("message_id")
            if pmid:
                entry = {"chat_id": chat_id, "message_id": pmid}
                if transcript_path:
                    entry["transcript_path"] = transcript_path
                pending.append(entry)
        except Exception as e:
            log(sd, f"[submit] placeholder failed: {e}")

    if pending:
        path = os.path.join(sd, "progress", f"{sid}.json")
        old = []
        try:
            old = json.load(open(path))
        except Exception:
            old = []
        try:
            json.dump(old + pending, open(path, "w"))
            log(sd, f"[submit] stored {len(pending)} placeholder(s)")
        except Exception as e:
            log(sd, f"[submit] store failed: {e}")


def _self_test():
    """Pure checks for the quota-honesty gate (kanban 34f8f2dc). Run by the
    suite (src/__tests__/hook-self-tests.test.ts) -- a self-test nobody calls
    is not a test."""
    import tempfile

    fails = []

    def check(name, got, want):
        if got != want:
            fails.append("%s: expected %r, got %r" % (name, want, got))

    now = 1_000_000_000_000  # arbitrary fixed epoch ms for deterministic math

    # five_hour_state: fresh + window in the future -> usable
    fresh = {
        "updatedAt": now - 60_000,
        "fiveHour": {"usedPct": 100, "resetsAt": now + (3 * 3600_000 + 35 * 60_000)},
    }
    st = five_hour_state(fresh, now)
    check("fresh snapshot usable", st is not None, True)
    check("fresh snapshot pct", st[0] if st else None, 100)

    # Stale updatedAt -> unknown, must NOT gate anything (recheck doctrine).
    stale = {
        "updatedAt": now - STALE_AFTER_MS - 1,
        "fiveHour": {"usedPct": 100, "resetsAt": now + 3600_000},
    }
    check("stale snapshot ignored", five_hour_state(stale, now), None)

    # Window already rolled over (resetsAt in the past) -> unknown, same rule
    # as rate-limit-guard.py's pct_of().
    rolled_over = {
        "updatedAt": now - 1000,
        "fiveHour": {"usedPct": 98, "resetsAt": now - 1000},
    }
    check("rolled-over window ignored", five_hour_state(rolled_over, now), None)

    # Below critical threshold -> no honest-status override.
    below = {
        "updatedAt": now - 1000,
        "fiveHour": {"usedPct": 40, "resetsAt": now + 3600_000},
    }
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "store", "rate-limit-status"))
        with open(os.path.join(d, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=main\n")
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump(below, f)
        check("below threshold -> normal placeholder",
              quota_status_message_if_critical(d, now), None)

        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump(fresh, f)
        msg = quota_status_message_if_critical(d, now)
        check("at/over threshold -> honest message", msg is not None, True)
        check("honest message names the ETA", "3 óra 35 percig" in (msg or ""), True)
        check("honest message is not the lie", PLACEHOLDER in (msg or ""), False)

        # A missing snapshot file (fresh install, no statusline tick yet)
        # must not throw and must not gate -- there is simply nothing to say.
        os.remove(os.path.join(d, "store", "rate-limit-status", "main.json"))
        check("missing snapshot -> normal placeholder",
              quota_status_message_if_critical(d, now), None)

    # format_wait_hu: hours+minutes and minutes-only phrasing.
    check("hours+minutes phrasing",
          format_wait_hu(now + 3 * 3600_000 + 35 * 60_000, now), "3 óra 35 percig")
    check("minutes-only phrasing", format_wait_hu(now + 12 * 60_000, now), "12 percig")

    if fails:
        for f in fails:
            print("FAIL " + f)
        return 1
    print("telegram_progress.py --self-test: OK (%d checks)" % 11)
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(_self_test())
    main()
