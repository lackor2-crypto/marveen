#!/usr/bin/env python3
"""Stop hook: when a turn ends, ask the dashboard whether this agent is over its
context threshold, and let it compact if so.

Boss, 2026-08-12, watching his own agent sit at 328000 tokens against an 80000
setting: "csinald mar meg normalisan hogy ne legyen tobb a kontextus mint 80.
igy elfogyok nagyon hamar!!!!!!"

He is right. Compaction can only run while an agent is idle, and the gate that
watches for that samples on a timer -- but an agent that works in bursts is idle
exactly BETWEEN turns, which is what the timer keeps missing. A Stop hook has no
such problem: it runs at the one moment the agent is provably idle.

Deliberately dumb. Every decision (threshold, measurement, whether compaction is
even worth another round) lives in the dashboard where it is tested; this is a
doorbell. It never blocks the stop, never prints on the happy path, and always
exits 0 -- a coordination convenience must never be able to hold up an agent.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

TIMEOUT_S = 5


def _install_dir():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    port = os.environ.get("WEB_PORT")
    if port:
        return port
    try:
        with open(os.path.join(_install_dir(), ".env"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("WEB_PORT="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return "3420"


def _token():
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token"), encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        payload = {}

    agent = ledger_lib.agent_id_from_cwd(payload.get("cwd") or os.getcwd())
    if not agent:
        return

    url = "http://localhost:%s/api/agents/%s/context-ceiling" % (_web_port(), agent)
    req = urllib.request.Request(url, data=b"{}", method="POST")
    req.add_header("Content-Type", "application/json")
    token = _token()
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError):
        return   # dashboard down or slow: not this hook's problem

    # Only say something when something happened, and say it in a way that reads
    # as an explanation rather than an error -- this lands in the user's terminal.
    if body.get("action") == "compact":
        print("[context-ceiling] %s token a %s-as hatar folott: tomorites indul."
              % (body.get("contextTokens"), body.get("threshold") or "beallitott"),
              file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception:   # noqa: BLE001 -- a hook must never break the turn
        pass
    sys.exit(0)
