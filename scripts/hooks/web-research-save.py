#!/usr/bin/env python3
"""PostToolUse hook (WebSearch | WebFetch): every web result an agent reads is saved to the Research (#908).

The save is done by the SYSTEM, not by the agent remembering a rule: the result goes to the agent's own
research/ folder through POST /api/research/capture, where the Research page and the Workbench list it.
The hook then reminds the agent (additionalContext) to carry the facts into the work item's Context file and
the open points into the To-dos.

It never blocks and never fails the tool: dashboard down, no token, empty result -> silent exit 0.
Agent identity comes from ledger_lib (one resolver for every hook). Kill switch: MARVEEN_WEB_RESEARCH_SAVE=0.
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

TOOLS = ("WebSearch", "WebFetch")

REMINDER = (
    "A webes eredmeny elmentve a Kutatasba ({name}). Ha munkadarabon dolgozol: a talalt TENYEKET es a forrast "
    "ird be a munkadarab Kontextus fajljaba (context.append), a kovetkezo lepeseket / nyitott pontokat pedig a "
    "Teendok koze. / The web result was saved to the Research ({name}). If you work on a work item, add the facts and "
    "the source to its Context file and the open points to its To-dos."
)


def _install_dir() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _web_port() -> str:
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_install_dir(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


def _dashboard_token() -> str:
    try:
        with open(os.path.join(_install_dir(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


def response_text(resp) -> str:
    """The text the agent actually read, whatever shape the tool response has."""
    if resp is None:
        return ""
    if isinstance(resp, str):
        return resp
    if isinstance(resp, dict):
        if resp.get("is_error") or resp.get("error"):
            return ""
        for key in ("result", "content", "text", "output"):
            v = resp.get(key)
            if isinstance(v, str) and v.strip():
                return v
        # search results: a list of {title, url, ...} blocks next to the summary text
        try:
            return json.dumps(resp, ensure_ascii=False, indent=2)
        except Exception:
            return ""
    if isinstance(resp, list):
        parts = []
        for item in resp:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
            else:
                try:
                    parts.append(json.dumps(item, ensure_ascii=False, indent=2))
                except Exception:
                    pass
        return "\n\n".join(p for p in parts if p.strip())
    return ""


def build_body(payload: dict):
    """The POST body, or None when this event is not a saveable web result."""
    tool = payload.get("tool_name") or ""
    if tool not in TOOLS:
        return None
    tin = payload.get("tool_input") or {}
    text = response_text(payload.get("tool_response"))
    if not text.strip():
        return None
    query = str(tin.get("query") or "").strip() if tool == "WebSearch" else ""
    url = str(tin.get("url") or "").strip() if tool == "WebFetch" else ""
    if tool == "WebFetch" and tin.get("prompt"):
        query = str(tin.get("prompt")).strip()[:200]
    if not query and not url:
        return None
    return {
        "agent_id": ledger_lib.agent_id_from_payload(payload),
        "tool": tool,
        "query": query,
        "url": url,
        "text": text,
    }


def main() -> None:
    if os.environ.get("MARVEEN_WEB_RESEARCH_SAVE") == "0":
        sys.exit(0)
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    body = build_body(payload)
    if body is None:
        sys.exit(0)
    token = _dashboard_token()
    if not token:
        sys.exit(0)
    try:
        req = urllib.request.Request(
            f"http://localhost:{_web_port()}/api/research/capture",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            out = json.loads(r.read().decode() or "{}")
    except Exception:
        sys.exit(0)  # never block the agent
    if out.get("ok") and out.get("name"):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": REMINDER.format(name=out["name"]),
        }}, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
