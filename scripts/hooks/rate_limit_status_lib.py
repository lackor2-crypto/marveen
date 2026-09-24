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

CRITICAL_THRESHOLD_PCT = 95  # PACING ONLY: mirrors rate-limit-guard.py's
# delegation threshold / src/rate-limit-status.ts. This is NOT the "kifogytam"
# Telegram receipt trigger -- see OUT_OF_QUOTA_PCT below.
STALE_AFTER_MS = 30 * 60_000

# The honest "kifogytam a token-keretemből" Telegram receipt fires ONLY when a
# window is at a FULL 100% with the window still open -- for BOTH the 5-hour and
# the weekly window.
#
# Boss, Telegram 2026-09-18 21:41 (msg 5911): the Szakerto (usalackor) sent the
# banner at 5h 96% ("meg nem fogyott ki... 96%-on van"), and Boss: "csak
# 100%-on mondja. Addig valaszoljon a keresemre... csak hogyha mar tenyleg
# fullban nem tud dolgozni 100%, akkor kapjam ezt az uzenetet." At 95-99% the
# account can still answer, so the agent must ANSWER, not send the banner.
#
# This is a NARROWER question than pacing: rate-limit-guard.py stops DELEGATING
# at 95% (CRITICAL_THRESHOLD_PCT, unchanged -- that is voluntary throttling);
# here we claim "cannot answer AT ALL", which is only true at a full 100%.
# Boss (2026-09-18 16:37) established the same 100% rule for the weekly window
# (the Segedmunkas case); this makes both windows identical.
OUT_OF_QUOTA_PCT = 100


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


def window_state(snap, now_ms, window_key, trust_floor_pct):
    """(used_pct, resets_at_ms) for the named window if it can be TRUSTED, else
    None. Mirrors pct_of() + the resetsAt-authority rule in rate-limit-guard.py:
    usedPct only means anything while resetsAt is still in the future.

    Staleness rule (kanban c99bc49b / #316): a FRESH snapshot is trusted as-is.
    A STALE one is trusted ONLY when it is already at/over `trust_floor_pct` and
    the window has not yet reset -- because a usedPct that is already at the
    blocking level cannot fall until resetsAt passes, so an old reading of "100%
    until 17:10" is still true at 15:55. Below the floor, a stale reading is
    genuinely unknown (the agent may have kept working since), so it must not
    gate anything (recheck-before-restating doctrine).

    `window_key` is 'fiveHour' or 'sevenDay'; `trust_floor_pct` is the blocking
    threshold for that window (95 for 5-hour, 100 for weekly -- see the module
    constants for why they differ). This function does NOT itself decide the
    window is blocking -- it returns the trustworthy reading and lets the caller
    compare against the threshold."""
    if not isinstance(snap, dict):
        return None
    updated_at = snap.get('updatedAt')
    if not isinstance(updated_at, (int, float)):
        return None
    window = snap.get(window_key)
    if not isinstance(window, dict):
        return None
    resets_at = window.get('resetsAt')
    used_pct = window.get('usedPct')
    if not isinstance(resets_at, (int, float)) or resets_at <= now_ms:
        return None
    if not isinstance(used_pct, (int, float)):
        return None
    if now_ms - updated_at >= STALE_AFTER_MS and used_pct < trust_floor_pct:
        # Stale AND below the blocking floor: could have grown since -> unknown,
        # do not gate. (A stale reading already at/over the floor with the window
        # still open is still reliable, so it falls through and is returned.)
        return None
    return used_pct, resets_at


def five_hour_state(snap, now_ms):
    """Back-compat wrapper: the 5-hour window trusted at the CRITICAL floor."""
    return window_state(snap, now_ms, 'fiveHour', CRITICAL_THRESHOLD_PCT)


def blocked_window(snap, now_ms):
    """(window_key, used_pct, resets_at_ms) for the window that is HARD-BLOCKING
    the agent right now -- 5-hour at/over CRITICAL, or weekly at/over
    WEEKLY_BLOCK_PCT -- or None if neither is. When BOTH are maxed, returns the
    one that resets LATER, because the agent can answer again only once every
    blocking window has cleared: that later reset is the honest ETA to give.

    This is the single decision both the main-agent hook (telegram_progress.py)
    and the sub-agent inbox drain (channel-inbox-drain.py) import, so 'am I out
    of quota?' is identical for every agent -- the parity Boss asked for."""
    candidates = []
    fh = window_state(snap, now_ms, 'fiveHour', CRITICAL_THRESHOLD_PCT)
    if fh is not None and fh[0] >= CRITICAL_THRESHOLD_PCT:
        candidates.append(('fiveHour', fh[0], fh[1]))
    wk = window_state(snap, now_ms, 'sevenDay', WEEKLY_BLOCK_PCT)
    if wk is not None and wk[0] >= WEEKLY_BLOCK_PCT:
        candidates.append(('sevenDay', wk[0], wk[1]))
    if not candidates:
        return None
    return max(candidates, key=lambda c: c[2])


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
    """'{D} nap {H} óráig' / '{H} óra {M} percig' / '{M} percig' and the English
    counterpart. The day tier exists because the weekly window can reset days
    out -- an ETA of '60 óra' would be unreadable."""
    remaining_min = max(0, round((resets_at_ms - now_ms) / 60_000))
    days, rem = divmod(remaining_min, 1440)
    hours, minutes = divmod(rem, 60)
    if lang == "en":
        if days > 0:
            return f"{days}d {hours}h"
        if hours > 0:
            return f"{hours}h {minutes}m"
        return f"{minutes} minutes"
    if days > 0:
        return f"{days} nap {hours} óráig"
    if hours > 0:
        return f"{hours} óra {minutes} percig"
    return f"{minutes} percig"


# Every line that reaches a screen exists in both languages (project rule).
# {window} names WHICH budget is maxed -- naming the 5-hour one when it is
# actually the weekly cap that is blocking would be a fresh lie (Boss cares
# about the difference: the weekly one resets days out, the 5-hour one hours).
QUOTA_TEXT = {
    "hu": {
        "until": " (kb. {local}-ig, {zone})",
        "window": {"fiveHour": "az 5 órás", "sevenDay": "a heti (7 napos)"},
        "body": "⏳ Jelenleg kifogytam a token-keretemből: {window} keretem {pct}%-on áll. "
                "Kb. {eta} nem tudom rendesen fogadni/feldolgozni a kéréseidet{until}, utána újra itt vagyok.",
    },
    "en": {
        "until": " (until about {local}, {zone})",
        "window": {"fiveHour": "my 5-hour", "sevenDay": "my weekly"},
        "body": "⏳ I have run out of my token budget: {window} window is at {pct}%. "
                "For about {eta} I cannot properly take or work on your requests{until}, after that I am back.",
    },
}


def quota_honest_message(window_key, used_pct, resets_at_ms, now_ms, lang="hu", zone=None, zone_label=""):
    # Invariant: the caller (quota_status_message_if_critical) passes a
    # resets_at that blocked_window already proved to be in the future.
    t = QUOTA_TEXT.get(lang, QUOTA_TEXT["hu"])
    eta = format_wait(resets_at_ms, now_ms, lang)
    window_name = t["window"].get(window_key, t["window"]["fiveHour"])
    try:
        import datetime
        # `zone=None` renders in the machine's own zone.
        reset_dt = datetime.datetime.fromtimestamp(resets_at_ms / 1000, tz=zone)
        now_dt = datetime.datetime.fromtimestamp(now_ms / 1000, tz=zone)
        # A weekly reset lands on another day, where "%H:%M" alone ("05:00")
        # would not say WHICH day -- include the date once it is not today.
        if reset_dt.date() != now_dt.date():
            fmt = "%m/%d %H:%M" if lang == "en" else "%m.%d. %H:%M"
        else:
            fmt = "%H:%M"
        local = reset_dt.strftime(fmt)
        until = t["until"].format(local=local, zone=zone_label) if zone_label else f" ({local})"
    except Exception:
        until = ""
    return t["body"].format(window=window_name, pct=round(used_pct), eta=eta, until=until)


def quota_status_message_if_critical(cwd, now_ms=None):
    """The honest out-of-quota text for the agent that owns `cwd` if its own
    snapshot shows a HARD-BLOCKING window (5-hour at/over CRITICAL, or weekly at
    100%) still open, else None (proceed with the normal working receipt). Reads
    STRICTLY that agent's own snapshot file, so it can never confuse one agent's
    quota for another's."""
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
    state = blocked_window(snap, now_ms)
    if state is None:
        return None
    window_key, used_pct, resets_at = state
    zone, zone_label = install_zone(project_root)
    return quota_honest_message(
        window_key, used_pct, resets_at, now_ms, install_lang(project_root), zone, zone_label,
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

    # blocked_window: the weekly cap blocks only at a full 100% (Boss 2026-09-18
    # -- Segedmunkas snapshot was fiveHour 0% / sevenDay 100%, and the 5-hour-
    # only check let "dolgozom rajta" go out while the account was hard-blocked).
    week_maxed = {"updatedAt": now - 60_000,
                  "fiveHour": {"usedPct": 10, "resetsAt": now + 3600_000},
                  "sevenDay": {"usedPct": 100, "resetsAt": now + 2 * 86_400_000}}
    bw = blocked_window(week_maxed, now)
    check("weekly 100% blocks", bw is not None, True)
    check("weekly block names weekly window", bw[0] if bw else None, "sevenDay")

    # Weekly below 100% does NOT block (doctrine: only the 5-hour drives pacing).
    week_high = {"updatedAt": now - 60_000,
                 "fiveHour": {"usedPct": 10, "resetsAt": now + 3600_000},
                 "sevenDay": {"usedPct": 99, "resetsAt": now + 2 * 86_400_000}}
    check("weekly 99% does not block", blocked_window(week_high, now), None)

    # Both maxed -> blocked until the LATER reset (the weekly one), because the
    # agent can answer again only once every blocking window has cleared.
    both_maxed = {"updatedAt": now - 60_000,
                  "fiveHour": {"usedPct": 100, "resetsAt": now + 3600_000},
                  "sevenDay": {"usedPct": 100, "resetsAt": now + 2 * 86_400_000}}
    bw = blocked_window(both_maxed, now)
    check("both maxed -> later (weekly) window", bw[0] if bw else None, "sevenDay")
    check("both maxed -> weekly resetsAt", bw[2] if bw else None, now + 2 * 86_400_000)

    # Weekly 100% but the weekly window already reset -> not blocking.
    week_expired = {"updatedAt": now - 60_000,
                    "sevenDay": {"usedPct": 100, "resetsAt": now - 1000}}
    check("weekly 100% but reset -> None", blocked_window(week_expired, now), None)

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

        # Weekly-only exhaustion (the Segedmunkas case): the honest message names
        # the WEEKLY window and a multi-day ETA, never the 5-hour budget.
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - 60_000,
                       "fiveHour": {"usedPct": 0, "resetsAt": now + 3600_000},
                       "sevenDay": {"usedPct": 100,
                                    "resetsAt": now + 2 * 86_400_000 + 3 * 3600_000}}, f)
        msg = quota_status_message_if_critical(d, now) or ""
        check("weekly-only -> honest message", msg != "", True)
        check("weekly-only names weekly window", "heti" in msg, True)
        check("weekly-only multi-day ETA", "2 nap" in msg, True)
        check("weekly-only not 5-hour text", "5 órás" in msg, False)

        # Weekly at 99% with the 5-hour window fine -> normal receipt, no lie.
        with open(os.path.join(d, "store", "rate-limit-status", "main.json"), "w") as f:
            json.dump({"updatedAt": now - 60_000,
                       "fiveHour": {"usedPct": 20, "resetsAt": now + 3600_000},
                       "sevenDay": {"usedPct": 99, "resetsAt": now + 2 * 86_400_000}}, f)
        check("weekly 99% + 5h fine -> None", quota_status_message_if_critical(d, now), None)

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
    check("format_wait hu days", format_wait(now + 2 * 86_400_000 + 3 * 3600_000, now), "2 nap 3 óráig")
    check("format_wait en days", format_wait(now + 2 * 86_400_000 + 3 * 3600_000, now, "en"), "2d 3h")

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
