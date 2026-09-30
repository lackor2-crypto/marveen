// WORKTREE SWEEPER -- no agent leaves git garbage behind (kanban #453).
//
// The owner, 2026-09-30 (TG 2087): "Nagyon sok szemet marad a Marvinban mindig.
// [...] Meg kell csinalni, hogy egyik agens se hagyjon szemetet maga utan soha."
//
// What was measured that day: 21 worktrees under `.worktrees/`, 17 of them
// without a single commit, and 71 local `work/*` branches with no worktree at
// all. The only remover was `land-pr-worktree-cleanup.sh` (#384), and it only
// fires at the end of a landing FROM that very worktree. Everything else stays
// forever:
//   - the code bridge opens `.worktrees/code-<card>` for every Marveen task
//     (code-live-tree-worktree.ts) -- also when the run changes nothing, answers
//     a question, or lands from another worktree;
//   - a worktree removed by hand (or by `agent-worktree.sh --remove`) leaves its
//     branch behind, and a squash-merged branch never looks "merged" to git.
//
// So this sweep removes, for EVERY agent alike, what provably holds no work:
//   worktree: directly under the worktree root, nothing uncommitted, every
//             commit already on origin/main (content check, the same
//             `worktreeState` the wake-up "abandoned work" list uses), quiet for
//             SWEEP_QUIET_MS, no local process standing in it, and no queued or
//             running code-bridge task pointing at it;
//   branch:   a local `work/*` branch no worktree has checked out, quiet for
//             SWEEP_QUIET_MS, whose added lines already stand on origin/main.
//
// It never uses --force: `git worktree remove` itself refuses a tree with
// modified or untracked files, which is a second lock behind our own check.
// Anything it cannot look at is KEPT with the reason -- "could not look" is
// never "empty".
//
// FRESH INSTALL: no `.worktrees`, no branches, maybe not even an `origin` -- the
// sweep then does nothing and says why. Nothing is pre-seeded, no path, owner
// or agent id is baked in: the roots come from the caller (PROJECT_ROOT,
// MARVEEN_WORKTREE_ROOT). Off switch: MARVEEN_WORKTREE_SWEEP=0.
import { appendFileSync, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  addedLinesByFile, defaultGit, LANDED_PCT, onBasePct, parseWorktreeList, worktreeState,
  type GitRun, type WorktreeRef, type WorktreeState,
} from './abandoned-worktrees.js'

/** A worktree or branch younger than this may still be under someone's hands
 *  (a code-bridge run on Windows is invisible to /proc; a session may only have
 *  read so far). Half a day of silence is well past any single run. */
export const SWEEP_QUIET_MS = 12 * 60 * 60_000
export const SWEEP_INTERVAL_MS = 60 * 60_000
/** Only branches our own scripts make (agent-worktree.sh, code bridge). */
export const SWEPT_BRANCH_PREFIX = 'work/'

export interface SweepDeps {
  projectRoot: string
  worktreeRoot: string
  base: string
  git: GitRun
  state: (path: string) => Promise<WorktreeState>
  now: () => number
  /** Newest activity of a worktree folder (ms). */
  lastActivityMs: (wt: WorktreeRef) => number
  /** Working directories of the local processes (empty where unknowable). */
  processCwds: () => string[]
  /** workspace_path of every queued/running code-bridge task. */
  busyWorkspaces: () => string[]
  /** One line per removal, with the tip sha: `git branch <name> <sha>` brings
   *  it back (the commits stay in the object store until git's own gc). */
  record: (line: string) => void
}

export interface SweepResult {
  removedWorktrees: string[]
  removedBranches: string[]
  kept: { name: string; why: string }[]
  /** Set when the sweep could not run at all (the reason, never a guess). */
  skipped: string | null
}

const sep = /[\\/]+/

/** Does a (possibly Windows/UNC) task path point at worktree `name`? */
export function pathNamesWorktree(taskPath: string, name: string): boolean {
  return taskPath.trim().split(sep).includes(name)
}

function inside(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p + '/')
}

/** Is `branch`'s own work (merge-base..tip) already on `base`? */
export async function branchLanded(root: string, branch: string, base: string, git: GitRun): Promise<boolean> {
  const mb = await git(root, ['merge-base', branch, base])
  const tip = await git(root, ['rev-parse', branch])
  if (!mb.ok || !tip.ok) return false
  const m = mb.out.trim()
  if (m === tip.out.trim()) return true
  const diff = await git(root, ['diff', '-U0', m, branch])
  const gone = await git(root, ['diff', '--name-only', '--diff-filter=D', m, branch])
  if (!diff.ok || !gone.ok) return false
  const pct = await onBasePct(root, base, addedLinesByFile(diff.out), gone.out.split('\n').filter(Boolean), git)
  return pct >= LANDED_PCT
}

export async function sweepWorktrees(deps: SweepDeps): Promise<SweepResult> {
  const res: SweepResult = { removedWorktrees: [], removedBranches: [], kept: [], skipped: null }
  const { git, projectRoot: root } = deps
  const stamp = (): string => new Date(deps.now()).toISOString()
  const dropBranch = async (branch: string): Promise<void> => {
    const tip = (await git(root, ['rev-parse', branch])).out.trim()
    if (!(await git(root, ['branch', '-D', branch])).ok) return
    res.removedBranches.push(branch)
    deps.record(`${stamp()} branch ${branch} ${tip}  (vissza: git branch ${branch} ${tip})`)
  }
  // Without the base, "already on main" cannot be answered -- and a missing
  // answer must never read as "landed".
  if (!(await git(root, ['rev-parse', '--verify', '--quiet', deps.base])).ok) {
    res.skipped = `a(z) ${deps.base} nem olvashato ebben a repoban, ezert nem tudom eldonteni, mi van mar landolva`
    return res
  }
  const list = await git(root, ['worktree', 'list', '--porcelain'])
  if (!list.ok) { res.skipped = 'git worktree list hibat adott'; return res }
  await git(root, ['worktree', 'prune'])
  const wts = parseWorktreeList(list.out, root)
  const now = deps.now()
  const cwds = deps.processCwds()
  const busy = deps.busyWorkspaces()
  const wtRoot = resolve(deps.worktreeRoot)
  const stillCheckedOut = new Set<string>()

  for (const wt of wts) {
    const name = basename(wt.path)
    const keep = (why: string): void => {
      res.kept.push({ name, why })
      if (wt.branch) stillCheckedOut.add(wt.branch)
    }
    if (resolve(dirname(wt.path)) !== wtRoot) { keep('nem a worktree-gyoker kozvetlen almappaja'); continue }
    if (!existsSync(wt.path)) continue // prune took it
    const idle = now - deps.lastActivityMs(wt)
    if (idle < SWEEP_QUIET_MS) { keep(`friss (${Math.round(idle / 60_000)} perce volt benne valtozas)`); continue }
    if (cwds.some((c) => inside(c, wt.path))) { keep('egy futo folyamat ebben a mappaban all'); continue }
    if (busy.some((p) => pathNamesWorktree(p, name))) { keep('egy varakozo/futo kodhid-feladat ezt a mappat hasznalja'); continue }
    let st: WorktreeState
    try { st = await deps.state(wt.path) } catch (err) { keep(`nem tudtam megnezni: ${(err as Error).message}`); continue }
    if (st.kind !== 'clean') {
      keep(st.dirtyFiles.length ? `commitolatlan valtozas: ${st.dirtyFiles.slice(0, 3).join(', ')}` : `${st.unlandedCommits} nem landolt commit`)
      continue
    }
    const rm = await git(root, ['worktree', 'remove', wt.path])
    if (!rm.ok) { keep('git worktree remove megtagadta'); continue }
    res.removedWorktrees.push(name)
    deps.record(`${stamp()} worktree ${wt.path} ${wt.branch ?? '(detached)'}`)
    if (wt.branch?.startsWith(SWEPT_BRANCH_PREFIX)) await dropBranch(wt.branch)
  }

  const refs = await git(root, ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', `refs/heads/${SWEPT_BRANCH_PREFIX}`])
  if (!refs.ok) return res
  for (const line of refs.out.split('\n')) {
    const [branch, ct] = line.trim().split(' ')
    if (!branch || stillCheckedOut.has(branch) || res.removedBranches.includes(branch)) continue
    if (wts.some((w) => w.branch === branch)) continue
    if (now - (Number(ct) || 0) * 1000 < SWEEP_QUIET_MS) { res.kept.push({ name: branch, why: 'friss ag' }); continue }
    if (!(await branchLanded(root, branch, deps.base, git))) { res.kept.push({ name: branch, why: 'nem landolt munka van rajta' }); continue }
    await dropBranch(branch)
  }
  return res
}

/** Newest of: the folder itself, its git admin dir (HEAD/reflog move on every
 *  checkout and commit). A clean tree's file edits make it dirty, so they need
 *  no mtime of their own here. */
export function worktreeActivityMs(wt: WorktreeRef): number {
  const cands = [wt.path]
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(wt.path, '.git'), 'utf8'))
    if (m) { const g = m[1].trim(); cands.push(g, join(g, 'HEAD'), join(g, 'logs', 'HEAD')) }
  } catch { /* no .git file: the folder mtime alone */ }
  let best = 0
  for (const p of cands) { try { best = Math.max(best, statSync(p).mtimeMs) } catch { /* missing */ } }
  // Unreadable -> "just now": an unknown age must keep, never sweep.
  return best || Date.now()
}

/** Every local process's cwd (Linux /proc). Elsewhere empty -- the quiet
 *  window is then the guard. */
export function localProcessCwds(): string[] {
  const out: string[] = []
  let pids: string[] = []
  try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)) } catch { return out }
  for (const p of pids) { try { out.push(readlinkSync(`/proc/${p}/cwd`)) } catch { /* gone or foreign */ } }
  return out
}

export function liveSweepDeps(
  projectRoot: string, worktreeRoot: string | null, busyWorkspaces: () => string[], logFile: string | null, base = 'origin/main',
): SweepDeps {
  return {
    record: (line) => { if (logFile) { try { appendFileSync(logFile, line + '\n') } catch { /* a log that cannot be written must not stop the sweep */ } } },
    projectRoot,
    worktreeRoot: worktreeRoot ?? join(projectRoot, '.worktrees'),
    base,
    git: defaultGit,
    state: (p) => worktreeState(p, base),
    now: () => Date.now(),
    lastActivityMs: worktreeActivityMs,
    processCwds: localProcessCwds,
    busyWorkspaces,
  }
}
