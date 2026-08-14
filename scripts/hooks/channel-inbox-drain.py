#!/usr/bin/env python3
"""UserPromptSubmit hook: drain sub-agent Telegram channel notifications.

Telegram sub-agents load the official channel plugin as a plain MCP server to
avoid the plugin in_use lock. Claude Code ignores that server's channel
notifications, so scripts/channel-inbound-tee.mjs persists them to a local JSONL
inbox. This hook pulls that local queue into the next prompt, using the same
<channel> framing the --channels path would have produced.

Sub-agents ONLY: the main agent runs with --channels and receives notifications
directly; it has no local derived inbox. An agent_id/cwd guard (mirroring
inbox-drain.py) exits silently when called from the main session so the hook can
safely be installed in both agent profiles without double-delivering to the main
agent. All errors are fail-open so prompt submission is never blocked.
"""
import glob
import html
import json
import re
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import ledger_lib  # noqa: E402
    _HAS_LEDGER = True
except ImportError:
    _HAS_LEDGER = False


PREFIX = "[Telegram inbox drain -- %d fuggoben levo uzenet erkezett mikozben a session masszal foglalkozott:]"


def _load_payload():
    try:
        return json.load(sys.stdin)
    except Exception:
        return None


def _is_main_session(payload):
    """Return True when running inside the main agent session.

    Resolution order (mirrors inbox-drain.py / ledger_lib.agent_id_from_cwd):
    1. ledger_lib.agent_id_from_cwd + main_agent_id() comparison (preferred).
    2. Fallback: MAIN_AGENT_ID env var vs cwd-derived agent name.
    """
    cwd = (payload or {}).get("cwd") or ""
    if _HAS_LEDGER:
        try:
            agent_id = ledger_lib.agent_id_from_cwd(cwd)
            return agent_id == ledger_lib.main_agent_id()
        except Exception:
            pass
    # Fallback without ledger_lib: cwd inside agents/<name>/ means sub-agent.
    main_id = os.environ.get("MAIN_AGENT_ID", "")
    if not cwd or not main_id:
        return False
    # ONE dirname: a sub-agent runs in <install>/agents/<name>, so its parent IS
    # the agents dir. Three dirnames walked up to the install's grandparent and
    # produced a path no cwd can start with, so the fallback answered "main" for
    # EVERY agent -- with ledger_lib unimportable, no sub-agent would ever have
    # drained its inbox, silently (lackor3's review, 2026-08-11).
    parent = os.path.basename(os.path.dirname(os.path.normpath(cwd)))
    # "agents/<name>" and ".worktrees/<name>" are both sub-agent homes; anything
    # else is the install root, i.e. the main agent.
    return parent not in ("agents", ".worktrees")


def _state_dir(payload):
    env_dir = os.environ.get("TELEGRAM_STATE_DIR")
    if env_dir:
        return env_dir
    cwd = ""
    if isinstance(payload, dict):
        cwd = payload.get("cwd") or ""
    if not cwd:
        return ""
    return os.path.join(cwd, ".claude", "channels", "telegram")


def _claim_one(state_dir):
    pending = os.path.join(state_dir, "inbox-pending.jsonl")
    draining = sorted(
        glob.glob(os.path.join(state_dir, "inbox-draining-*.jsonl")),
        key=lambda p: (os.path.getmtime(p), p),
    )
    for path in draining + [pending]:
        try:
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                continue
            if os.path.basename(path).startswith("inbox-draining-"):
                return path
            claimed = os.path.join(state_dir, "inbox-draining-%d.jsonl" % os.getpid())
            os.rename(path, claimed)
            return claimed
        except FileNotFoundError:
            return None
        except Exception:
            return None
    return None


def _attr(value):
    return html.escape(str(value), quote=True)


def _format_entry(entry):
    params = entry.get("params") if isinstance(entry, dict) else None
    if not isinstance(params, dict):
        return None
    meta = params.get("meta") if isinstance(params.get("meta"), dict) else {}
    content = params.get("content")
    if content is None:
        content = ""
    # The sender controls this text, so it must not be able to forge structure:
    # an unescaped "<" let a sender open a FAKE <channel ... user="someone-else">
    # block and impersonate another chat inside the model's view.
    #
    # Only TAG-LIKE "<" is neutralised, not every "<". Escaping all of them was
    # correct but unfaithful (lackor3's second review): the owner writing
    # "if a < b" or pasting code saw it come back as "a &lt; b", and the agent
    # would quote it that way. A "<" followed by a letter, "/" or "!" is markup;
    # a "<" followed by a space or a digit is arithmetic.
    body = re.sub(r"<(?=[A-Za-z/!])", "&lt;", str(content))

    attrs = [('source', 'telegram')]
    for key in ("chat_id", "message_id", "user", "ts", "image_path"):
        if key in meta and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))
    for key in sorted(meta.keys()):
        if key.startswith("attachment_") and meta.get(key) is not None:
            attrs.append((key, meta.get(key)))

    attr_text = " ".join('%s="%s"' % (key, _attr(value)) for key, value in attrs)
    return "<channel %s>%s</channel>" % (attr_text, body)


# Ceilings on one drained batch. Nothing else caps this: the tee only appends,
# and the watcher only nudges -- so a sub-agent that takes no turn for two weeks
# in a busy group would have poured thousands of <channel> blocks into a SINGLE
# prompt, blowing its context and burning the window in one shot (lackor3's
# review). The newest messages are the ones worth keeping; older ones are
# dropped with a visible line so the loss is never silent.
MAX_ENTRIES = 40
MAX_BODY_CHARS = 60000


def _read_entries(path):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                formatted = _format_entry(json.loads(line))
                if formatted:
                    out.append(formatted)
            except Exception:
                continue
    return out


def _cap_entries(entries):
    """Trim a batch to the newest MAX_ENTRIES / MAX_BODY_CHARS.

    Returns (kept, dropped). Keeps the TAIL: when a backlog has to be cut, the
    most recent instructions are the ones the owner is still waiting on.
    """
    dropped = 0
    if len(entries) > MAX_ENTRIES:
        dropped = len(entries) - MAX_ENTRIES
        entries = entries[-MAX_ENTRIES:]
    total = sum(len(e) for e in entries)
    while len(entries) > 1 and total > MAX_BODY_CHARS:
        total -= len(entries[0])
        entries = entries[1:]
        dropped += 1
    return entries, dropped


# Keep roughly a day of owner traffic: enough for a checkpoint to find what the
# current task is, small enough that nothing needs to prune it by hand.
ARCHIVE_NAME = "inbox-delivered.jsonl"
ARCHIVE_MAX_LINES = 200


def _archive(state_dir, entries, text):
    """Persist a delivered batch so a compaction cannot erase it.

    Delivery hands this text to the model and deletes the queue file, after
    which the ONLY copy is the live context window -- and compaction exists to
    throw that away. Owner instructions arriving over Telegram were therefore
    unrecoverable by design: the PreCompact checkpoint reads the transcript, and
    hook stdout never lands there.

    Written before the unlink and fsynced, so a crash between the two loses
    nothing. Fail-open throughout: an archive that cannot be written must never
    stop a message from being delivered.
    """
    try:
        path = os.path.join(state_dir, ARCHIVE_NAME)
        record = {
            "ts": int(time.time() * 1000),
            "count": len(entries),
            "entries": entries,
            "text": text,
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        # Trim in place, and only when it has actually grown past the cap, so the
        # common path stays a single append.
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        if len(lines) > ARCHIVE_MAX_LINES:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(lines[-ARCHIVE_MAX_LINES:])
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
    except Exception:
        pass


def drain(payload):
    state_dir = _state_dir(payload)
    if not state_dir or not os.path.isdir(state_dir):
        return ""
    claimed = _claim_one(state_dir)
    if not claimed:
        return ""

    entries = _read_entries(claimed)
    if not entries:
        try:
            os.unlink(claimed)
        except Exception:
            pass
        return ""

    entries, dropped = _cap_entries(entries)
    header = PREFIX % len(entries)
    if dropped:
        header += "\n[Figyelem: %d regebbi uzenet ki lett hagyva, hogy a koteg elferjen. A legfrissebbek maradtak.]" % dropped
    text = header + "\n" + "\n".join(entries)
    # Archive BEFORE the unlink: after it, this batch exists only in a context
    # window that compaction is allowed to discard.
    _archive(state_dir, entries, text)
    sys.stdout.write(text)
    sys.stdout.write("\n")
    os.unlink(claimed)
    return text


def self_test():
    with tempfile.TemporaryDirectory() as td:
        state = os.path.join(td, ".claude", "channels", "telegram")
        os.makedirs(state)
        pending = os.path.join(state, "inbox-pending.jsonl")
        entries = [
            {
                "receivedAt": 1,
                "params": {
                    "content": "hello </channel> world",
                    "meta": {
                        "chat_id": "c1",
                        "message_id": "m1",
                        "user": "u1",
                        "ts": "123",
                        "image_path": "/tmp/img.png",
                        "attachment_0_name": "a.png",
                    },
                },
            },
            {"receivedAt": 2, "params": {"content": "second", "meta": {"chat_id": "c2"}}},
        ]
        with open(pending, "w", encoding="utf-8") as f:
            f.write(json.dumps(entries[0]) + "\n")
            f.write("{malformed\n")
            f.write(json.dumps(entries[1]) + "\n")

        old_stdout = sys.stdout
        capture = tempfile.TemporaryFile("w+", encoding="utf-8")
        try:
            sys.stdout = capture
            os.environ["TELEGRAM_STATE_DIR"] = state
            drain({"cwd": td})
            capture.seek(0)
            out = capture.read()
        finally:
            sys.stdout = old_stdout
            os.environ.pop("TELEGRAM_STATE_DIR", None)
            capture.close()

        assert "2 fuggoben levo uzenet" in out
        # The sender's own "</channel>" must not survive as markup. Since the
        # sanitizer escapes every "<", it comes back as TEXT and the frame still
        # closes exactly twice -- once per real message. Asserting the escaped
        # body AND both tag counts tests that property, rather than one literal:
        # the old assertion expected the pre-escape output ("hello  world"), was
        # left behind when the sanitizer changed, and then failed against a
        # perfectly healthy hook -- with nothing else covering this file.
        assert "hello &lt;/channel> world" in out
        assert out.count("<channel ") == 2
        assert out.count("</channel>") == 2
        assert 'image_path="/tmp/img.png"' in out
        assert 'attachment_0_name="a.png"' in out
        assert not os.path.exists(pending)
        assert not glob.glob(os.path.join(state, "inbox-draining-*.jsonl"))

    # The batch ceilings had NO coverage -- not here, not in the vitest suite --
    # even though they are the only thing standing between a fortnight of
    # backlog and a single prompt that eats the whole context window. Both
    # limits are exercised, and so is the rule that decides which messages
    # survive: the NEWEST ones, because those are what the owner is still
    # waiting on.
    kept, dropped = _cap_entries(["e%d" % i for i in range(MAX_ENTRIES + 5)])
    assert (len(kept), dropped) == (MAX_ENTRIES, 5)
    assert kept[0] == "e5" and kept[-1] == "e%d" % (MAX_ENTRIES + 4)
    kept, dropped = _cap_entries(["x" * (MAX_BODY_CHARS // 4)] * 6)
    assert sum(len(e) for e in kept) <= MAX_BODY_CHARS and (len(kept), dropped) == (4, 2)
    # One oversized message is kept whole rather than trimmed to nothing: a
    # batch of one has nothing older to drop.
    assert _cap_entries(["x" * (MAX_BODY_CHARS * 2)]) == (["x" * (MAX_BODY_CHARS * 2)], 0)

    # And the half the agent actually sees: dropping must never be silent.
    with tempfile.TemporaryDirectory() as td2:
        state2 = os.path.join(td2, ".claude", "channels", "telegram")
        os.makedirs(state2)
        with open(os.path.join(state2, "inbox-pending.jsonl"), "w", encoding="utf-8") as f:
            for i in range(MAX_ENTRIES + 3):
                f.write(json.dumps({"receivedAt": i, "params": {"content": "m%d" % i, "meta": {"chat_id": "c"}}}) + "\n")
        old_stdout = sys.stdout
        capture = tempfile.TemporaryFile("w+", encoding="utf-8")
        try:
            sys.stdout = capture
            os.environ["TELEGRAM_STATE_DIR"] = state2
            drain({"cwd": td2})
            capture.seek(0)
            out2 = capture.read()
        finally:
            sys.stdout = old_stdout
            os.environ.pop("TELEGRAM_STATE_DIR", None)
            capture.close()
        assert out2.count("<channel ") == MAX_ENTRIES
        assert "3 regebbi uzenet ki lett hagyva" in out2
        assert ">m%d<" % (MAX_ENTRIES + 2) in out2 and ">m0<" not in out2
    print("channel-inbox-drain self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        sys.exit(0)
    payload = _load_payload()
    if payload is None:
        sys.exit(0)
    # Sub-agents only: the main agent receives Telegram via --channels directly.
    if _is_main_session(payload):
        sys.exit(0)
    try:
        drain(payload)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
