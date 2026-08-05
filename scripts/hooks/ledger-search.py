#!/usr/bin/env python3
"""CLI: on-demand keyword search over the conversation ledger (store/claudeclaw.db
-> conversation_log). Use this when the owner refers back to something the
current session's context doesn't hold (SessionStart only replays a recent
window), instead of guessing or re-asking. Deliberately NOT wired into any
hook -- it is a targeted, agent-invoked lookup so it only costs tokens when
actually needed, not on every turn.

Usage: python3 ledger-search.py <keyword> [limit] [agent_id]
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print("usage: ledger-search.py <keyword> [limit] [agent_id]", file=sys.stderr)
        sys.exit(1)
    keyword = sys.argv[1]
    limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else 20
    agent_id = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else ledger_lib.main_agent_id()

    rows = ledger_lib.search(agent_id, keyword, limit)
    if not rows:
        print("(nincs talalat)")
        return

    owner = ledger_lib.owner_name()
    for direction, chat_id, text, ts in rows:
        who = owner if direction == "in" else "Marvin"
        print(f"[{ts}] {who}: {text}")


if __name__ == "__main__":
    main()
