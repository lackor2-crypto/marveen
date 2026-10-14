#!/usr/bin/env python3
"""
PostToolUse hook — clears the "✍️ Dolgozom rajta…" placeholder as soon as the
agent actually SENDS a reply, instead of waiting for the turn to end (Stop).

Why: a single long turn can pull a bigger task forward and emit several replies
before it finishes. With Stop-only cleanup the placeholder visibly lingers for
the whole (possibly very long) turn even though the user already got an answer.
Clearing on the reply tool makes the placeholder disappear exactly when the
answer appears — matching the user's mental model.

Fires after the Telegram `reply` tool. Parks any pending placeholder(s) for
the replied chat_id in this session (the message stays until the turn ends, #600). The Stop hook + watchdog remain as
backstops for turns that end without a reply, or true crashes.

Silent on stdout. Honors TELEGRAM_STATE_DIR (per-agent token) like the others.
"""
import sys, os, json, urllib.request


def state_dir():
    # #915: env override, then install-scoped once migrated, then legacy shared.
    d = os.environ.get("TELEGRAM_STATE_DIR")
    if d:
        return d
    _root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _inst = os.path.join(_root, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(_inst, ".env")):
        return _inst
    return os.path.expanduser("~/.claude/channels/telegram")


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
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    url = f"{base}/bot{tok}/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode())


def main():
    try:
        ev = json.loads(sys.stdin.read())
    except Exception:
        return
    tool = ev.get("tool_name") or ev.get("toolName") or ""
    if "telegram" not in tool or "reply" not in tool:
        return
    ti = ev.get("tool_input") or ev.get("toolInput") or {}
    chat_id = ti.get("chat_id")
    if chat_id is None:
        return
    chat_id = str(chat_id)
    sid = ev.get("session_id") or "default"
    sd = state_dir()
    path = os.path.join(sd, "progress", f"{sid}.json")
    try:
        pend = json.load(open(path))
    except Exception:
        return
    keep, drop = [], []
    for p in pend:
        (drop if str(p.get("chat_id")) == chat_id else keep).append(p)
    if not drop:
        return
    # #600 (Boss TG 3286): the reply answers ONE thing, the turn may still be working on another (a message that
    # arrived mid-turn). The "Dolgozom rajta" message therefore STAYS in the chat; only its bookkeeping record
    # leaves the pending list (the Stop hook's "no reply sent" signal) and is parked in <sid>.working, where the
    # Stop hook (turn end) and the watchdog (crash backstop) delete the message.
    try:
        wpath = os.path.join(sd, "progress", f"{sid}.working")
        try:
            parked = json.load(open(wpath))
        except Exception:
            parked = []
        parked.extend(drop)
        json.dump(parked, open(wpath, "w"))
    except Exception:
        pass
    try:
        if keep:
            json.dump(keep, open(path, "w"))
        else:
            os.remove(path)
    except Exception:
        pass


if __name__ == "__main__":
    main()
