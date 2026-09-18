---
name: upstream-principle-gate
description: Use BEFORE merging or installing upstream (Szotasz/marveen) changes into this fork. Reviews each incoming change against this fork's baked-in principles (agent equality, host-agnosticism, no forced context cap, no auto-done, ...) and against a committed denylist -- NOT just textual conflict. Auto-excludes hard violations, flags weaker signals for the owner, keeps protective wallet/data guards. Runs identically on a fresh install.
scope: global
---

# Upstream principle gate

## When to use
Trigger this WHENEVER you are about to pull, merge, cherry-pick or install
changes from the upstream Marveen (`Szotasz/marveen`) into this fork. "It merges
cleanly / no textual conflict" is NOT sufficient reason to take a change: a
cleanly-mergeable file can still carry LOGIC that contradicts what the owner
deliberately rewrote in this fork.

This exists because the owner rebuilt this Marveen on purpose: every agent is
equal (no privileged main assistant, no "one agent may, another may not"), no
hardcoded owner/host identity, no forced context-window cap / proactive `/clear`,
and cards go to `done` only by the owner. An upstream change that reintroduces
any of those must not slip back in silently -- not here, and not on a fresh
install of this fork elsewhere.

## What it is (baked in, travels with the repo)
- `src/upstream-principle-gate.ts` -- the baked principle list + classifier.
  The principles are code, not a per-machine file, so a FRESH install behaves
  exactly like the origin install. Identity is detected as a *pattern* (absolute
  home path, repo URL, long numeric chat id, `.service` literal), never a
  concrete name -- so the module itself passes `template-identity-hygiene`.
- `governance/upstream-exclusions.json` -- a committed, git-tracked denylist of
  changes explicitly excluded from install. Keyed on a STABLE signature
  (principle + normalized path glob OR content signature), NEVER a raw upstream
  commit hash (hashes drift across forks/rebases). Empty `entries` = nothing
  excluded yet (valid on a fresh install); it does NOT mean the gate did not run.
- `scripts/upstream-principle-gate.ts` -- the CLI you run before a merge.

## Two-tier decision (owner's wording)
- **RED -> auto-exclude** (high confidence violation): agent-differentiation,
  hardcoded host identity, forced context cap / proactive `/clear`, auto-done.
  These are removed from install automatically.
- **FLAG -> owner decides** (weaker signal): agent-parity/scaffold infrastructure
  touch, a new non-protective gate/guard/approval, a UI-text file (bilingual
  risk). Surface these to the owner on Telegram; do not decide alone.
- **GREEN -> allowed** (protective): wallet/keret/quota/budget guards and
  data/integrity guards (backup, homoglyph, provenance, audit, no-stray) are
  kept even though they are technically "guards" -- they protect, not restrict.

## Procedure
1. Fetch upstream so the ref resolves: `git fetch upstream`.
2. From the repo root (in an isolated worktree, never the live tree) run:
   ```bash
   tsx scripts/upstream-principle-gate.ts            # human report
   tsx scripts/upstream-principle-gate.ts --json     # machine report
   ```
   Optional: `--upstream <ref>` (default `upstream/main`), `--base <ref>`
   (default `merge-base HEAD upstream/main`), or `--changes <file.json>` to
   review a hand-supplied list of `{path, subjects?, addedLines?}`.
3. Read the exit code by MEANING, not just presence:
   - `0` = reviewed, nothing excluded (there may still be DISCUSS items to raise).
   - `1` = reviewed, at least one item EXCLUDED -- a merge step must stop / drop
     those paths.
   - `2` = could NOT review (upstream ref missing, denylist unreadable/invalid).
     This is NOT "0 exclusions". Fix the source (fetch upstream) and re-run.
4. For every EXCLUDE: leave it out of the merge. If it is a NEW standing
   decision (not already covered by a red principle), record it in
   `governance/upstream-exclusions.json` with principle + stable signature +
   note + date + who decided, so a fresh install cannot install it either.
5. For every DISCUSS: ask the owner on Telegram with the concrete path and which
   principle it touches, and A/B (take it / drop it). Do not guess.
6. Proceed to merge only the ALLOW + owner-approved DISCUSS set.

## Pitfalls
- **Exit 2 is not clean.** A zero exclusion count from an unreviewed source is
  the "zero means two things" trap: fresh-install-empty vs. broken-access. The
  CLI fails loud (exit 2) when it cannot see upstream; never read that as "safe".
- **Never key the denylist on an upstream commit hash.** Hashes drift on
  fork/rebase; use the principle + path glob or content signature.
- **Do not hardcode any owner/host identity** to detect identity -- match the
  pattern. A concrete name in this module would itself fail
  `template-identity-hygiene`.
- **Protective vs. restrictive.** A wallet/keret or data-integrity guard is
  GREEN even though it contains the word "guard"/"gate". Only a NON-protective
  new gate is a FLAG. The classifier checks protective BEFORE flag for this
  reason.
- **The gate reviews logic, not just text.** Detection is driven by commit
  subjects + added lines + path role, so a change with a bland diff but a
  telling subject is still caught.

## Verification
```bash
npx vitest run src/__tests__/upstream-principle-gate.test.ts
npx tsc --noEmit
```
The test covers each RED principle (exclude), GREEN protective (allow), FLAG
(discuss), neutral fix (allow), the committed denylist, denylist validation
(unknown principle / missing signature throw, not silently-empty), stable
content signature, and the fresh-install/empty-denylist + "zero means two
things" cases.
