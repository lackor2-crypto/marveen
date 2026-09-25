/**
 * Putting a backup in place, and taking it back out if that fails (#396 Phase 4).
 *
 *   1. store/restore-in-progress.json is written FIRST (the dashboard refuses a
 *      normal start while it exists, and a crashed restore is rolled back on
 *      the next start -- recoverInterruptedRestore()).
 *   2. every target that will be overwritten is MOVED (rename, not copy: fast,
 *      atomic per file, needs no extra space) to store/restore-rollback/<stamp>/,
 *      and a journal line is written before each move;
 *   3. the staged file is moved into place. The DB goes in with its old
 *      -wal/-shm moved away first (a stale -wal would replay old pages over the
 *      restored DB -- the Vaultwarden lesson);
 *   4. post-restore check: DB integrity + the core table counts >= the manifest;
 *   5. pass -> flag removed, result recorded; fail -> automatic rollback from
 *      the journal, in reverse.
 *
 * ONE BOT, ONE POLLER: channel secrets (.env / access.json / invites.json /
 * approved/) and file-based scheduled tasks are not put in place: they are HELD
 * under store/restore-held/ until the owner confirms the old machine is off
 * (releaseHeld). Without a token no poller can start, whatever starts it. The
 * DB's active scheduled tasks are set to paused in the staged copy, and the
 * same confirmation resumes exactly those.
 */
import Database from 'better-sqlite3'
import {
  appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statfsSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BackupManifest } from './create.js'
import type { BackupCategory } from './inventory.js'
import { targetFor, type RestoreCtx } from './path-rewrite.js'
import { inspectDatabaseFile } from './db-snapshot.js'

export const FLAG = 'restore-in-progress.json'
export const RESULT = 'restore-result.json'
export const HELD_FILE = 'channels-paused-after-restore.json'
export const PAUSED_TASKS_FILE = 'schedules-paused-after-restore.json'
/** Categories the user may leave out; the database is all-or-nothing (§2.1). */
export const OPTIONAL_CATEGORIES: readonly BackupCategory[] = ['skills', 'schedules', 'agents', 'depot-config', 'knowledge', 'memory', 'settings', 'secrets']
const CORE_TABLES = ['kanban_cards', 'memories', 'daily_log', 'daily_logs', 'approvals', 'projects', 'kanban_comments']

export interface RestoreItem {
  logical: string
  staged: string
  /** Where it goes; for held items, the place it will go on release. */
  target: string
  category: BackupCategory
  hold: boolean
}

export interface RestorePlan {
  id: string
  createdAt: number
  file: string
  stagingDir: string
  rollbackDir: string
  heldDir: string
  ctx: RestoreCtx
  items: RestoreItem[]
  manifestCounts: Record<string, number>
  excluded: BackupCategory[]
  pausedTaskIds: string[]
  /** systemd unit of the dashboard, for the detached runner. */
  unit?: string | null
}

export function categoryOf(logical: string, cats: BackupManifest['categories']): BackupCategory {
  let best: { cat: BackupCategory; len: number } | null = null
  for (const [cat, roots] of Object.entries(cats ?? {}) as [BackupCategory, string[]][]) {
    for (const r of roots ?? []) {
      if ((logical === r || logical.startsWith(r + '/')) && (!best || r.length > best.len)) best = { cat, len: r.length }
    }
  }
  return best?.cat ?? 'settings'
}

export function isHeld(logical: string, category: BackupCategory): boolean {
  if (category === 'schedules') return true
  return /\/\.claude\/channels\/[^/]+\/(\.env|access\.json|invites\.json|approved)(\/|$)/.test(logical)
}

export function buildRestorePlan(o: {
  id: string; file: string; stagingDir: string; manifest: BackupManifest; ctx: RestoreCtx; exclude?: BackupCategory[]
}): RestorePlan {
  const exclude = (o.exclude ?? []).filter((c) => OPTIONAL_CATEGORIES.includes(c))
  const heldDir = join(o.ctx.storeDir, 'restore-held', o.id)
  const items: RestoreItem[] = []
  const paths = [...o.manifest.files.map((f) => f.path), ...(o.manifest.links ?? []).map((l) => l.path)]
  for (const logical of paths) {
    if (logical === 'manifest.json') continue
    // The NEW install's access token stays: the browser doing the restore is
    // signed in with it, and the old one could only be read from a terminal.
    // The old dashboard logins come back with the database.
    if (/^project\/store\/\.dashboard-token$/.test(logical)) continue
    const category = logical === 'project/local-commits.bundle' ? 'git' : categoryOf(logical, o.manifest.categories)
    if (category === 'reference' || category === 'logs') continue
    if (exclude.includes(category)) continue
    const target = logical === 'project/local-commits.bundle'
      ? join(o.ctx.storeDir, 'restored-local-commits.bundle')
      : targetFor(logical, o.manifest, o.ctx)
    if (!target) continue
    items.push({ logical, staged: join(o.stagingDir, logical), target, category, hold: isHeld(logical, category) })
  }
  // The DB last: everything else is in place when it lands.
  items.sort((a, b) => Number(a.category === 'database') - Number(b.category === 'database'))
  return {
    id: o.id, createdAt: Date.now(), file: o.file, stagingDir: o.stagingDir,
    rollbackDir: join(o.ctx.storeDir, 'restore-rollback', o.id), heldDir, ctx: o.ctx, items,
    manifestCounts: o.manifest.db?.counts ?? {}, excluded: exclude, pausedTaskIds: [],
  }
}

/** Pause every active DB-scheduled task in the STAGED database; returns their ids. */
export function pauseStagedSchedules(stagedDb: string): string[] {
  if (!existsSync(stagedDb)) return []
  const db = new Database(stagedDb)
  try {
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get()
    if (!has) return []
    const ids = (db.prepare("SELECT id FROM scheduled_tasks WHERE status = 'active'").all() as { id: string }[]).map((r) => r.id)
    if (ids.length) db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE status = 'active'").run()
    return ids
  } finally { db.close() }
}

/** rename, or copy+remove across filesystems. */
export function moveSafe(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try { renameSync(from, to); return } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err
  }
  const st = lstatSync(from)
  if (st.isDirectory()) cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  else if (st.isSymbolicLink()) cpSync(from, to, { verbatimSymlinks: true })
  else copyFileSync(from, to)
  rmSync(from, { recursive: true, force: true })
}

interface JournalLine { target: string; saved: string | null }

function journalPath(plan: Pick<RestorePlan, 'rollbackDir'>): string { return join(plan.rollbackDir, 'journal.jsonl') }

function exists(p: string): boolean { try { lstatSync(p); return true } catch { return false } }

/**
 * Steps 2-3. Throws on the first failure; the caller then calls rollback().
 * `failAt` is a test seam: throw before placing the item with that logical path.
 */
export function applyRestore(plan: RestorePlan, opts: { failAt?: string } = {}): string[] {
  mkdirSync(plan.rollbackDir, { recursive: true, mode: 0o700 })
  const journal = journalPath(plan)
  const skipped: string[] = []
  let n = 0
  const place = (target: string, staged: string, logical: string) => {
    if (opts.failAt === logical) throw new Error(`injected failure at ${logical}`)
    let saved: string | null = null
    if (exists(target)) {
      // A real folder where the backup has a file or a link (e.g. this install
      // has its own agents/<n>/.claude/skills folder, the backup a symlink):
      // the folder stays, the item is reported, the restore goes on.
      if (lstatSync(target).isDirectory()) { skipped.push(logical); return }
      saved = join(plan.rollbackDir, 'files', String(n++))
      appendFileSync(journal, JSON.stringify({ target, saved } satisfies JournalLine) + '\n')
      moveSafe(target, saved)
    } else {
      appendFileSync(journal, JSON.stringify({ target, saved: null } satisfies JournalLine) + '\n')
    }
    moveSafe(staged, target)
  }
  for (const it of plan.items) {
    if (!exists(it.staged)) continue
    if (it.hold) {
      // Held: kept aside, the live target is not touched.
      moveSafe(it.staged, join(plan.heldDir, it.logical))
      continue
    }
    if (it.category === 'database') {
      for (const side of ['-wal', '-shm', '-journal']) {
        const p = it.target + side
        if (exists(p)) {
          const saved = join(plan.rollbackDir, 'files', String(n++))
          appendFileSync(journal, JSON.stringify({ target: p, saved } satisfies JournalLine) + '\n')
          moveSafe(p, saved)
        }
      }
    }
    place(it.target, it.staged, it.logical)
  }
  return skipped
}

/** Undo from the journal, newest first. Idempotent: a half-done rollback can run again. */
export function rollback(rollbackDir: string): { restored: number; errors: string[] } {
  const errors: string[] = []
  let restored = 0
  let lines: JournalLine[] = []
  try {
    lines = readFileSync(join(rollbackDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return { restored, errors } }
  for (const l of lines.reverse()) {
    try {
      if (l.saved && exists(l.saved)) {
        if (exists(l.target)) rmSync(l.target, { recursive: true, force: true })
        moveSafe(l.saved, l.target)
        restored++
      } else if (!l.saved && exists(l.target)) {
        // It did not exist before the restore: remove what the restore put there.
        rmSync(l.target, { recursive: true, force: true })
        restored++
      }
    } catch (e: any) { errors.push(`${l.target}: ${e?.message || e}`) }
  }
  try { writeFileSync(join(rollbackDir, 'rolled-back'), new Date().toISOString()) } catch { /* best effort */ }
  return { restored, errors }
}

/** Step 4. */
export function postRestoreCheck(storeDir: string, manifestCounts: Record<string, number>): { ok: boolean; reason?: string } {
  const db = join(storeDir, 'claudeclaw.db')
  if (!existsSync(db)) return Object.keys(manifestCounts).length ? { ok: false, reason: 'database missing after restore' } : { ok: true }
  let info
  try { info = inspectDatabaseFile(db) } catch (e: any) { return { ok: false, reason: `database cannot be opened: ${e?.message || e}` } }
  if (info.integrity !== 'ok') return { ok: false, reason: `database integrity: ${info.integrity}` }
  for (const t of CORE_TABLES) {
    if (manifestCounts[t] === undefined) continue
    if ((info.counts[t] ?? -1) < manifestCounts[t]) return { ok: false, reason: `${t}: ${info.counts[t] ?? 0} < ${manifestCounts[t]}` }
  }
  return { ok: true }
}

export interface RestoreOutcome { ok: boolean; reason?: string; rolledBack?: boolean; rollbackErrors?: string[]; skipped?: string[]; finishedAt: number; planId: string }

/**
 * The whole in-place part (flag, apply, check, rollback), without stopping or
 * starting anything -- the runner wraps it with the service stop/start.
 */
export function performRestore(plan: RestorePlan, opts: { failAt?: string } = {}): RestoreOutcome {
  const flag = join(plan.ctx.storeDir, FLAG)
  writeFileSync(flag, JSON.stringify({ planId: plan.id, rollbackDir: plan.rollbackDir, startedAt: Date.now(), pid: process.pid }), { mode: 0o600 })
  let outcome: RestoreOutcome
  try {
    const skipped = applyRestore(plan, opts)
    const check = postRestoreCheck(plan.ctx.storeDir, plan.manifestCounts)
    if (!check.ok) throw new Error(check.reason)
    const held = plan.items.filter((i) => i.hold).map((i) => ({ held: join(plan.heldDir, i.logical), target: i.target, logical: i.logical }))
    if (held.length || plan.pausedTaskIds.length) {
      writeFileSync(join(plan.ctx.storeDir, HELD_FILE), JSON.stringify({ planId: plan.id, at: Date.now(), items: held }, null, 1), { mode: 0o600 })
      writeFileSync(join(plan.ctx.storeDir, PAUSED_TASKS_FILE), JSON.stringify({ planId: plan.id, ids: plan.pausedTaskIds }, null, 1), { mode: 0o600 })
    }
    outcome = { ok: true, skipped: skipped.slice(0, 50), finishedAt: Date.now(), planId: plan.id }
  } catch (err: any) {
    const rb = rollback(plan.rollbackDir)
    rmSync(plan.heldDir, { recursive: true, force: true })
    outcome = { ok: false, reason: String(err?.message || err).slice(0, 400), rolledBack: true, rollbackErrors: rb.errors, finishedAt: Date.now(), planId: plan.id }
  }
  writeFileSync(join(plan.ctx.storeDir, RESULT), JSON.stringify(outcome, null, 1), { mode: 0o600 })
  rmSync(plan.stagingDir, { recursive: true, force: true })
  rmSync(flag, { force: true })
  return outcome
}

/**
 * On dashboard start: a restore flag with no living runner means the runner died
 * half-way. Roll back rather than start on a half-restored tree.
 */
export function recoverInterruptedRestore(storeDir: string, isAlive: (pid: number) => boolean): RestoreOutcome | null {
  const flag = join(storeDir, FLAG)
  if (!existsSync(flag)) return null
  let f: { planId?: string; rollbackDir?: string; pid?: number } = {}
  try { f = JSON.parse(readFileSync(flag, 'utf8')) } catch { /* damaged flag: roll back what we can find */ }
  if (typeof f.pid === 'number' && f.pid !== process.pid && isAlive(f.pid)) return null
  const rb = f.rollbackDir ? rollback(f.rollbackDir) : { restored: 0, errors: ['no rollback dir recorded'] }
  const outcome: RestoreOutcome = { ok: false, reason: 'interrupted', rolledBack: true, rollbackErrors: rb.errors, finishedAt: Date.now(), planId: f.planId ?? '?' }
  writeFileSync(join(storeDir, RESULT), JSON.stringify(outcome, null, 1), { mode: 0o600 })
  rmSync(flag, { force: true })
  return outcome
}

/**
 * "The old machine is off": put the held channel secrets and scheduled tasks in
 * place (never over an existing file) and resume the paused DB tasks.
 */
export function releaseHeld(storeDir: string, resumeTasks: (ids: string[]) => number): { placed: number; kept: string[]; resumed: number } {
  const kept: string[] = []
  let placed = 0
  let resumed = 0
  const hf = join(storeDir, HELD_FILE)
  if (existsSync(hf)) {
    const data = JSON.parse(readFileSync(hf, 'utf8')) as { planId: string; items: { held: string; target: string; logical: string }[] }
    for (const it of data.items ?? []) {
      if (!exists(it.held)) continue
      if (exists(it.target) && !lstatSync(it.target).isDirectory()) { kept.push(it.logical); continue }
      if (exists(it.target) && lstatSync(it.target).isDirectory()) {
        // A folder (approved/, a scheduled task): merge file by file, no overwrite.
        for (const name of readdirSync(it.held)) {
          const src = join(it.held, name)
          const dst = join(it.target, name)
          if (exists(dst)) { kept.push(`${it.logical}/${name}`); continue }
          moveSafe(src, dst)
          placed++
        }
        continue
      }
      moveSafe(it.held, it.target)
      placed++
    }
    if (!kept.length && data.planId) rmSync(join(storeDir, 'restore-held', data.planId), { recursive: true, force: true })
    unlinkSync(hf)
  }
  const pf = join(storeDir, PAUSED_TASKS_FILE)
  if (existsSync(pf)) {
    const ids = (JSON.parse(readFileSync(pf, 'utf8')).ids ?? []) as string[]
    if (ids.length) resumed = resumeTasks(ids)
    unlinkSync(pf)
  }
  return { placed, kept, resumed }
}

export function heldPending(storeDir: string): boolean {
  return existsSync(join(storeDir, HELD_FILE)) || existsSync(join(storeDir, PAUSED_TASKS_FILE))
}

/** Free bytes on the filesystem holding `dir`. */
export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir)
    return s.bavail * s.bsize
  } catch { return null }
}
