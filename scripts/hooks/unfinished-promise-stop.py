#!/usr/bin/env python3
"""Do not let a turn end on an unkept promise ("folytatom a #841-gyel").

Boss, 2026-11-02 (kanban #842): he left the Szakerto agent "working" and came
home to find it standing still. Measured from the session file, not guessed: the
turn ended at 16:59:17 with a done-message whose last line said "Folytatom a
#841-gyel", and then NOTHING happened until 18:52:43. The agent was not stopped
by anyone; the turn was over, and an idle Claude Code session sits on its prompt
until some input arrives. The sentence promised work the turn had no way to do.

This hook runs when a turn is about to end. If the last turn's text (the final
assistant message or a Telegram reply sent in it) ends in a commitment to keep
going ("folytatom", "kezdem", "megcsinalom", "nekilatok", ...), the Stop is
blocked ONCE with a reminder: start the work now, or say plainly why you are
stopping (limit, a question waiting for the owner). It cannot loop:
`stop_hook_active` is honored, so the second Stop always goes through.

Fail-open everywhere: any doubt exits 0 and lets the turn end.
"""

import json
import re
import sys
import unicodedata

REASON = (
    "[Vallalt folytatas: az utolso uzeneted azt mondja, hogy folytatod a munkat "
    "(\"{hit}\"), de a kor veget er, es utana semmi nem indit tovabb: a session "
    "a promptnal fog allni. Vagy KEZDD EL MOST (az elso lepest ebben a korben "
    "told ki), vagy mondd ki egy mondatban, MIERT allsz meg (kimerult keret, a "
    "tulajdonos valaszara varsz). Ha nem folytatod, ne irj \"folytatom\"-ot.]"
)

# A commitment to continue/start, in the first person, near the end of a text.
PROMISE = re.compile(
    r"\b(folytatom|folytatok|kezdem|elkezdem|nekilatok|megcsinalom|csinalom|"
    r"viszem|jovok|jelzek ha|jelzek, ha|hamarosan|mindjart)\b"
)
# Conditional / negated forms are not a promise ("ha kered, folytatom", "nem folytatom").
HEDGE = re.compile(r"\b(ha |nem |nem fogom|csak ha|kerdes|valasz)\b")
# A stop that says WHY (limit / waiting for the owner) is a stated reason, not a broken promise.
REASONED = re.compile(r"(keret|limit|varom|varok|valaszodra|dontesedre|kerdes[a-z]* (a|b)\b)")


def fold(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def last_turn_texts(transcript_path, max_bytes=400_000):
    """Texts of the final turn: assistant text blocks and Telegram reply texts
    after the last real user message."""
    try:
        with open(transcript_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            raw = f.read().decode("utf-8", "replace")
    except Exception:
        return []
    rows = []
    for line in raw.splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    texts = []
    for r in rows:
        m = r.get("message") if isinstance(r.get("message"), dict) else None
        if not m:
            continue
        content = m.get("content")
        if r.get("type") == "user":
            if isinstance(content, str) or (
                isinstance(content, list) and any(isinstance(x, dict) and x.get("type") == "text" for x in content)
            ):
                texts = []  # a real user/system prompt starts a new turn
            continue
        if r.get("type") != "assistant" or not isinstance(content, list):
            continue
        for x in content:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "text" and x.get("text"):
                texts.append(x["text"])
            elif x.get("type") == "tool_use" and "telegram" in str(x.get("name", "")) and "reply" in str(x.get("name", "")):
                t = (x.get("input") or {}).get("text")
                if t:
                    texts.append(t)
    return texts


def _decide(payload, texts=None):
    if not isinstance(payload, dict) or payload.get("stop_hook_active"):
        return ""
    if texts is None:
        texts = last_turn_texts(payload.get("transcript_path") or "")
    if not texts:
        return ""
    # Only the closing sentences of the LAST text count: a promise made earlier and kept is not a problem.
    tail = fold(texts[-1].strip())[-260:]
    sentences = [s for s in re.split(r"[.!?\n]+", tail) if s.strip()]
    for s in sentences[-2:]:
        m = PROMISE.search(s)
        if m and not HEDGE.search(s) and not REASONED.search(s):
            return REASON.format(hit=s.strip()[:80])
    return ""


def self_test():
    p = {}
    assert _decide(p, ["A #840 kesz. Folytatom a #841-gyel."]), "plain promise must block"
    assert _decide(p, ["Kesz a javitas, landolt. Mehet a #841, kezdem."]), "kezdem must block"
    assert not _decide(p, ["Kesz, landolt (PR #1604)."]), "a plain done message must pass"
    assert not _decide(p, ["Ha kered, folytatom a #841-gyel."]), "conditional must pass"
    assert not _decide(p, ["A keret 100%, folytatom, ha visszaall."]), "stated reason must pass"
    assert not _decide(p, ["Varom a valaszodat, utana folytatom."]), "waiting for the owner must pass"
    assert not _decide({"stop_hook_active": True}, ["Folytatom a #841-gyel."]), "loop guard"
    assert not _decide(p, []), "no text"
    # the exact sentence that went unkept on 2026-11-02
    assert _decide(p, ["Kartya a varakozoban. Folytatom a #841-gyel."])
    print("unfinished-promise-stop self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()
        sys.exit(0)
    try:
        payload = json.loads(sys.stdin.read())
        reason = _decide(payload)
    except Exception:
        sys.exit(0)
    if not reason:
        sys.exit(0)
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
