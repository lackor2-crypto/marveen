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


# --- Install-specific settings (kanban 0a1ec18e) ----------------------------
#
# This hook renders a time and a sentence for a human, and both are properties
# of the INSTALL, not of the machine this was written on. Hardcoding either one
# is the "host-agnostic development" rule's exact failure: it works here and
# quietly misinforms everyone else. The timezone has one official source
# (SCHEDULER_TZ -> APP_TZ in src/config.ts, which exists precisely because it
# replaced ~15 hardcoded 'Europe/Budapest' literals), and the language has one
# official source (the .lang file -> APP_LANG).


def install_setting(project_root, key):
    """A setting as the dashboard would resolve it.

    Precedence: os.environ > store/config-overrides.json > .env, the same order
    as scripts/voice/_vtools.py and Node's getEffectiveSettingValue(). Settings
    changed on the Settings page land in config-overrides.json, NOT in .env --
    reading only .env would render the new value in the UI and change nothing
    here, the worst kind of failure because it looks like it worked.
    """
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(project_root, "store", "config-overrides.json"), encoding="utf-8") as f:
            v = json.load(f).get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    except Exception:
        pass
    try:
        with open(os.path.join(project_root, ".env"), encoding="utf-8") as f:
            m = re.search(r"^" + re.escape(key) + r"=(.*)$", f.read(), re.M)
        if m and m.group(1).strip():
            return m.group(1).strip().strip("'\"")
    except Exception:
        pass
    return None


def install_lang(project_root):
    """'hu' or 'en' -- the install language (mirrors readInstallLang() in
    src/config.ts: the .lang file, defaulting to Hungarian)."""
    try:
        with open(os.path.join(project_root, ".lang"), encoding="utf-8") as f:
            raw = f.read().strip().lower()
        if raw.startswith("en"):
            return "en"
        if raw:
            return "hu"
    except Exception:
        pass
    return "hu"


def install_zone(project_root):
    """(tzinfo_or_None, label). None means "use the machine's own zone" -- the
    same fallback resolveAppTz() takes when SCHEDULER_TZ is unset. A configured
    but unusable zone falls back too rather than throwing: a wrong-looking hour
    is bad, no message at all is worse."""
    name = install_setting(project_root, "SCHEDULER_TZ")
    if name:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(name), name
        except Exception:
            pass
    try:
        import datetime
        local = datetime.datetime.now().astimezone()
        return None, (local.tzname() or "")
    except Exception:
        return None, ""


def format_wait(resets_at_ms, now_ms, lang="hu"):
    """'{H} ora {M} percig' / '{M} percig' -- the ETA phrasing Boss asked for
    (uzenet 808: "3 ora 35 perc ig"), and its English counterpart."""
    remaining_min = max(0, round((resets_at_ms - now_ms) / 60_000))
    hours, minutes = divmod(remaining_min, 60)
    if lang == "en":
        if hours > 0:
            return f"{hours}h {minutes}m"
        return f"{minutes} minutes"
    if hours > 0:
        return f"{hours} óra {minutes} percig"
    return f"{minutes} percig"


# Every line that reaches a screen exists in both languages (project rule).
QUOTA_TEXT = {
    "hu": {
        "until": " (kb. {local}-ig, {zone})",
        "body": "⏳ Jelenleg kifogytam a token-keretemből: az 5 órás keretem {pct}%-on áll. "
                "Kb. {eta} nem tudom rendesen fogadni/feldolgozni a kéréseidet{until}, utána újra itt vagyok.",
    },
    "en": {
        "until": " (until about {local}, {zone})",
        "body": "⏳ I have run out of my token budget: my 5-hour window is at {pct}%. "
                "For about {eta} I cannot properly take or work on your requests{until}, after that I am back.",
    },
}

PLACEHOLDER_TEXT = {"hu": "✍️ Dolgozom rajta…", "en": "✍️ Working on it…"}


def placeholder_text(lang="hu"):
    return PLACEHOLDER_TEXT.get(lang, PLACEHOLDER_TEXT["hu"])


def quota_honest_message(used_pct, resets_at_ms, now_ms, lang="hu", zone=None, zone_label=""):
    t = QUOTA_TEXT.get(lang, QUOTA_TEXT["hu"])
    eta = format_wait(resets_at_ms, now_ms, lang)
    try:
        import datetime
        # `zone=None` renders in the machine's own zone -- the same fallback the
        # dashboard takes when SCHEDULER_TZ is unset.
        local = datetime.datetime.fromtimestamp(resets_at_ms / 1000, tz=zone).strftime("%H:%M")
        until = t["until"].format(local=local, zone=zone_label) if zone_label else f" ({local})"
    except Exception:
        until = ""
    return t["body"].format(pct=round(used_pct), eta=eta, until=until)


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
    zone, zone_label = install_zone(project_root)
    return quota_honest_message(
        used_pct, resets_at, now_ms, install_lang(project_root), zone, zone_label,
    )


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
    # Kanban 0a1ec18e: the placeholder is screen text too, so it follows the
    # INSTALL language, not the language this hook happened to be written in.
    # A missing project root (hook running outside a Marveen tree) keeps the
    # documented default -- Hungarian -- rather than failing the turn.
    root = find_project_root(os.getcwd())
    placeholder = placeholder_text(install_lang(root) if root else "hu")
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
            resp = api(tok, "sendMessage", {"chat_id": chat_id, "text": placeholder, "disable_notification": True})
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
    ran = []

    def check(name, got, want):
        # A FIXED count in the summary line would keep saying "11 checks" no
        # matter how many actually ran -- a number that cannot be wrong is not a
        # measurement. Count what really executed.
        ran.append(name)
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
        check("honest message is not the lie", placeholder_text("hu") in (msg or ""), False)

        # --- kanban 0a1ec18e: the message must follow the INSTALL, not this
        # machine. A wrong hour or a Hungarian sentence on an English install
        # is the same defect the honest message exists to prevent.
        os.environ.pop("SCHEDULER_TZ", None)
        with open(os.path.join(d, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=main\nSCHEDULER_TZ=America/New_York\n")
        msg = quota_status_message_if_critical(d, now) or ""
        check("zone comes from .env", "America/New_York" in msg, True)
        check("no hardcoded developer zone", "Europe/Budapest" in msg, False)

        # Settings-page values land in config-overrides.json and must WIN over
        # .env -- otherwise the UI would show a change that changes nothing.
        with open(os.path.join(d, "store", "config-overrides.json"), "w") as f:
            json.dump({"SCHEDULER_TZ": "UTC"}, f)
        msg = quota_status_message_if_critical(d, now) or ""
        check("config-overrides wins over .env", "UTC" in msg, True)
        # now + 3h35m == 2001-09-09 05:21 UTC -- the hour is really rendered in
        # the configured zone, not just named in the text.
        check("hour rendered in the configured zone", "05:21" in msg, True)

        # An unusable zone must fall back to the machine, not throw the turn away.
        with open(os.path.join(d, "store", "config-overrides.json"), "w") as f:
            json.dump({"SCHEDULER_TZ": "Not/AZone"}, f)
        check("bad zone still produces a message",
              bool(quota_status_message_if_critical(d, now)), True)
        os.remove(os.path.join(d, "store", "config-overrides.json"))

        # Language: the install's .lang decides, the default stays Hungarian.
        check("default language is hu", install_lang(d), "hu")
        with open(os.path.join(d, ".lang"), "w") as f:
            f.write("en\n")
        check("lang file read", install_lang(d), "en")
        msg = quota_status_message_if_critical(d, now) or ""
        check("english install gets english text", "5-hour window" in msg, True)
        check("english install has no hungarian text", "keretem" in msg, False)
        check("english ETA phrasing", "3h 35m" in msg, True)
        os.remove(os.path.join(d, ".lang"))

        # A missing snapshot file (fresh install, no statusline tick yet)
        # must not throw and must not gate -- there is simply nothing to say.
        os.remove(os.path.join(d, "store", "rate-limit-status", "main.json"))
        check("missing snapshot -> normal placeholder",
              quota_status_message_if_critical(d, now), None)

    # The placeholder is screen text as well -- both languages, and never the
    # same string twice (a "bilingual" pair that is one string is not bilingual).
    check("placeholder hu", placeholder_text("hu"), "✍️ Dolgozom rajta…")
    check("placeholder en differs", placeholder_text("en") != placeholder_text("hu"), True)
    check("unknown language falls back to hu", placeholder_text("de"), placeholder_text("hu"))

    # format_wait: hours+minutes and minutes-only phrasing.
    check("hours+minutes phrasing",
          format_wait(now + 3 * 3600_000 + 35 * 60_000, now), "3 óra 35 percig")
    check("minutes-only phrasing", format_wait(now + 12 * 60_000, now), "12 percig")

    if fails:
        for f in fails:
            print("FAIL " + f)
        return 1
    print("telegram_progress.py --self-test: OK (%d checks)" % len(ran))
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(_self_test())
    main()
