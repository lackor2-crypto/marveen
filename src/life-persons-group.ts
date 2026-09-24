// THE PERSONS' COMMON FOLDER ("Család") -- moving existing person folders.
//
// The owner (2026-09-24): the family members should stand under one root
// "Család" folder, not scattered at the root next to Cégek, Tudás, Archív.
// The layout itself is `LifeConfig.personsGroup` (see `personRel()`); this
// module moves what is ALREADY on disk when that setting changes.
//
// Why it cannot just be saved: if only the config changed, the next
// `ensureLifeTree` would build a second, empty tree under "Család" while the
// real folders (with the documents) stayed at the root -- two copies of every
// person, and the inbox filing into the empty one. So a change of the group
// is always: preview (what moves where) -> the user confirms -> move.
//
// What follows the folders: the git mounts (life-mounts.json), the display
// labels (life-labels.json), the archived marks (life-archived.json), the paper-archive records (life-physical.json)
// and the created-ledger (life-tree-created.json). A store left on the old
// path would silently point into nothing.
//
// Never overwrites: if the target already exists, that person is refused
// and named in the message; nothing else is guessed.
import { existsSync, mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lifeName, lifeRoot, personRel, type LifeConfig } from './life-tree.js'
import { moveMountsPrefix } from './life-mounts.js'
import { moveDisplayLabels } from './life-labels.js'
import { moveArchivedPrefix } from './life-archived.js'
import { movePhysical } from './life-documents.js'
import { moveLifeLedgerPrefix } from './life-tree-ledger.js'
import { APP_LANG } from './config.js'
import { logger } from './logger.js'

export interface GroupMove {
  from: string
  to: string
  /** The target already exists: this one would be refused. */
  conflict: boolean
}

export interface GroupMovePlan {
  /** null: no depot root, so nothing can be measured (NOT "nothing to move"). */
  root: string | null
  moves: GroupMove[]
}

function isDir(abs: string): boolean {
  try { return statSync(abs).isDirectory() } catch { return false }
}

/**
 * What would move if the persons' group changed from `oldCfg` to `newCfg`.
 * Only folders that EXIST at the old place are listed; the person's own
 * folder and its archive folder (`Archív/...`) both follow.
 */
export function planPersonsGroupMove(oldCfg: LifeConfig, newCfg: LifeConfig, lang: string = APP_LANG): GroupMovePlan {
  const root = lifeRoot()
  if (!root) return { root: null, moves: [] }
  if ((oldCfg.personsGroup || '') === (newCfg.personsGroup || '')) return { root, moves: [] }
  const archive = lifeName('archive', lang)
  const moves: GroupMove[] = []
  const abs = (rel: string) => join(root, ...rel.split('/'))
  for (const p of newCfg.persons) {
    for (const prefix of ['', `${archive}/`]) {
      const from = prefix + personRel(oldCfg, p.name)
      const to = prefix + personRel(newCfg, p.name)
      if (from === to || !isDir(abs(from))) continue
      moves.push({ from, to, conflict: existsSync(abs(to)) })
    }
  }
  return { root, moves }
}

export interface GroupMoveResult {
  ok: boolean
  moved: GroupMove[]
  failed: Array<GroupMove & { error: string }>
  /** A failure happened, and the moves already done were put back. */
  rolledBack: boolean
}

/** Ancestors of `abs` (up to `root`) that do not exist yet, deepest first. */
function missingParents(root: string, abs: string): string[] {
  const out: string[] = []
  let cur = dirname(abs)
  while (cur.length > root.length && !existsSync(cur)) {
    out.push(cur)
    cur = dirname(cur)
  }
  return out
}

function moveOne(root: string, from: string, to: string, created: string[]): string | null {
  const fromAbs = join(root, ...from.split('/'))
  const toAbs = join(root, ...to.split('/'))
  if (existsSync(toAbs)) return 'exists'
  const parents = missingParents(root, toAbs)
  try {
    mkdirSync(dirname(toAbs), { recursive: true })
    created.push(...parents)
    renameSync(fromAbs, toAbs)
  } catch (err: any) {
    return String(err?.code || err?.message || err)
  }
  moveMountsPrefix(from, to)
  moveDisplayLabels(from, to)
  moveArchivedPrefix(from, to)
  movePhysical(from, to)
  moveLifeLedgerPrefix(root, from, to)
  return null
}

/**
 * The folders the move created for its targets (e.g. an empty "Család") must
 * not stay behind when it failed. Only EMPTY ones go: rmdir refuses anything
 * with content, so a folder the user put something into is never touched.
 */
function removeCreatedIfEmpty(created: string[]): void {
  const uniq = [...new Set(created)].sort((a, b) => b.length - a.length)
  for (const dir of uniq) {
    try { rmdirSync(dir) } catch { /* not empty or already gone: leave it */ }
  }
}

/** The OS refused because something holds the folder open (Windows lock). */
export function isLockError(code: string): boolean {
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

/**
 * Carry out a plan made by `planPersonsGroupMove`. ALL OR NOTHING: a half-moved
 * family (some persons under "Család", some at the root) with a config that
 * says either is worse than the old state, so on the first failure the moves
 * already done are put back, and the caller must not save the new config.
 * Never overwrites an existing target.
 */
export function applyPersonsGroupMove(plan: GroupMovePlan): GroupMoveResult {
  const out: GroupMoveResult = { ok: true, moved: [], failed: [], rolledBack: false }
  const root = plan.root
  if (!root) return { ok: false, moved: [], failed: plan.moves.map((m) => ({ ...m, error: 'no_root' })), rolledBack: false }
  const created: string[] = []
  for (const m of plan.moves) {
    const err = moveOne(root, m.from, m.to, created)
    if (err) {
      out.failed.push({ ...m, conflict: err === 'exists', error: err })
      break
    }
    out.moved.push(m)
    logger.info({ from: m.from, to: m.to }, '[eletfa] szemely-mappa atkoltoztetve')
  }
  if (out.failed.length) {
    out.ok = false
    for (const m of [...out.moved].reverse()) {
      const back = moveOne(root, m.to, m.from, [])
      if (back) logger.error({ from: m.to, to: m.from, err: back }, '[eletfa] visszakoltoztetes sikertelen')
    }
    out.rolledBack = out.moved.length > 0
    out.moved = []
    removeCreatedIfEmpty(created)
  }
  return out
}
