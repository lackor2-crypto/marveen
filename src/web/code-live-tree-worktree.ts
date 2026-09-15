// code-live-tree-worktree: keep a code-bridge task OUT of the live checkout.
//
// WHY IT EXISTS (kanban 3837120e / #273)
// A registered chat tab lives in ONE folder. When that folder IS this install's
// own PROJECT_ROOT -- the checkout the running service is built from -- the
// bridge used to hand the executor exactly that directory: `claimNextCodeTask`
// wrote `workspace_path = session.workspacePath`, and the worker starts the CLI
// with that as its working directory (marvin-code-worker.ps1, Invoke-CodeTask:
// `--cd "$wsl.Posix"` / `$psi.WorkingDirectory = $workspace`). So a Marveen task
// edited and committed in the LIVE tree.
//
// The measured damage (2026-09-12): deploy-live.sh fast-forwards the live
// checkout to origin/main and REFUSES when the tree is dirty -- it will not
// clobber someone's uncommitted work. One executor run in the live tree
// therefore wedges the running app, and every already-landed PR stops reaching
// it. On top of that the test suite cannot even run there:
// src/__tests__/setup/assert-not-live-install.ts refuses by design, so the
// executor cannot verify its own work.
//
// Until now the only mechanism was ADVISORY prose in the dispatch preface
// (code-task-preamble.ts point 3, "work in an isolated git worktree"). An
// instruction the executor may or may not follow is not a structural fix. This
// module makes the redirect STRUCTURAL: the path the worker receives is already
// a worktree, so there is nothing for the executor to remember.
//
// WHAT IT MUST NOT DO
//  * Touch non-Marveen projects. A task whose session sits in some other folder
//    is returned unchanged -- the card scopes the change to the live checkout.
//  * Guess. Every refusal carries the ACTUAL error (git's stderr, the real
//    errno), never a supposition, and the caller logs it. A redirect that fails
//    silently would be worse than no redirect: the executor would believe it is
//    isolated while standing in the live tree.
//  * Pretend a fallback is a success. When provisioning fails we hand back the
//    live path with `redirected: false` and a `reason`, so the caller can both
//    log it and WARN THE EXECUTOR in the preface. The bridge keeps working on a
//    fresh install where git is missing or the repo is unusual; it just stops
//    being quiet about it.
//
// FRESH INSTALL: nothing here is pre-seeded. The worktree root
// (`<root>/.worktrees`, already gitignored and already the convention of
// scripts/agent-worktree.sh) is created on first use, the branch is created
// from HEAD, and node_modules is symlinked only if the live tree has one. No
// path, owner name or agent id is baked in -- the root comes from the caller.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { toLocalWorkspacePath } from './code-bridge-workspace.js'

/** How a task's working directory was decided. */
export type WorkspaceDecision = {
  /** The path to hand the worker, in the SAME shape it reported (a UNC path
   *  stays UNC, a POSIX path stays POSIX) -- the worker tests it with
   *  `Test-Path` from Windows, so the flavour must survive. */
  workspacePath: string
  /** True only when the path really is an isolated worktree. */
  redirected: boolean
  /** The worktree's branch, when we made/reused one. */
  branch: string | null
  /** Why the task is NOT isolated. `null` when it is, or when the session was
   *  never in the live tree to begin with (nothing to explain). ALWAYS the real
   *  message -- git's stderr or the OS error -- never a guess. */
  reason: string | null
  /** Was the reported session folder this install's live checkout at all? */
  wasLiveTree: boolean
  /** Did THIS call create the worktree? Decides whether a `--resume` into an
   *  earlier session is still valid: a transcript lives under the folder it was
   *  recorded in, so a BRAND NEW worktree cannot contain one, and resuming
   *  there would fail. See the caller in routes/code.ts. */
  createdWorktree: boolean
}

export type WorktreeDeps = {
  /** This install's own checkout (PROJECT_ROOT). */
  liveRoot: string
  /** Where worktrees go. Defaults to `<liveRoot>/.worktrees`, matching
   *  scripts/agent-worktree.sh (and its MARVEEN_WORKTREE_ROOT override). */
  worktreeRoot?: string
  /** Test seam: run a command and report what it actually said. */
  run?: (cmd: string, args: string[]) => { ok: boolean; stderr: string }
  /** Test seam. */
  exists?: (p: string) => boolean
  /** Test seam. */
  realpath?: (p: string) => string
}

/** Run `git` and hand back its OWN words on failure. A thrown ENOENT (no git on
 *  PATH at all) is turned into the same shape, because "git is missing" is a
 *  reason the executor must be told, not an exception to swallow. */
function defaultRun(cmd: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.error) return { ok: false, stderr: r.error.message }
  const err = (r.stderr ?? '').trim() || (r.stdout ?? '').trim()
  return { ok: r.status === 0, stderr: err }
}

function safeRealpath(p: string, fn: (s: string) => string): string {
  try {
    return fn(p)
  } catch {
    // A path that cannot be resolved is compared as written. Not a guess: it is
    // the only fact available, and the comparison below simply will not match.
    return p
  }
}

/** Trailing separators off; Windows-shaped paths folded to lower case (they are
 *  case-insensitive, POSIX ones are not and folding could equate two different
 *  directories). */
function normalize(p: string, winShaped: boolean): string {
  const s = p.replace(/[\\/]+$/, '')
  return winShaped ? s.toLowerCase() : s
}

/**
 * A worktree name that is safe as a directory AND as a git branch component.
 *
 * The input is a kanban card ref or a task id -- both already tame -- but this
 * string reaches `git worktree add` and the filesystem, so it is filtered down
 * to a known-good alphabet rather than trusted. An input that filters away to
 * nothing falls back to the task id, and if that is empty too, to a constant:
 * the function always returns a usable name, never an empty path component.
 */
export function worktreeNameFor(cardRef: string | null, taskId: string): string {
  const clean = (s: string): string => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  const card = clean(cardRef ?? '')
  if (card !== '') return `code-${card}`
  const id = clean(taskId).slice(0, 8)
  return id === '' ? 'code-task' : `code-${id}`
}

/**
 * Map a live-tree path onto the worktree, KEEPING the reported flavour.
 *
 * The worker may have reported `\\wsl.localhost\Ubuntu\home\x\marveen`; handing
 * it back `/home/x/marveen/.worktrees/code-273` would make its `Test-Path` fail
 * on Windows. Because the worktree lives UNDER the live root, the mapping is a
 * pure suffix append in the reported path's own separator style -- no
 * re-derivation of the UNC prefix, so nothing to get wrong.
 */
export function reshapeToWorktree(reported: string, liveRoot: string, worktreeDir: string): string | null {
  const rel = worktreeDir.startsWith(liveRoot) ? worktreeDir.slice(liveRoot.length) : null
  if (rel === null || rel === '') return null
  const winShaped = !reported.trim().startsWith('/')
  const base = reported.trim().replace(/[\\/]+$/, '')
  const suffix = winShaped ? rel.replace(/\//g, '\\') : rel.replace(/\\/g, '/')
  return base + suffix
}

/**
 * Decide where a claimed task should actually run.
 *
 * Returns the reported path untouched (`wasLiveTree: false`) for every session
 * that is not sitting in this install's checkout -- that is the whole of the
 * "other projects must not change" requirement, enforced here rather than
 * remembered by callers.
 */
export function resolveTaskWorkspace(
  reported: string,
  task: { id: string; cardRef: string | null },
  deps: WorktreeDeps,
): WorkspaceDecision {
  const run = deps.run ?? defaultRun
  const exists = deps.exists ?? existsSync
  const rp = deps.realpath ?? realpathSync

  const raw = (reported ?? '').trim()
  const keep = (reason: string | null, wasLive: boolean): WorkspaceDecision =>
    ({ workspacePath: raw, redirected: false, branch: null, reason, wasLiveTree: wasLive, createdWorktree: false })

  if (raw === '') return keep(null, false)

  const local = toLocalWorkspacePath(raw)
  // A path this machine cannot even express is NOT assumed to be elsewhere and
  // it is NOT assumed to be the live tree. It is simply left alone: the session
  // runs on a host we cannot reason about, so we must not rewrite its cwd.
  if (local === null) return keep(null, false)

  const winShaped = !raw.startsWith('/')
  const a = normalize(safeRealpath(local, rp), winShaped)
  const b = normalize(safeRealpath(deps.liveRoot, rp), winShaped)
  // ONLY the root itself. A session opened in a subfolder of the checkout is a
  // different situation (and moving its cwd would break its own relative
  // paths), so it is out of scope for this card.
  if (a !== b) return keep(null, false)

  const worktreeRoot = deps.worktreeRoot ?? join(deps.liveRoot, '.worktrees')
  const name = worktreeNameFor(task.cardRef, task.id)
  const dir = join(worktreeRoot, name)
  const branch = `work/${name}`

  const mapped = reshapeToWorktree(raw, deps.liveRoot, dir)
  if (mapped === null) {
    // The worktree root was moved outside the checkout (MARVEEN_WORKTREE_ROOT).
    // Then the reported flavour cannot be preserved by suffixing, and inventing
    // a prefix is exactly the guessing this module refuses to do.
    return keep(
      `A worktree (${dir}) nem a telepites alatt van, ezert a vegrehajto szamara latszo utat innen nem tudjuk megadni.`,
      true,
    )
  }

  // ALREADY THERE: reuse. A follow-up task on the same card continues in the
  // same worktree, which is what makes a multi-round job (fix -> test -> land)
  // possible at all. `git worktree list` is not consulted: the directory being
  // a working tree is what the executor needs, and a stale directory would fail
  // loudly on the executor's first git command rather than silently here.
  if (exists(dir)) {
    return { workspacePath: mapped, redirected: true, branch, reason: null, wasLiveTree: true, createdWorktree: false }
  }

  try {
    mkdirSync(worktreeRoot, { recursive: true })
  } catch (err) {
    return keep(`Nem sikerult letrehozni a worktree-mappat (${worktreeRoot}): ${errText(err)}`, true)
  }

  // An existing branch is checked out, a missing one is created from HEAD --
  // the same rule as scripts/agent-worktree.sh, so a worktree removed by hand
  // can be re-created on the card's own branch without losing its commits.
  const hasBranch = run('git', ['-C', deps.liveRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok
  const add = hasBranch
    ? run('git', ['-C', deps.liveRoot, 'worktree', 'add', dir, branch])
    : run('git', ['-C', deps.liveRoot, 'worktree', 'add', '-b', branch, dir])

  if (!add.ok) {
    // git's OWN sentence goes to the caller. This is the line that tells the
    // difference between "not a git repository", "already checked out
    // elsewhere" and "permission denied" -- three different next steps.
    return keep(add.stderr === '' ? 'git worktree add failed without an error message' : add.stderr, true)
  }

  // ~1 GB and identical, so a symlink -- and only when the live tree actually
  // has one. Failure here is NOT fatal: the worktree is usable, `npm install`
  // is the executor's fallback, and losing isolation over a convenience link
  // would be the wrong trade.
  const src = join(deps.liveRoot, 'node_modules')
  const dst = join(dir, 'node_modules')
  if (exists(src) && !exists(dst)) {
    try {
      symlinkSync(src, dst, 'dir')
    } catch {
      /* intentionally ignored -- see above */
    }
  }

  return { workspacePath: mapped, redirected: true, branch, reason: null, wasLiveTree: true, createdWorktree: true }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Remove a worktree this module created. Only used by tests and cleanup paths;
 *  it deliberately does NOT force-drop uncommitted work (same reasoning as
 *  scripts/agent-worktree.sh: an evening's edits must not vanish for
 *  convenience). Returns git's own error when it refuses. */
export function dropWorktree(dir: string, deps: Pick<WorktreeDeps, 'liveRoot' | 'run'>): { ok: boolean; error: string | null } {
  const run = deps.run ?? defaultRun
  const r = run('git', ['-C', deps.liveRoot, 'worktree', 'remove', dir])
  if (r.ok) return { ok: true, error: null }
  return { ok: false, error: r.stderr === '' ? 'git worktree remove failed without an error message' : r.stderr }
}

/** Best-effort directory removal for test fixtures. */
export function rmDirForTests(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* nothing to clean */
  }
}
