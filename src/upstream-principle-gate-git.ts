// Git side of the upstream principle gate: turns base..upstream into per-commit
// inputs. Lives under src/ (not scripts/) so tsc and the test suite see it.

import type { CommitInput, FileChange } from './upstream-principle-gate.js'
import type { Git } from './upstream-refs.js'

const REC = '\x1e'

/** Parse `git log -p --unified=0 --format=<REC>%H%x1f%s` output into commits. */
export function parseLogPatch(raw: string): CommitInput[] {
  const out: CommitInput[] = []
  for (const chunk of raw.split(REC)) {
    if (!chunk.trim()) continue
    const nl = chunk.indexOf('\n')
    const head = nl >= 0 ? chunk.slice(0, nl) : chunk
    const [sha, subject = ''] = head.split('\x1f')
    const files: FileChange[] = []
    let cur: FileChange | null = null
    // '---'/'+++' are file headers only between 'diff --git' and the first '@@';
    // inside a hunk an added line "++ x" also reads "+++ x" and is CONTENT.
    let inHeader = false
    for (const line of (nl >= 0 ? chunk.slice(nl + 1) : '').split('\n')) {
      if (line.startsWith('diff --git ')) {
        cur = null
        inHeader = true
        continue
      }
      if (inHeader) {
        if (line.startsWith('@@')) { inHeader = false; continue }
        if (line.startsWith('+++ ')) {
          const p = line.slice(4).trim()
          if (p !== '/dev/null') {
            cur = { path: p.replace(/^b\//, ''), added: [] }
            files.push(cur)
          }
        }
        continue
      }
      if (line.startsWith('@@')) continue
      if (cur && line.startsWith('+')) cur.added.push(line.slice(1))
    }
    // A deletion-only or binary change has no '+++ b/' line; record the path
    // anyway so the file roll-up and path denylist still see it.
    const names = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/gm) ?? []
    for (const n of names) {
      const m = n.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (m && !files.some((f) => f.path === m[2])) files.push({ path: m[2], added: [] })
    }
    out.push({ sha: sha.trim(), subject: subject.trim(), files })
  }
  return out
}

/** Every non-merge commit in base..upstream, oldest first, with its added lines. */
export function gatherCommits(git: Git, base: string, upstream: string): CommitInput[] {
  const raw = git([
    'log', '--reverse', '--no-merges', '--no-color', '--no-ext-diff', '-p', '--unified=0',
    `--format=${REC}%H%x1f%s`, `${base}..${upstream}`,
  ])
  return parseLogPatch(raw)
}
