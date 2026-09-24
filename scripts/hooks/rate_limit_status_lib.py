#!/usr/bin/env python3
"""Shared quota-honesty logic for the Telegram "processing" receipts.

Two different code paths post a "working on it" receipt to the owner, and they
run for DIFFERENT agents:

  * the MAIN agent's UserPromptSubmit hook (telegram_progress.py) posts the
    "✍️ Dolgozom rajta…" placeholder;
  * a SUB-agent's inbox drain (channel-inbox-drain.py) EDITS the tee's arrival
    receipt ("📥 Megkaptam, sorban áll…") into that same working text when the
    turn picks the message up.

Kanban c99bc49b (#316) fixed only the first path, so a sub-agent that was out of
quota still had its receipt turned into "Dolgozom rajta…" -- Boss messaged the
Szakértő (usalackor) at 100%/reset 17:10 and still got "Dolgozom rajta" (msg
5892: "még mindig nem sikerült a javítás"), and earlier: "nem globálisan
csináltad meg, meg nem agentenként". This module is the single source both
paths import, so the decision is identical for the main agent and every
sub-agent -- that is the parity Boss asked for.

The authoritative, per-agent source is the rate-limit snapshot file
(store/rate-limit-status/<agent>.json), the same file rate-limit-guard.py reads.
It is NEVER the tmux pane: the pane also carries the model's own prose, and
prose that merely quotes "5h 100%" or "hit your session limit" made an AVAILABLE
agent report as out of quota (the removed live-pane scraper, Boss msg 5886).

Pure stdlib, fail-open by contract: every entry point returns None / a safe
default on any problem, so a receipt is at worst cosmetically wrong, never a
blocked turn.
"""
import json
import os
import re

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
    """Walk upward for a .env containing MAIN_AGENT_ID (same as
    rate-limit-guard.py / telegram_progress.py)."""
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
    """The agent whose snapshot this cwd belongs to, or None.

    cwd == project_root -> the MAIN agent. cwd under <root>/agents/<name>/ (a
    sub-agent home) -> <name>. Anything else (e.g. a worktree) -> None, so the
    caller does not accidentally read the wrong agent's snapshot."""
    if not project_root:
        return None
    if os.path.abspath(cwd) == os.path.abspath(project_root):
        return read_env_value(os.path.join(project_root, '.env'), 'MAIN_AGENT_ID') or 'main'
    agents_base = os.path.abspath(os.path.join(project_root, 'agents')) + os.sep
    if os.path.abspath(cwd).startswith(agents_base):
        return os.path.abspath(cwd)[len(agents_base):].split(os.sep)[0]
    return None


# The two rate-limit windows Claude Code enforces. BOTH can block a session:
# usalackor was stuck on the 5-hour, lackor3 (Segédmunkás) on the WEEKLY
# ("You've hit your weekly limit · resets Sep 21"), and reading only the 5-hour
# left lackor3 saying "Dolgozom rajta" while it genuinely could not work (Boss
# msg 5896). NOTE: this is the RECEIPT-honesty question ("can this agent answer
# right now?"), which is NOT the same as the delegation rule in
# rate-limit-guard.py (worst = five): whether Marvin should keep coding is
# decided on the 5-hour window only, but whether the platform is CURRENTLY
# refusing the agent's turns is decided by EITHER window hitting its limit.
WINDOW_KEYS = ("fiveHour", "sevenDay")


def window_state(snap, key, now_ms):
    """(used_pct, resets_at_ms) for the named window ('fiveHour'/'sevenDay') if
    it can be TRUSTED, else None. Mirrors pct_of() + the resetsAt-authority rule
    in rate-limit-guard.py: usedPct only means anything while resetsAt is still
    in the future.

    Staleness rule (kanban c99bc49b / #316): a FRESH snapshot is trusted as-is.
    A STALE one is trusted ONLY when it is already at/over CRITICAL and the
    window has not yet reset -- a usedPct that is already critical cannot fall
    until resetsAt passes, so an old "100% until 17:10" is still true at 15:55.
    Below critical, a stale reading is genuinely unknown (the agent may have kept
    working since), so it must not gate anything (recheck-before-restating)."""
    if not isinstance(snap, dict):
        return None
    updated_at = snap.get('updatedAt')
    if not isinstance(updated_at, (int, float)):
        return None
    window = snap.get(key)
    if not isinstance(window, dict):
        return None
    resets_at = window.get('resetsAt')
    used_pct = window.get('usedPct')
    if not isinstance(resets_at, (int, float)) or resets_at <= now_ms:
        return None
    if not isinstance(used_pct, (int, float)):
        return None
    if now_ms - updated_at >= STALE_AFTER_MS and used_pct < CRITICAL_THRESHOLD_PCT:
        # Stale AND not critical: could have grown since -> unknown, do not gate.
        # (A stale but critical reading with the window still open is still
        # reliable, so it falls through and is returned.)
        return None
    return used_pct, resets_at


def five_hour_state(snap, now_ms):
    """Back-compat wrapper: the 5-hour window only."""
    return window_state(snap, "fiveHour", now_ms)


# --- Install-specific settings (kanban 0a1ec18e) ----------------------------
#
# The message renders a time and a sentence for a human, and both are properties
# of the INSTALL, not of the machine this was written on. The timezone has one
# official source (SCHEDULER_TZ -> APP_TZ in src/config.ts) and the language one
# (MARVEEN_LANG / the .lang file -> APP_LANG).


def install_setting(project_root, key):
    """A setting as the dashboard would resolve it.

    Precedence: os.environ > store/config-overrides.json > .env, the same order
    as scripts/voice/_vtools.py and Node's getEffectiveSettingValue()."""
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


def _norm_lang(raw):
    """Raw language value -> 'en' / 'hu' / None. Mirrors readInstallLang(): an
    'en' prefix is English, any other non-empty value Hungarian, empty None."""
    if not raw:
        return None
    raw = raw.strip().lower()
    if raw.startswith("en"):
        return "en"
    if raw:
        return "hu"
    return None


def install_lang(project_root):
    """'hu' or 'en'. Mirrors readInstallLang() in src/config.ts: MARVEEN_LANG
    wins first (environ > config-overrides.json > .env), then the .lang file,
    defaulting to Hungarian."""
    if not project_root:
        return "hu"
    lang = _norm_lang(install_setting(project_root, "MARVEEN_LANG"))
    if lang:
        return lang
    try:
        with open(os.path.join(project_root, ".lang"), encoding="utf-8") as f:
            lang = _norm_lang(f.read())
    except Exception:
        lang = None
    return lang or "hu"


def install_zone(project_root):
    """(tzinfo_or_None, label). None means "use the machine's own zone"."""
    name = install_setting(project_root, "SCHEDULER_TZ") if project_root else None
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
    """'{H} óra {M} percig' / '{M} percig' and the English counterpart."""
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
# {window} names WHICH limit is spent -- "az 5 órás keretem" vs "a heti keretem"
# -- so the owner sees whether it is a few-hour wait or a days-long one.
WINDOW_LABEL = {
    "hu": {"fiveHour": "az 5 órás keretem", "sevenDay": "a heti keretem"},
    "en": {"fiveHour": "my 5-hour window", "sevenDay": "my weekly window"},
}
QUOTA_TEXT = {
    "hu": {
        "until": " (kb. {local}-ig, {zone})",
        "body": "⏳ Jelenleg kifogytam a token-keretemből: {window} {pct}%-on áll. "
                "Kb. {eta} nem tudom rendesen fogadni/feldolgozni a kéréseidet{until}, utána újra itt vagyok.",
    },
    "en": {
        "until": " (until about {local}, {zone})",
        "body": "⏳ I have run out of my token budget: {window} is at {pct}%. "
                "For about {eta} I cannot properly take or work on your requests{until}, after that I am back.",
    },
}


def quota_honest_message(used_pct, resets_at_ms, now_ms, lang="hu", zone=None, zone_label="",
                         window_key="fiveHour"):
    # Invariant: the caller (quota_status_message_if_critical) passes a
    # resets_at that window_state already proved to be in the future.
    t = QUOTA_TEXT.get(lang, QUOTA_TEXT["hu"])
    window = WINDOW_LABEL.get(lang, WINDOW_LABEL["hu"]).get(window_key, WINDOW_LABEL["hu"]["fiveHour"])
    eta = format_wait(resets_at_ms, now_ms, lang)
    try:
        import datetime
        # `zone=None` renders in the machine's own zone.
        reset_dt = datetime.datetime.fromtimestamp(resets_at_ms / 1000, tz=zone)
        now_dt = datetime.datetime.fromtimestamp(now_ms / 1000, tz=zone)
        # A weekly block can be DAYS away, so "21:00-ig" alone would read as
        # today. Show the date (locale-free MM-DD) whenever the reset is not
        # today; keep the bare time for a same-day (5-hour) reset.
        fmt = "%H:%M" if reset_dt.date() == now_dt.date() else "%m-%d %H:%M"
        local = reset_dt.strftime(fmt)
        until = t["until"].format(local=local, zone=zone_label) if zone_label else f" ({local})"
    except Exception:
        until = ""
    return t["body"].format(window=window, pct=round(used_pct), eta=eta, until=until)


def quota_status_message_if_critical(cwd, now_ms=None):
    """The honest out-of-quota text for the agent that owns `cwd` if EITHER of
    its own rate-limit windows (5-hour OR weekly) is at/over CRITICAL with the
    window still open, else None (proceed with the normal working receipt).

    Both windows are checked because the PLATFORM blocks the session on either
    one (usalackor was 5-hour-blocked, lackor3 weekly-blocked, Boss msg 5896).
    When more than one is blocking, the one that resets LATEST is reported --
    that is when the agent can actually work again. Reads STRICTLY this agent's
    own snapshot file, so it never confuses one agent's quota for another's."""
    import time
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
    blocking = []  # (resets_at, window_key, used_pct)
    for key in WINDOW_KEYS:
        state = window_state(snap, key, now_ms)
        if state is None:
            continue
        used_pct, resets_at = state
        if used_pct < CRITICAL_THRESHOLD_PCT:
            continue
        blocking.append((resets_at, key, used_pct))
    if not blocking:
        return None
    resets_at, window_key, used_pct = max(blocking)  # latest reset = binding constraint
    zone, zone_label = install_zone(project_root)
    return quota_honest_message(
        used_pct, resets_at, now_ms, install_lang(project_root), zone, zone_label, window_key,
    )


def _self_test():
    """Pure checks for the shared quota gate. Run by the suite via any hook that
    imports this and by rate_limit_status_lib.py --self-test directly."""
    import tempfile

    fails = []
    ran = []

    def check(name, got, want):
        ran.append(name)
        if got != want:
            fails.append("%s: expected %r, got %r" % (name, want, got))

    now = 1_000_000_000_000  # fixed epoch ms for deterministic math

    # five_hour_state: fresh + future window -> usable
    fresh = {"updatedAt": now - 60_000,
             "fiveHour": {"usedPct": 100, "resetsAt": now + (3 * 3600_000 + 35 * 60_000)}}
    st = five_hour_state(fresh, now)
    check("fresh snapshot usable", st is not None, True)
    check("fresh snapshot pct", st[0] if st else None, 100)

    # Stale + below critical -> unknown, do not gate.
    stale_low = {"updatedAt": now - STALE_AFTER_MS - 1,
                 "fiveHour": {"usedPct": 40, "resetsAt": now + 3600_000}}
    check("stale low snapshot ignored", five_hour_state(stale_low, now), None)

    # Stale + at/over critical + window open -> STILL trusted (#316).
    stale_crit = {"updatedAt": now - STALE_AFTER_MS - 1,
                  "fiveHour": {"usedPct": 100, "resetsAt": now + 3600_000}}
    st = five_hour_state(stale_crit, now)
    check("stale critical snapshot still trusted", st is not None, True)
    check("stale critical snapshot pct", st[0] if st else None, 100)

    # Stale critical but window already reset -> None.
    stale_crit_expired = {"updatedAt": now - STALE_AFTER_MS - 1,
                          "fiveHour": {"usedPct": 100, "resetsAt": now - 1000}}
    check("stale critical but window reset -> ignored",
          five_hour_state(stale_crit_expired, now), None)

    # Rolled-over window -> None.
    rolled = {"updatedAt": now - 1000, "fiveHour": {"usedPct": 98, "resetsAt": now - 1000}}
    check("rolled-over window ignored", five_hour_state(rolled, now), None)

    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "store", "rate-limit-status"))
        os.environ.pop("SCHEDULER_TZ", None)
        os.environ.pop("MARVEEN_LANG", None)
        with open(os.path.join(d, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=main\n")

        # Below critical -> no honest message.
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - 1000, "fiveHour": {"usedPct": 40, "resetsAt": now + 3600_000}}, f)
        check("below threshold -> None", quota_status_message_if_critical(d, now), None)

        # Fresh critical -> honest message with ETA, HU by default.
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump(fresh, f)
        msg = quota_status_message_if_critical(d, now)
        check("critical -> honest message", msg is not None, True)
        check("honest message names ETA", "3 óra 35 percig" in (msg or ""), True)

        # Stale-but-critical -> honest message end-to-end (the sub-agent case).
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - STALE_AFTER_MS * 20,
                       "fiveHour": {"usedPct": 100, "resetsAt": now + 3600_000}}, f)
        check("stale-but-critical -> honest end-to-end",
              quota_status_message_if_critical(d, now) is not None, True)

        # Available agent (stale low, window reset) -> None (no false positive).
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - STALE_AFTER_MS * 20,
                       "fiveHour": {"usedPct": 36, "resetsAt": now - 1000}}, f)
        check("available agent -> None", quota_status_message_if_critical(d, now), None)

        # WEEKLY-blocked (lackor3/Segédmunkás case, Boss msg 5896): 5h fine but
        # 7d at 100% -> honest message naming the WEEKLY window, not "Dolgozom".
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - 60_000,
                       "fiveHour": {"usedPct": 0, "resetsAt": now + 3600_000},
                       "sevenDay": {"usedPct": 100, "resetsAt": now + 3 * 24 * 3600_000}}, f)
        wmsg = quota_status_message_if_critical(d, now) or ""
        check("weekly-blocked -> honest message", bool(wmsg), True)
        check("weekly message names the weekly window", "heti keretem" in wmsg, True)
        check("weekly message not the 5h window", "5 órás" in wmsg, False)

        # BOTH windows critical -> report the one that resets LATEST (weekly).
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - 60_000,
                       "fiveHour": {"usedPct": 100, "resetsAt": now + 3600_000},
                       "sevenDay": {"usedPct": 100, "resetsAt": now + 3 * 24 * 3600_000}}, f)
        bmsg = quota_status_message_if_critical(d, now) or ""
        check("both critical -> reports the later (weekly)", "heti keretem" in bmsg, True)

        # Missing snapshot (fresh install) -> None, no crash.
        os.remove(os.path.join(d, "store", "rate-limit-status", "main.json"))
        check("missing snapshot -> None", quota_status_message_if_critical(d, now), None)

        # English install -> English text.
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump(fresh, f)
        with open(os.path.join(d, ".lang"), "w") as f:
            f.write("en\n")
        msg = quota_status_message_if_critical(d, now) or ""
        check("english install -> english", "5-hour window" in msg, True)
        check("english install no hungarian", "keretem" in msg, False)
        os.remove(os.path.join(d, ".lang"))

    # resolve_agent_id: main vs sub-agent vs neither.
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, ".env"), "w") as f:
            f.write("MAIN_AGENT_ID=marvin\n")
        check("resolve main", resolve_agent_id(d, d), "marvin")
        sub = os.path.join(d, "agents", "usalackor")
        os.makedirs(sub)
        check("resolve sub-agent", resolve_agent_id(sub, d), "usalackor")
        wt = os.path.join(d, ".worktrees", "x")
        os.makedirs(wt)
        check("resolve worktree -> None", resolve_agent_id(wt, d), None)

    check("format_wait hu", format_wait(now + 3 * 3600_000 + 35 * 60_000, now), "3 óra 35 percig")
    check("format_wait en", format_wait(now + 3 * 3600_000 + 35 * 60_000, now, "en"), "3h 35m")

    if fails:
        for f in fails:
            print("FAIL " + f)
        return 1
    print("rate_limit_status_lib.py --self-test: OK (%d checks)" % len(ran))
    return 0


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv[1:]:
        sys.exit(_self_test())
