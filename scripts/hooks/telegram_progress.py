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
placeholder, this hook now checks the agent's OWN rate-limit snapshot (the same
file rate-limit-guard.py reads, store/rate-limit-status/<agent>.json) -- if a
window is HARD-BLOCKED (usedPct at a full 100%, 5-hour OR weekly, with the window
still open; see rate_limit_status_lib.HARD_BLOCK_PCT), it sends an honest status
message with a concrete "X ora Y percig" ETA instead of
the placeholder, and does NOT track it for the Stop-hook cleanup path (it is a
real, permanent status message, not a "still working" placeholder to delete).
A FRESH snapshot is trusted as-is; a STALE one is trusted ONLY when it is
at/over CRITICAL with the window still in the future -- a critical usedPct
cannot fall until resetsAt passes, so an old "100% until 17:10" is still true
now (kanban c99bc49b / #316). That stale-but-critical rule is what catches a
busy/limit-frozen agent whose statusline stopped ticking (Boss msg 5878),
WITHOUT the old live-pane scraper: reading the whole tmux pane meant an agent's
own prose that merely quoted "5h 100%" or "hit your session limit" tripped the
detector, so an AVAILABLE agent reported as out of quota (Boss msg 5886). If the
snapshot is missing, or stale-and-below-critical, or the window already rolled
over, this falls through to the normal placeholder -- an unreliable number must
not be guessed at (see recheck-before-restating doctrine), it must simply not
gate anything. The snapshot is read strictly for THIS agent, so it can never
confuse one agent's quota for another's.

MUST stay silent on stdout — stdout from UserPromptSubmit is injected into the
model prompt. All diagnostics go to a debug log file under the state dir.

Token/state dir resolution mirrors the telegram plugin: honor TELEGRAM_STATE_DIR
(set per-agent), else default to ~/.claude/channels/telegram. This keeps the
hook correct even if installed globally across agents with different bots.
"""
import sys, os, json, re, time, urllib.request

REACTION = "✍️"                            # ✍️

# Shared quota-honesty logic (kanban c99bc49b/#316 + the sub-agent parity fix):
# a single source both this main-agent hook and channel-inbox-drain.py import,
# so "am I out of quota?" is decided identically for every agent. Fail-open: if
# the sibling module is missing (a stripped-down install), the honest-status
# gate is simply skipped and the normal placeholder is sent.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from rate_limit_status_lib import (
        quota_status_message_if_critical, install_lang, find_project_root,
    )
    _HAS_RL = True
except Exception:
    _HAS_RL = False
    def quota_status_message_if_critical(cwd, now_ms=None):
        return None
    def install_lang(project_root):
        return "hu"
    def find_project_root(cwd):
        return None






















# Every line that reaches a screen exists in both languages (project rule).

PLACEHOLDER_TEXT = {"hu": "✍️ Dolgozom rajta…", "en": "✍️ Working on it…"}


def placeholder_text(lang="hu"):
    return PLACEHOLDER_TEXT.get(lang, PLACEHOLDER_TEXT["hu"])






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

    # Kanban 34f8f2dc: know BEFORE sending anything whether our own frame is
    # already HARD-BLOCKED (a full 100%) -- if so, the placeholder would be a lie.
    # Boss 2026-09-18 (msg 5911): only a full 100% counts; at 95-99% the account
    # still answers, so the receipt must stay the normal "Dolgozom rajta" there.
    # Kanban c99bc49b (#316): this reads THIS agent's OWN snapshot file, and it
    # trusts a STALE-but-maxed reading (usedPct>=100 with the window still open),
    # which is what catches a busy/limit-frozen agent (usalackor at 100%, Boss
    # msg 5878) that the fresh-only check missed.
    # The old live-pane scraper that used to run here as a fallback was removed:
    # it read the whole tmux pane, so an agent's own prose quoting "5h 100%" /
    # "hit your session limit" made an AVAILABLE agent report as out of quota
    # (Boss msg 5886 -- Marvin shown blocked until usalackor's 17:10 reset).
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
    """Placeholder-text checks (local), plus the shared quota gate via the lib.
    Run by src/__tests__/hook-self-tests.test.ts -- a self-test nobody calls is
    not a test."""
    fails = []

    # The placeholder is screen text -- both languages, never the same string
    # twice, unknown language falls back to Hungarian.
    if placeholder_text("hu") != "✍️ Dolgozom rajta…":
        fails.append("placeholder hu wrong: %r" % placeholder_text("hu"))
    if placeholder_text("en") == placeholder_text("hu"):
        fails.append("placeholder en must differ from hu")
    if placeholder_text("de") != placeholder_text("hu"):
        fails.append("unknown language must fall back to hu")

    # The quota decision lives in the shared lib (imported here and by
    # channel-inbox-drain.py). Run its self-test so this hook's suite entry also
    # guards the logic it depends on. A stripped install without the lib
    # (_HAS_RL False) is a valid fail-open state, not a test failure.
    if _HAS_RL:
        try:
            import rate_limit_status_lib
            if rate_limit_status_lib._self_test() != 0:
                fails.append("rate_limit_status_lib self-test failed")
        except Exception as e:
            fails.append("rate_limit_status_lib self-test raised: %r" % e)

    if fails:
        for f in fails:
            print("FAIL " + f)
        return 1
    print("telegram_progress.py --self-test: OK")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(_self_test())
    main()
