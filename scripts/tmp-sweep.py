#!/usr/bin/env python3
"""tmp-sweep: clear OLD, KNOWN leftovers out of /tmp (card #683).

Why: after the 2026-10-17 freeze the Windows restart ran systemd-tmpfiles over
/tmp and spent ~7 minutes deleting 235188 entries (980 MB) -- the user manager
(and with it the whole fleet) did not start until it finished. A small daily
sweep keeps /tmp small, so a restart never has that much to delete.

What it removes -- ONLY when ALL of these hold:
  * the entry is owned by the CURRENT uid (other users' files are never touched);
  * it is not a symlink (a link is skipped, never followed);
  * its name is a known leftover pattern (KNOWN_PATTERNS below), or it is a
    session directory inside /tmp/claude-<uid>/<project>/;
  * NOTHING inside it changed within the last N days (default 2, configurable
    with MARVEEN_TMP_SWEEP_DAYS in the environment or .env -- the owner decides
    the final number);
  * no live process of this uid references it (cwd, open file, command line,
    environment) -- this is what protects the scratchpad of a RUNNING session
    even when it has been quiet for days.

Dry run: --dry-run lists what it WOULD remove and removes nothing. Every run
(and every removal) is appended to STORE/tmp-sweep.log.

Usage: python3 scripts/tmp-sweep.py [--dry-run] [--days N] [--dir /tmp]
Exit code is always 0 unless the arguments are invalid: a housekeeping job must
never fail a unit.
"""
import fnmatch
import os
import re
import shutil
import sys
import time

KNOWN_PATTERNS = [
    "playwright*",
    "vitest*",
    "tsx-*",
    "aptprompt-*",
    "b1f-env-*",
    ".org.chromium.Chromium.*",
    "org.chromium.Chromium.*",
]
DEFAULT_DAYS = 2


def install_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env_file_value(key):
    try:
        with open(os.path.join(install_dir(), ".env"), encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"^\s*%s=(.*)$" % re.escape(key), line)
                if m:
                    return m.group(1).strip().strip("\"'")
    except OSError:
        pass
    return None


def store_dir():
    return os.environ.get("MARVEEN_STORE") or os.path.join(install_dir(), "store")


def log_line(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        os.makedirs(store_dir(), exist_ok=True)
        with open(os.path.join(store_dir(), "tmp-sweep.log"), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def resolve_days(cli_days):
    raw = cli_days if cli_days is not None else (os.environ.get("MARVEEN_TMP_SWEEP_DAYS") or env_file_value("MARVEEN_TMP_SWEEP_DAYS"))
    try:
        d = float(raw) if raw not in (None, "") else DEFAULT_DAYS
    except ValueError:
        d = DEFAULT_DAYS
    return d if d > 0 else DEFAULT_DAYS


def live_references(uid):
    """Text blob of everything live processes of this uid point at (cwd, fds, cmdline, environ)."""
    parts = []
    me = os.getpid()
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == me:
            continue
        base = "/proc/" + pid
        try:
            if os.stat(base).st_uid != uid:
                continue
        except OSError:
            continue
        for name in ("cmdline", "environ"):
            try:
                with open(base + "/" + name, "rb") as fh:
                    parts.append(fh.read(262144).replace(b"\0", b" ").decode("utf-8", "replace"))
            except OSError:
                pass
        try:
            parts.append(os.readlink(base + "/cwd"))
        except OSError:
            pass
        try:
            for fd in os.listdir(base + "/fd"):
                try:
                    parts.append(os.readlink(base + "/fd/" + fd))
                except OSError:
                    pass
        except OSError:
            pass
    return "\n".join(parts)


def newest_mtime(path):
    """Newest mtime under path (the path itself included); stops early at `stop`."""
    newest = 0.0
    try:
        newest = os.lstat(path).st_mtime
    except OSError:
        return newest
    if not os.path.isdir(path) or os.path.islink(path):
        return newest
    for root, dirs, files in os.walk(path, followlinks=False):
        for n in dirs + files:
            try:
                m = os.lstat(os.path.join(root, n)).st_mtime
            except OSError:
                continue
            if m > newest:
                newest = m
    return newest


def collect_candidates(tmp, uid):
    out = []
    try:
        names = os.listdir(tmp)
    except OSError:
        return out
    for n in sorted(names):
        p = os.path.join(tmp, n)
        try:
            st = os.lstat(p)
        except OSError:
            continue
        if st.st_uid != uid or os.path.islink(p):
            continue
        if n == "claude-%d" % uid and os.path.isdir(p):
            # <project>/<session>: only whole session directories are candidates.
            try:
                projects = os.listdir(p)
            except OSError:
                continue
            for proj in sorted(projects):
                pp = os.path.join(p, proj)
                if os.path.islink(pp) or not os.path.isdir(pp):
                    continue
                try:
                    sessions = os.listdir(pp)
                except OSError:
                    continue
                for sess in sorted(sessions):
                    sp = os.path.join(pp, sess)
                    if not os.path.islink(sp) and os.path.isdir(sp):
                        out.append(sp)
            continue
        if any(fnmatch.fnmatch(n, pat) for pat in KNOWN_PATTERNS):
            out.append(p)
    return out


def main(argv):
    dry = False
    cli_days = None
    tmp = os.environ.get("MARVEEN_TMP_DIR") or "/tmp"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--dry-run":
            dry = True
        elif a == "--days" and i + 1 < len(argv):
            cli_days = argv[i + 1]
            i += 1
        elif a == "--dir" and i + 1 < len(argv):
            tmp = argv[i + 1]
            i += 1
        else:
            sys.stderr.write("usage: tmp-sweep.py [--dry-run] [--days N] [--dir DIR]\n")
            return 64
        i += 1

    uid = os.getuid()
    days = resolve_days(cli_days)
    cutoff = time.time() - days * 86400
    refs = live_references(uid)
    removed = kept_new = kept_live = 0
    freed = 0
    for path in collect_candidates(tmp, uid):
        if newest_mtime(path) >= cutoff:
            kept_new += 1
            continue
        if path in refs:
            kept_live += 1
            log_line("keep (in use by a live process): %s" % path)
            continue
        size = 0
        try:
            for root, _d, files in os.walk(path, followlinks=False):
                for f in files:
                    try:
                        size += os.lstat(os.path.join(root, f)).st_size
                    except OSError:
                        pass
        except OSError:
            pass
        if dry:
            log_line("would-remove: %s (%d KB)" % (path, size // 1024))
            removed += 1
            freed += size
            continue
        try:
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.unlink(path)
            log_line("removed: %s (%d KB)" % (path, size // 1024))
            removed += 1
            freed += size
        except OSError as e:
            log_line("skip (%s): %s" % (e, path))
    log_line("%s: %d %s, %d newer than %g days kept, %d in use kept, ~%d MB" % (
        "dry-run" if dry else "sweep", removed, "would go" if dry else "removed",
        kept_new, days, kept_live, freed // (1024 * 1024)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as e:  # housekeeping must never fail a unit
        sys.stderr.write("tmp-sweep: %s\n" % e)
        sys.exit(0)
