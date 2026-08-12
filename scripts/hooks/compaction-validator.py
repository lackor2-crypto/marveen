#!/usr/bin/env python3
"""PostCompact hook: check what the compaction summary DROPPED.

Phase 3 of the context-management architecture (kanban 55af1bfe,
docs/context-compaction-knowledge.md points 24 and 36). A summary is written by
a model and nobody checks it, so the things it quietly loses -- a hard user
requirement, an exact number, a filename, the next action -- are lost silently.
This compares the summary against the structured checkpoint the PreCompact hook
just wrote and reports what is missing.

Deterministic on purpose: plain token matching, no model call, so validating a
compaction costs nothing. The Claude Code PostCompact contract gives us
`compact_summary` on stdin and can only return an operator-visible message (no
context injection), so this hook REPORTS. The repair already exists elsewhere:
the SessionStart(compact) replay re-injects the structured record itself.

Every finding is also appended to store/compaction-quality.jsonl, which is the
raw material for the recall benchmark (phase 7).

Fail-open in every branch: a compaction must never be disturbed by its own
quality check, so this exits 0 whatever happens.
"""
import sys
import os
import json
import re
import time
import urllib.request

# Categories worth flagging, in the order they matter. The label is what the
# operator reads, so it says what was lost, not which field name holds it.
CATEGORIES = [
    ("constraints", "kotott kovetelmeny (amit a felhasznalo kikotott)"),
    ("exactValues", "pontos ertek (szam / utvonal / verzio)"),
    ("rejected", "mar elvetett megkozelites"),
    ("decisions", "dontes"),
    ("filesChanged", "erintett fajl"),
]

MIN_TOKEN_LEN = 4
# An item counts as carried over when most of its meaningful words survived.
# Deliberately lenient: a summary legitimately rephrases, and a false alarm on
# every compaction would train everyone to ignore this hook.
PRESENT_RATIO = 0.6


def _project_root():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env_value(key, default):
    v = os.environ.get(key)
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return default


def _token():
    # Env first so a test (or an install that keeps the token elsewhere) can
    # point this at another dashboard without writing into the checkout: a
    # store/.dashboard-token file is what marks a checkout as a LIVE install,
    # and creating one would make the whole test suite refuse to run there.
    v = os.environ.get("MARVEEN_DASHBOARD_TOKEN")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), "store", ".dashboard-token")) as f:
            return f.read().strip()
    except Exception:
        return ""


def _agent_id_from_cwd(cwd):
    """agents/<name>/... -> <name>; the project root -> the main agent."""
    if not cwd:
        return None
    root = os.path.normpath(_project_root())
    norm = os.path.normpath(cwd)
    parts = norm.split(os.sep)
    if "agents" in parts:
        i = parts.index("agents")
        if i + 1 < len(parts):
            return parts[i + 1]
    if norm == root:
        return _env_value("MAIN_AGENT_ID", "marveen")
    return None


def _read_record(agent, token):
    port = _env_value("WEB_PORT", "3420")
    url = "http://localhost:%s/api/agent-taskstate/%s" % (port, agent)
    req = urllib.request.Request(url)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def _norm(text):
    return re.sub(r"\s+", " ", (text or "").lower())


def _numbers(text):
    """Numeric literals, digit separators stripped: 150 000 and 150000 match."""
    return set(re.sub(r"[\s_.,]", "", n) for n in re.findall(r"\d[\d\s_.,]*\d|\d", text or ""))


def _item_present(item, summary_norm, summary_numbers):
    """Is this checkpoint item still recognisable in the summary?"""
    # Pure numbers are handled by the exact check below, and must NOT also be
    # matched as words: "150000" in the record is legitimately written "150 000"
    # in the summary, which is the same value but not the same string.
    words = [
        w for w in re.findall(r"[\w./-]+", _norm(item))
        if len(w) >= MIN_TOKEN_LEN and not re.fullmatch(r"[\d\s_.,-]+", w)
    ]
    # A number in the item must appear EXACTLY. This is the drift the knowledge
    # base singles out: "timeout = 37 seconds" becoming "roughly 40 seconds" is
    # a defect, not a paraphrase, so no ratio applies to digits.
    for n in _numbers(item):
        if n not in summary_numbers:
            return False
    if not words:
        return True
    hits = sum(1 for w in words if w in summary_norm)
    return (hits / len(words)) >= PRESENT_RATIO


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    summary = payload.get("compact_summary") or ""
    trigger = payload.get("trigger") or "?"
    agent = _agent_id_from_cwd(payload.get("cwd") or os.getcwd())
    if not agent:
        sys.exit(0)
    token = _token()
    if not token:
        sys.exit(0)

    try:
        record = _read_record(agent, token) or {}
    except Exception:
        sys.exit(0)  # dashboard unavailable -> stay quiet

    # No checkpoint is the correct state for an idle session (the PreCompact
    # prompt says to skip it then), so this is stated as a fact, not an alarm.
    has_content = any(record.get(k) for k, _ in CATEGORIES) or record.get("nextAction")
    if not record or not has_content:
        _log({"ts": int(time.time()), "agent": agent, "trigger": trigger,
              "summaryChars": len(summary), "checkpoint": False})
        print("Tomorites-ellenorzes: nem volt strukturalt checkpoint amihez hasonlithatnank "
              "(tetlen munkamenetnel ez rendben van).")
        sys.exit(0)

    summary_norm = _norm(summary)
    summary_numbers = _numbers(summary)

    missing = []
    for key, label in CATEGORIES:
        items = [i for i in (record.get(key) or []) if str(i).strip()]
        gone = [i for i in items if not _item_present(str(i), summary_norm, summary_numbers)]
        if gone:
            missing.append((label, gone))

    next_action = str(record.get("nextAction") or "").strip()
    next_lost = bool(next_action) and not _item_present(next_action, summary_norm, summary_numbers)

    _log({
        "ts": int(time.time()), "agent": agent, "trigger": trigger,
        "summaryChars": len(summary), "checkpoint": True,
        "missing": {label: gone for label, gone in missing},
        "nextActionLost": next_lost,
    })

    if not missing and not next_lost:
        print("Tomorites-ellenorzes: a checkpoint minden fontos eleme megvan az osszefoglaloban.")
        sys.exit(0)

    lines = ["Tomorites-ellenorzes: az osszefoglalobol KIMARADT nehany dolog. "
             "A strukturalt checkpoint visszatoltodik, tehat nem veszett el -- de erre figyelj:"]
    if next_lost:
        lines.append("  - a kovetkezo akcio: %s" % next_action)
    for label, gone in missing:
        for item in gone[:3]:
            lines.append("  - %s: %s" % (label, item))
        if len(gone) > 3:
            lines.append("  - ... es tovabbi %d %s" % (len(gone) - 3, label))
    print("\n".join(lines))
    sys.exit(0)


def _log(entry):
    try:
        path = os.path.join(_project_root(), "store", "compaction-quality.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    main()
