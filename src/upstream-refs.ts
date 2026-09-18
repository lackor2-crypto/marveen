// Shared upstream reference resolution for every upstream measurement.
//
// WHY one module: three tools look at "what changed upstream" -- the
// divergence check (scripts/upstream-divergence-check.sh), the changelog list
// shown on the dashboard (scripts/upstream-changelog.ts) and the principle gate
// (scripts/upstream-principle-gate.ts). Measured 2026-09-18: the list read
// upstream/develop from the revert-aware point (448 commits) while the gate read
// upstream/main from a plain merge-base (265 commits), so ~180 commits were never
// reviewed by the gate at all. The same question must get the same answer, so
// the TypeScript tools resolve through here, and the shell check follows the
// same rule (upstream/HEAD if set, otherwise upstream/main).
//
// Why main and not develop as the fallback: this fork merged upstream release
// merges (main) ~60 times without trouble; the single upstream/develop merge was
// reverted (7ae7b421). main is what upstream has already tried and released.

export type Git = (args: string[]) => string

/** The upstream branch to compare against, or null when there is none.
 *  Order: refs/remotes/upstream/HEAD (the remote's own default) -> upstream/main.
 *  Never guesses a branch that does not exist: a null here must surface as
 *  "could not look", not as "nothing changed". */
export function resolveUpstreamRef(git: Git): string | null {
  try {
    const sym = git(['symbolic-ref', '-q', 'refs/remotes/upstream/HEAD']).trim()
    if (sym) return sym.replace(/^refs\/remotes\//, '')
  } catch { /* not set -- fall through */ }
  try {
    git(['rev-parse', '--verify', '-q', 'refs/remotes/upstream/main'])
    return 'upstream/main'
  } catch {
    return null
  }
}

/**
 * Where to measure from.
 *
 * `git revert -m 1` returns the CONTENT, not the history: the reverted upstream
 * merge commit stays an ancestor, so git believes those commits are already in.
 * Measured 2026-08-23: the list would have shown 1 commit instead of 137. The
 * comparison point is then the state BEFORE that merge.
 *
 * No guessing: the target is read from the "This reverts commit <sha>" line that
 * `git revert` writes, and we step back only when that target really is a MERGE
 * (two parents) whose second parent is an ancestor of the upstream branch. A
 * plain commit revert does not move the point. The OLDEST such revert wins.
 */
export function compareFrom(git: Git, local: string, upstream: string): string {
  let from = local
  // --grep is only a pre-filter, deliberately unanchored; the real condition is
  // the line-anchored /m regex and the merge check below.
  const revs = git(['log', local, '--format=%H', '--grep=This reverts commit']).split('\n')
  for (const rev of revs) {
    if (!rev.trim()) continue
    const body = git(['log', '-1', '--format=%B', rev.trim()])
    const m = body.match(/^This reverts commit ([0-9a-f]{7,40})/m)
    if (!m) continue
    let parents: string[]
    try {
      parents = git(['log', '-1', '--format=%P', m[1]]).trim().split(/\s+/).filter(Boolean)
    } catch { continue }
    if (parents.length !== 2) continue
    try {
      git(['merge-base', '--is-ancestor', parents[1], upstream])
    } catch { continue }
    from = git(['rev-parse', `${m[1]}^1`]).trim()
  }
  return from
}

/** The base commit of the upstream-only range: merge-base(compareFrom, upstream). */
export function upstreamBase(git: Git, local: string, upstream: string): string {
  return git(['merge-base', compareFrom(git, local, upstream), upstream]).trim()
}
