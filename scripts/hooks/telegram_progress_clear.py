#!/usr/bin/env python3
"""
Stop hook — two jobs, in one place so there is a single owner of the per-session
progress state at turn end (no racing Stop hooks):

  1) CLEAR: remove the "✍️ Dolgozom rajta…" placeholder(s) that the
     UserPromptSubmit hook (telegram_progress.py) posted for this session. Under
     normal operation the PostToolUse reply hook already cleared them the moment
     the agent replied, so usually there is nothing left to do.

  2) ENFORCE DELIVERY: if the turn was triggered by an inbound Telegram message
     but the agent ended the turn WITHOUT ever sending a reply to that chat
     (i.e. a placeholder is still pending), the answer only exists in the CLI /
     transcript — which the Telegram user never sees ("the agent looks frozen").
     This hook then:
       - on the first Stop: BLOCKS the stop and instructs the agent to send its
         answer via the Telegram `reply` tool (the agent re-enters and replies
         properly, with its own formatting);
       - if it STILL did not reply after that one nudge: delivers the agent's
         final answer (last assistant message from the transcript) to the chat
         as a guaranteed fallback, then removes the placeholder.
     So a Telegram turn always ends with the user getting the answer here.

Loop safety: a per-session `enforce-<sid>.marker` guarantees we block at most
once; `stop_hook_active` is also honored. Silent on stdout EXCEPT the single
decision JSON when blocking. Token/state dir resolution mirrors the plugin
(TELEGRAM_STATE_DIR else default).
"""
import sys, os, json, glob, re, urllib.request

INSTRUCTION = (
    "KÖTELEZŐ: erre a Telegram-üzenetre még NEM küldtél választ a Telegram "
    "`reply` tool-lal (chat_id=%s). A CLI/transzkript szöveget a felhasználó a "
    "Telegramon NEM látja — onnan nézve csak befagytál. Küldd el a válaszodat "
    "MOST a `reply` tool-lal a megfelelő chat_id-vel. Ha tényleg nincs érdemi "
    "válasz, akkor is küldj egy rövid visszaigazolást."
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
    # Base is overridable (TELEGRAM_API_BASE) so tests can point it at a local
    # stub; defaults to the real Bot API, so production is unchanged.
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    url = f"{base}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def last_assistant_text(transcript_path):
    """Return the last non-empty assistant text message from the JSONL transcript
    (the agent's final user-facing answer). Empty string if none / unreadable."""
    text = ""
    if not transcript_path:
        return text
    try:
        for line in open(transcript_path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            msg = ev.get("message") or {}
            role = msg.get("role") or ev.get("role")
            if ev.get("type") == "assistant" or role == "assistant":
                content = msg.get("content", ev.get("content"))
                parts = []
                if isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and c.get("type") == "text":
                            parts.append(c.get("text", ""))
                elif isinstance(content, str):
                    parts.append(content)
                t = "\n".join(p for p in parts if p).strip()
                if t:
                    text = t  # keep the LAST non-empty one
    except Exception:
        pass
    return text


# --- Platform limit banner is NOT an answer ---------------------------------
# Boss, 2026-08-28 (Telegram 628 + screenshot): "miert adtal ilyen uzenetet?
# hiszen van meg %-od!" -- his chat showed, in the agent's own name, twice:
#   "You've hit your session limit - resets 1am (Europe/Budapest)"
# Measured cause (transcript bdb610c5..., 2026-08-27 21:39/21:42/21:45 CEST):
# when the five-hour window runs out, the platform returns that one English
# sentence AS THE WHOLE assistant turn. The turn then ends with no reply tool
# call, so the enforce path below faithfully delivered it -- a machine string,
# in English, looking like something the agent chose to say, once per turn.
#
# So the fallback filters it: a limit banner is replaced by one human sentence
# in the install language, and repeated only when the reset it names changes.
LIMIT_BANNER_RE = re.compile(
    r"^you'?ve\s+hit\s+your\s+([a-z0-9-]+)?\s*limit\b(.*)$", re.I)


def install_lang():
    """Installation language, resolved the same way the server does it
    (MARVEEN_LANG, else <root>/.lang, else Hungarian). No hardcoded path: the
    root is derived from this file's own location."""
    v = (os.environ.get("MARVEEN_LANG") or "").strip().lower()
    if v:
        return v
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        raw = open(os.path.join(root, ".lang"), encoding="utf-8").read().strip().lower()
        if raw:
            return raw
    except Exception:
        pass
    return "hu"


def limit_banner_notice(text, lang=None):
    """(human_sentence, dedup_key) if `text` is ONLY a platform limit banner,
    else (None, None). A banner embedded in a real answer is left alone -- the
    agent said something, and that something must reach the user unedited."""
    if not text:
        return None, None
    body = text.strip()
    if not body or "\n" in body or len(body) > 300:
        return None, None
    m = LIMIT_BANNER_RE.match(body)
    if not m:
        return None, None
    kind = (m.group(1) or "").lower()
    rest = (m.group(2) or "").strip(" \u00b7-\u2014.,")
    rm = re.search(r"resets?\s+(.+?)\s*$", rest, re.I)
    when = rm.group(1).strip() if rm else ""
    key = "%s|%s" % (kind, when)
    hu = (lang or install_lang()) == "hu"
    label = {"session": ("az 5 órás", "the five-hour"),
             "weekly": ("a heti", "the weekly")}.get(kind, ("a", "the"))
    if hu:
        head = "Kifutottam %s keretemből, ezért erre most nem tudok válaszolni." % label[0]
        tail = (" A keret ekkor áll vissza: %s. Amint visszajött, magamtól folytatom." % when
                if when else " Amint visszajön a keret, magamtól folytatom.")
    else:
        head = "I have run out of %s quota, so I cannot answer this right now." % label[1]
        tail = (" It comes back: %s. I will continue on my own as soon as it does." % when
                if when else " I will continue on my own as soon as it comes back.")
    return head + tail, key


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        ev = {}
    sid = ev.get("session_id") or "default"
    transcript = ev.get("transcript_path")
    stop_active = bool(ev.get("stop_hook_active"))
    sd = state_dir()
    pdir = os.path.join(sd, "progress")
    guard = os.path.join(pdir, f"enforce-{sid}.marker")

    # Clean up this session's dedup markers (created by telegram_progress.py).
    for m in glob.glob(os.path.join(pdir, f"seen-{sid}-*.marker")):
        try:
            os.remove(m)
        except Exception:
            pass

    path = os.path.join(pdir, f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        pend = None

    if not pend:
        # Nothing pending: either not a Telegram turn, or the reply was already
        # sent (PostToolUse cleared it). Drop any stale enforce marker and exit.
        try:
            os.remove(guard)
        except Exception:
            pass
        return

    # A Telegram turn whose reply was NOT sent for the listed chat(s).
    blocked_before = os.path.exists(guard)
    if not stop_active and not blocked_before:
        # First Stop with an un-replied Telegram turn -> nudge the agent to reply
        # properly via its own tool. Keep the placeholder so the re-entry path
        # (PostToolUse) clears it when the reply finally goes out.
        try:
            open(guard, "w").close()
        except Exception:
            pass
        chats = ", ".join(sorted({str(p.get("chat_id")) for p in pend}))
        log(sd, f"[enforce] blocking stop, no reply sent sid={sid} chats={chats}")
        print(json.dumps({"decision": "block", "reason": INSTRUCTION % chats}))
        return

    # Already nudged once (or loop guard tripped) and STILL no reply -> guaranteed
    # fallback: deliver the agent's final answer to the chat, then clear.
    answer = last_assistant_text(transcript)
    notice, limit_key = limit_banner_notice(answer)
    if notice:
        # One notice per outage: the key carries the reset the banner named, so
        # a NEW outage (different reset) speaks again, while three back-to-back
        # refused turns inside the same one stay quiet after the first.
        marker = os.path.join(pdir, "limit-notice.marker")
        try:
            already = open(marker, encoding="utf-8").read().strip() == limit_key
        except Exception:
            # Unreadable marker means "I could not look", not "already told".
            # Speaking twice is recoverable; going silent about an outage is not.
            already = False
        if already:
            answer = ""
            log(sd, f"[enforce] limit-banner suppressed (already told) key={limit_key}")
        else:
            answer = notice
            try:
                with open(marker, "w", encoding="utf-8") as f:
                    f.write(limit_key)
            except Exception:
                pass
            log(sd, f"[enforce] limit-banner replaced by human notice key={limit_key}")
    tok = token(sd)
    if tok:
        for p in pend:
            cid, mid = p.get("chat_id"), p.get("message_id")
            if answer:
                try:
                    api(tok, "sendMessage", {"chat_id": cid, "text": answer[:4000]})
                except Exception as e:
                    log(sd, f"[enforce] fallback send failed: {e}")
            try:
                api(tok, "deleteMessage", {"chat_id": cid, "message_id": mid})
            except Exception as e:
                log(sd, f"[stop] delete failed: {e}")
    for f in (path, guard):
        try:
            os.remove(f)
        except Exception:
            pass
    log(sd, f"[enforce] fallback-delivered={bool(answer)} cleared {len(pend)} "
            f"placeholder(s) sid={sid}")


def _self_test():
    """Pure checks for the limit-banner filter. Run by the suite
    (src/__tests__/hook-self-tests.test.ts) -- a self-test nobody calls is not
    a test."""
    fails = []

    def check(name, got, want):
        if got != want:
            fails.append("%s: expected %r, got %r" % (name, want, got))

    real = "You've hit your session limit \u00b7 resets 1am (Europe/Budapest)"
    notice, key = limit_banner_notice(real, lang="hu")
    check("session key", key, "session|1am (Europe/Budapest)")
    check("session is hungarian", notice is not None and "5 \u00f3r\u00e1s" in notice, True)
    check("session names the reset", notice is not None and "1am (Europe/Budapest)" in notice, True)
    check("session drops the english banner", notice is not None and "hit your" not in notice, True)

    weekly = "You've hit your weekly limit \u00b7 resets Aug 31, 9pm (Europe/Budapest)"
    wnotice, wkey = limit_banner_notice(weekly, lang="hu")
    check("weekly key", wkey, "weekly|Aug 31, 9pm (Europe/Budapest)")
    check("weekly is hungarian", wnotice is not None and "heti" in wnotice, True)
    # A NEW outage must be able to speak again: different reset -> different key.
    check("different outages differ", wkey != key, True)

    en, _ = limit_banner_notice(real, lang="en")
    check("english install stays english", en is not None and "five-hour" in en, True)
    check("english has no hungarian", en is not None and "Kifutottam" not in en, True)

    # A real answer that merely MENTIONS the banner must pass through untouched.
    embedded = ("Megneztem a naplot: tegnap este ez ment ki neked, "
                "\"You've hit your session limit\", es ez a hiba.")
    check("embedded banner untouched", limit_banner_notice(embedded, lang="hu"), (None, None))
    check("multiline untouched", limit_banner_notice(real + "\nEs meg valami", lang="hu"), (None, None))
    check("empty is not a banner", limit_banner_notice("", lang="hu"), (None, None))
    check("normal answer is not a banner", limit_banner_notice("Kesz, minden zold.", lang="hu"), (None, None))

    # No "resets" part: still a notice, but it must not invent a time.
    bare, bkey = limit_banner_notice("You've hit your usage limit", lang="hu")
    check("bare banner still speaks", bare is not None, True)
    check("bare banner invents no time", bare is not None and "ekkor \u00e1ll vissza" not in bare, True)
    check("bare key", bkey, "usage|")

    if fails:
        for f in fails:
            print("FAIL " + f)
        return 1
    print("telegram_progress_clear.py --self-test: OK (%d checks)" % 15)
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(_self_test())
    main()
