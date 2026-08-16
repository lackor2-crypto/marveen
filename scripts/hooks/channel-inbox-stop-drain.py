#!/usr/bin/env python3
"""Deliver a sub-agent's pending Telegram messages at the END of a turn.

Boss, 2026-08-16, after having to walk into the agent's terminal to get an
answer: "itt a telegrammon kiadtam egy parancsot es te nem kezdted el!!!? miert?
ez a leheto legnagyobb baj ami letezhet a marveen ban."

Measured afterwards, from the archive and the transcript rather than guessed:

  17:08:06  Boss sends the message
  17:09:36  he gives up and types into the terminal (the drain hook DID run, and
            correctly found nothing: the message was not on disk yet)
  17:11:07  the tee finally writes it to inbox-pending.jsonl
  17:11-17:26  the session is mid-turn the whole time
  17:27:04  it is delivered, sixteen minutes late, and only because the agent
            happened to read the file by hand

Nothing in the chain was broken; it simply had no path for this case. A
sub-agent loads the channel plugin as a plain MCP server, so Claude Code drops
its notifications: delivery depends on either the UserPromptSubmit drain (needs
a NEW prompt, which nobody may ever type) or the wake watcher (needs an IDLE
session, and refuses to inject into a busy one to avoid the race). A message
arriving mid-turn falls between the two and waits for whichever comes first.

This closes the gap at the one moment that is both certain to arrive and free
of the race: the turn is over, so injecting cannot corrupt anything, and the
agent is about to go quiet with the owner still waiting. The Stop is blocked
once with the messages as the reason, which is exactly the "you have unread
mail" the sub-agent otherwise never gets.

Cannot loop: the batch is claimed and unlinked by the drain itself, so the next
Stop finds an empty queue. `stop_hook_active` is honored on top of that.

Fail-open everywhere. A bug here would trap an agent in a Stop it cannot
finish, which is worse than a late message -- so anything unexpected exits 0 and
lets the turn end.
"""

import importlib.util
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

INSTRUCTION = (
    "\n\n[A fenti uzenet(ek) a fordulo KOZBEN erkeztek Telegramon, ezert csak most, a "
    "fordulo vegen jutottak be. Olvasd el, es ha valaszt varnak, valaszolj MOST a "
    "telegram reply eszkozzel -- a tulajdonos a Telegramot nezi, nem ezt a terminalt.]"
)


def _load_drain_module():
    """Import the UserPromptSubmit drain and reuse ITS logic.

    Same claim-rename, same formatting, same archive, same main-agent check. A
    second implementation of any of those would drift, and the drift shows up as
    a message delivered twice or not at all.
    """
    path = os.path.join(HERE, "channel-inbox-drain.py")
    if not os.path.exists(path):
        return None
    spec = importlib.util.spec_from_file_location("channel_inbox_drain", path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _decide(payload, state_dir_override=None):
    """The whole decision, separated from stdin/stdout so it can be self-tested.

    Returns the reason text to block with, or "" to let the turn end.
    """
    if not isinstance(payload, dict) or payload.get("stop_hook_active"):
        return ""
    mod = _load_drain_module()
    if mod is None:
        return ""
    if mod._is_main_session(payload):
        return ""
    if state_dir_override:
        os.environ["TELEGRAM_STATE_DIR"] = state_dir_override
    buf = io.StringIO()
    real_stdout, sys.stdout = sys.stdout, buf
    try:
        text = mod.drain(payload)
    finally:
        sys.stdout = real_stdout
    text = (text or buf.getvalue() or "").strip()
    return (text + INSTRUCTION) if text else ""


def self_test():
    import json as _json
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        home = os.path.join(td, "agents", "tester")
        state = os.path.join(home, ".claude", "channels", "telegram")
        os.makedirs(state)
        pending = os.path.join(state, "inbox-pending.jsonl")
        entry = {
            "receivedAt": 1,
            "params": {"content": "teszt", "meta": {"chat_id": "c1", "message_id": "m1"}},
        }

        os.environ["MAIN_AGENT_ID"] = "mainbot"
        payload = {"cwd": home}

        # 1. A message waiting at the end of a turn is handed over, with the
        #    instruction that says where to answer.
        with open(pending, "w", encoding="utf-8") as f:
            f.write(_json.dumps(entry) + "\n")
        reason = _decide(payload, state)
        assert "teszt" in reason, reason
        assert "telegram reply" in reason, reason
        # 2. and the queue is consumed, so a second Stop cannot loop on it.
        assert not os.path.exists(pending)
        assert _decide(payload, state) == ""

        # 3. stop_hook_active never blocks, even with a full queue: the loop
        #    guard outranks delivery, because a Stop that cannot finish is worse
        #    than a message that waits for the next turn.
        with open(pending, "w", encoding="utf-8") as f:
            f.write(_json.dumps(entry) + "\n")
        assert _decide({"cwd": home, "stop_hook_active": True}, state) == ""
        assert os.path.exists(pending), "the queue must survive the loop guard"

        # 4. The main agent never drains: it receives Telegram natively, and
        #    stealing its queue here would hide messages from it. Its cwd is the
        #    install root itself, which is how every hook here tells the two
        #    apart (ledger_lib.agent_id_from_cwd).
        install_root = os.path.dirname(os.path.dirname(HERE))
        assert _decide({"cwd": install_root}, state) == ""
        assert os.path.exists(pending)

        # 5. Nothing to say when there is nothing pending.
        os.unlink(pending)
        assert _decide(payload, state) == ""

    print("channel-inbox-stop-drain self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        sys.exit(0)
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        sys.exit(0)
    try:
        reason = _decide(payload)
    except Exception:
        sys.exit(0)

    if not reason:
        sys.exit(0)

    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
