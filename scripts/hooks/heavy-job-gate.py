#!/usr/bin/env python3
"""PreToolUse kapu (Bash): nehez folyamat csak a heavy-job.sh soron at futhat.

A MERT ESET (2026-10-17 21:32-21:37): a 10 GB-os WSL VM-en egyszerre futott egy
deploy build, egy TELJES `npx vitest run`, egy web-only peldany es harom
Playwright/chromium futas. A memoria 73% -> 93%-ra ment, a swap kifogyott, a
gep lefagyott. Egyenkent mind belefer; egyutt nem.

MIT CSINAL (kartya #683): megallit egy Bash parancsot, ha
 1. a PARAMETER NELKULI teljes tesztsuite-ot inditana helyben (`vitest run`,
    `npx vitest run`, `npm test`): helyben csak celzott fajlok futnak, a teljes
    suite helye a CI (scripts/land-pr.sh);
 2. Playwright / chromium futast inditana (node/python script, `npx playwright`);
 3. web-only peldanyt (`WEB_ONLY=true ...`) inditana;
 4. `npm run build`-et futtatna;
 5. `tsc` tipusellenorzest (`npx tsc --noEmit`) inditana: ~700 MB mindegyik, tobb agensnel
    parhuzamosan ez is a gepet fagyasztotta (2026-10-23, Boss)
 -- es NEM a `scripts/heavy-job.sh <nev> -- <parancs>` soron at. A tiltas
uzenete kiirja a helyes parancsot.

BIZTONSAGI SZELEPEK (bizonytalansag -> ATENGED, mint a tobbi kapu): csak Bash;
hianyzo/hibas payload -> enged. A deploy-live.sh es a land-pr.sh maguk a soron
futtatjak a nehez lepesuket, ezeket a kapu nem erinti. Egy `heavy-job.sh`-val
kezdodo parancs-szegmens atmegy (a mogotte allo parancs mar a soron fut).
Kikapcsolo: MARVEEN_HEAVY_JOB_GATE=0.
"""
import json
import os
import re
import shlex
import sys

SEGMENT_SPLIT = re.compile(r"\|\||&&|;|\||\n")
ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
INTERPRETERS = {"node", "nodejs", "npx", "tsx", "bun", "bunx", "pnpm", "yarn", "python", "python3", "playwright", "chromium", "chromium-browser", "google-chrome", "chrome"}
# Only signals of an actual browser launch. The bare word "playwright" in a comment, a
# card text or a commit message must not stop a command (false positive, 2026-10-17).
PLAYWRIGHT_HINT = re.compile(
    r"npx\s+(-y\s+)?playwright|playwright\s+(test|install|codegen)|from\s+playwright|import\s+playwright"
    r"|require\(\s*['\"](@?playwright[^'\"]*)['\"]|from\s+['\"]playwright|chromium\.launch|chromium-browser"
    r"|google-chrome|chrome-headless|--headless", re.I)
WEB_ONLY_HINT = re.compile(r"(^|[\s;&|(])(export\s+)?WEB_ONLY=(true|1)\b")
# vitest flags that already narrow the run to a subset.
VITEST_VALUE_FLAGS = {"--reporter", "--config", "-c", "--root", "-r", "--pool", "--outputFile", "--project", "--environment", "--mode", "--logHeapUsage", "--poolOptions", "--maxWorkers", "--minWorkers", "--testTimeout", "--retry"}
VITEST_NARROWING = {"-t", "--testNamePattern", "--changed", "--related", "--shard", "--dir"}


def allow():
    sys.exit(0)


def deny(msg):
    sys.stderr.write(msg)
    sys.exit(2)


REDIRECT = re.compile(r"^(\d*|&)(>>?|<)(&?\d*|.*)$")


def strip_redirections(toks):
    """Drop `> file`, `2>&1`, `>>file` ...: a redirect target is not a test-file argument
    (2026-10-22 `npx vitest run > log` looked narrowed to one file and ran the whole suite)."""
    out = []
    skip = False
    for t in toks:
        if skip:
            skip = False
            continue
        if t == "&":
            continue  # trailing background marker
        m = REDIRECT.match(t)
        if m:
            if not m.group(3):
                skip = True  # bare operator: the next word is its target
            continue
        out.append(t)
    return out


def words(segment):
    # A subshell or group bracket glued to the first word hid the command from the checks below
    # (quoted text stays one token, so it is unaffected): `(npx vitest run)`, `{ npx vitest run; }`.
    segment = segment.replace("(", " ").replace(")", " ")
    try:
        toks = shlex.split(segment, posix=True)
    except Exception:
        toks = segment.split()
    toks = strip_redirections(toks)
    # drop leading VAR=value assignments, `env`, `time`, `sudo`-free wrappers and their own options
    # (`nice -n 10 npx vitest run`: the `-n 10` is nice's, not the command's -- 2026-10-22 it slipped past the gate)
    while toks and (ENV_ASSIGN.match(toks[0]) or toks[0] in ("env", "time", "nice", "exec", "ionice", "nohup", "timeout")):
        wrapper = toks[0]
        toks = toks[1:]
        if wrapper == "timeout":
            # `timeout [-s SIG] [-k DUR] DURATION cmd`: drop its options and the duration
            while toks and toks[0].startswith("-"):
                toks = toks[2:] if toks[0] in ("-s", "-k", "--signal", "--kill-after") else toks[1:]
            toks = toks[1:]
        if wrapper in ("nice", "ionice"):
            while toks and (re.match(r"^-\d+$", toks[0]) or re.match(r"^-n\d+$", toks[0]) or toks[0].startswith("--adjustment=")):
                toks = toks[1:]
            if toks and toks[0] in ("-n", "--adjustment", "-c", "-p") and len(toks) > 1:
                toks = toks[2:]
    return toks


SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
SHELL_C_FLAG = re.compile(r"^-[A-Za-z]*c[A-Za-z]*$")


def nested_segments(toks, depth=0):
    """`bash -c "<cmd>"` / `eval "<cmd>"` run their payload as a command of its own: expand it
    into segments so the checks see it (2026-10-23: the wrapper hid a full suite from the gate)."""
    if not toks or depth > 3:
        return []
    payload = None
    if os.path.basename(toks[0]) in SHELLS:
        for i, t in enumerate(toks[1:], 1):
            if SHELL_C_FLAG.match(t) and i + 1 < len(toks):
                payload = toks[i + 1]
                break
    elif toks[0] == "eval" and len(toks) > 1:
        payload = " ".join(toks[1:])
    if payload is None:
        return []
    out = []
    for s in SEGMENT_SPLIT.split(payload):
        w = words(s)
        if w:
            out.append(w)
            out.extend(nested_segments(w, depth + 1))
    return out


def launched_by_runner(toks, i):
    """True when toks[i] is the program started by an npx / node / npm-exec style launcher."""
    if i == 0:
        return True
    head = os.path.basename(toks[0])
    if head in ("npx", "bunx", "bun", "tsx"):
        return i <= 5  # npx [--yes] [-p pkg] <cmd>
    if head in ("node", "nodejs"):
        return i == 1  # node node_modules/.bin/<cmd>
    if head in ("npm", "pnpm", "yarn"):
        if head != "npm" and i == 1:
            return True  # `pnpm vitest run` / `yarn tsc`: the package manager runs the local bin directly
        return len(toks) > 1 and toks[1] in ("exec", "dlx", "x") and i <= 6
    return toks[i - 1] in ("npx", "bunx", "exec", "dlx", "--no-install", "-y", "-p")


def is_heavy_job_segment(toks):
    for i, t in enumerate(toks[:3]):
        if os.path.basename(t) == "heavy-job.sh":
            return True
        if t in ("bash", "sh") and i + 1 < len(toks) and os.path.basename(toks[i + 1]) == "heavy-job.sh":
            return True
    return False


def vitest_args_full(after):
    """True when these arguments (everything after the `vitest` word) still select the whole suite."""
    if after and after[0] not in ("run", "--run") and not after[0].startswith("-"):
        return False  # `vitest watch`, `vitest related x`, `vitest <file>`: not the plain full run
    rest = [a for a in after if a not in ("run", "--run")]
    if any(a.split("=")[0] in VITEST_NARROWING for a in rest):
        return False
    positional = []
    skip = False
    for a in rest:
        if skip:
            skip = False
            continue
        if a in VITEST_VALUE_FLAGS:
            skip = True  # `--reporter dot`: the value is not a test file
        elif not a.startswith("-"):
            positional.append(a)
    return not positional  # a positional (file / dir / filter) narrows the run


def full_suite(toks):
    """True when this segment runs the WHOLE vitest suite (no file / filter given)."""
    if not toks:
        return False
    # `npm test` / `npm run test` / `pnpm test` / `yarn test`, no `-- <file>`.
    if toks[0] in ("npm", "pnpm", "yarn"):
        rest = toks[1:]
        if rest[:1] == ["run"]:
            rest = rest[1:]
        if rest[:1] in (["test"], ["test:run"]):
            # `npm test -- --reporter dot` still runs everything: judge what follows `--` like vitest's own args
            return vitest_args_full(rest[rest.index("--") + 1:] if "--" in rest else [])
    # [npx|pnpm exec|bunx|node <path>] vitest [run] [flags]
    for i, t in enumerate(toks):
        if os.path.basename(t) in ("vitest", "vitest.mjs") and launched_by_runner(toks, i):
            return vitest_args_full(toks[i + 1:])
    return False


def is_tsc(toks):
    """True for `tsc ...` / `npx tsc ...` / `node_modules/.bin/tsc ...` (a type check run)."""
    for i, t in enumerate(toks[:7]):
        if os.path.basename(t) == "tsc" and launched_by_runner(toks, i):
            return True
    # the repo's own `typecheck` script is `tsc --noEmit`
    if toks[0] in ("npm", "pnpm", "yarn"):
        rest = toks[1:]
        if rest[:1] == ["run"]:
            rest = rest[1:]
        return rest[:1] == ["typecheck"]
    return False


def is_build(toks):
    return len(toks) >= 3 and toks[0] in ("npm", "pnpm", "yarn") and toks[1] == "run" and toks[2] == "build"


MSG = (
    "\n[heavy-job kapu] {what}\n"
    "2026-10-17-en egyszerre futo nehez folyamatok (deploy build + teljes vitest + web-only + "
    "3 Playwright) a 10 GB-os VM-et 93%-ra vittek, a gep lefagyott.\n\n"
    "HELYETTE: a sor egyszerre egy nehez jobot enged:\n"
    "  scripts/heavy-job.sh <nev> -- <parancs...>\n"
    "{hint}\n"
    "(Ha tenyleg kell: MARVEEN_HEAVY_JOB_GATE=0 kikapcsolja ezt a kaput.)\n"
)


def main():
    if os.environ.get("MARVEEN_HEAVY_JOB_GATE") == "0":
        allow()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        allow()
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        allow()
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        allow()

    segments = []
    for raw in SEGMENT_SPLIT.split(command):
        w = words(raw)
        if w:
            segments.append(w)
            segments.extend(nested_segments(w))
    queued = any(is_heavy_job_segment(s) for s in segments)

    for toks in segments:
        if is_heavy_job_segment(toks):
            continue
        if full_suite(toks):
            deny(MSG.format(
                what="A TELJES tesztsuite helyben nem futhat (csak celzott fajlok).",
                hint="Celzott fajl: npx vitest run src/__tests__/<fajl>.test.ts\n"
                     "A teljes suite helye a CI: scripts/land-pr.sh \"cim\" (branch -> PR -> CI).",
            ))
        if is_tsc(toks):
            deny(MSG.format(
                what="A tsc tipusellenorzes csak a soron at futhat.",
                hint="  scripts/heavy-job.sh tsc -- npx tsc --noEmit",
            ))
        if is_build(toks):
            deny(MSG.format(
                what="`npm run build` csak a soron at futhat.",
                hint="  scripts/heavy-job.sh build -- npm run build",
            ))

    if not queued:
        if WEB_ONLY_HINT.search(command) and any(s and os.path.basename(s[0]) in INTERPRETERS | {"npm"} for s in segments):
            deny(MSG.format(
                what="Web-only peldany (WEB_ONLY=true) csak a soron at indulhat.",
                hint="  scripts/heavy-job.sh web-only -- env WEB_ONLY=true <inditoparancs>",
            ))
        if PLAYWRIGHT_HINT.search(command) and any(s and os.path.basename(s[0]) in INTERPRETERS for s in segments):
            deny(MSG.format(
                what="Playwright / chromium futas csak a soron at indulhat.",
                hint="  scripts/heavy-job.sh playwright -- node <script.js>\n"
                     "Egyszerre EGY nehez job fut; a tobbi sorban var.",
            ))
    allow()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # a gate bug must never idle an agent
