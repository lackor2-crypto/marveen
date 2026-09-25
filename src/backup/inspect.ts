/**
 * Open a backup for a restore and say what it would do (#396 Phase 4) -- the
 * preview is required before any change (fresh-install rule).
 *
 *   decrypt + untar into store/tmp/restore-stage-* (0700, kept for the restore)
 *   -> every sha256 checked -> the DB copy's integrity + counts
 *   -> compatibility with this Marveen -> old-machine paths rewritten in the
 *   staged copy -> per category: how many files are new, how many overwrite.
 *
 * The staged directory IS what the restore then moves into place, so what the
 * preview showed and what gets restored cannot differ.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { extractBackup, checkManifestHashes } from './extract.js'
import { describeDatabase, inspectDatabaseFile } from './db-snapshot.js'
import { checkCompat, type CompatResult } from './compat.js'
import { applyPathRewrites, payloadBytes, planPathRewrites, targetFor, type Rewrite, type RestoreCtx } from './path-rewrite.js'
import { categoryOf, isHeld, freeBytes } from './restore.js'
import type { BackupManifest } from './create.js'
import type { BackupCategory } from './inventory.js'
import type { BackupHeader } from './crypto.js'

export interface CategorySummary { id: BackupCategory; files: number; willOverwrite: number; willAdd: number; held: number }

export interface Inspection {
  stagingDir: string
  header: BackupHeader
  manifest: BackupManifest
  compat: CompatResult
  integrity: string
  categories: CategorySummary[]
  dbCounts: { backup: Record<string, number>; current: Record<string, number> | null }
  pathRewrites: Rewrite[]
  rewritten: string[]
  warnings: { code: string; items?: string[]; n?: number }[]
  /** Agents (and the main agent) that need a Claude login after the restore. */
  needsLogin: string[]
  freshInstall: boolean
  bytes: { payload: number; free: number | null; enough: boolean }
}

export class InspectError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export async function inspectBackup(o: {
  file: string
  recoveryKey: string
  ctx: RestoreCtx
  appVersion: string
  /** The running DB (dashboard handle) or its path; null on a fresh machine with none. */
  currentDb: Database.Database | string | null
}): Promise<Inspection> {
  const base = join(o.ctx.storeDir, 'tmp')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const stagingDir = mkdtempSync(join(base, 'restore-stage-'))
  try {
    const { header, manifest } = await extractBackup(o.file, o.recoveryKey, stagingDir)
    const h = checkManifestHashes(stagingDir, manifest)
    if (h.missing.length || h.mismatched.length) {
      throw new InspectError('hash_mismatch', `${h.missing.length} missing, ${h.mismatched.length} damaged file(s) in the backup`)
    }
    const dbLogical = manifest.categories.database?.[0]
    let integrity = 'none'
    let backupCounts: Record<string, number> = {}
    if (dbLogical) {
      const info = inspectDatabaseFile(join(stagingDir, dbLogical))
      integrity = info.integrity
      backupCounts = info.counts
      if (info.integrity !== 'ok') throw new InspectError('db_integrity', `database in the backup is damaged: ${info.integrity}`)
    }

    let currentCounts: Record<string, number> | null = null
    let currentFp: string | null = null
    if (o.currentDb) {
      try {
        if (typeof o.currentDb === 'string') {
          if (existsSync(o.currentDb)) { const i = inspectDatabaseFile(o.currentDb); currentCounts = i.counts; currentFp = i.schemaFingerprint }
        } else { const d = describeDatabase(o.currentDb); currentCounts = d.counts; currentFp = d.schemaFingerprint }
      } catch { currentCounts = null }
    }
    const compat = checkCompat(manifest, o.appVersion, currentFp)

    const pathRewrites = planPathRewrites(manifest.pathHints, o.ctx)
    const rw = applyPathRewrites(stagingDir, manifest, pathRewrites)

    const cats = new Map<BackupCategory, CategorySummary>()
    for (const f of [...manifest.files.map((x) => x.path), ...(manifest.links ?? []).map((l) => l.path)]) {
      if (f === 'manifest.json') continue
      const c = f === 'project/local-commits.bundle' ? 'git' : categoryOf(f, manifest.categories)
      if (c === 'reference' || c === 'logs') continue
      const s = cats.get(c) ?? { id: c, files: 0, willOverwrite: 0, willAdd: 0, held: 0 }
      s.files++
      const t = targetFor(f, manifest, o.ctx)
      if (isHeld(f, c)) s.held++
      else if (t && exists(t)) s.willOverwrite++
      else s.willAdd++
      cats.set(c, s)
    }

    const fresh = !currentCounts || ((currentCounts.kanban_cards ?? 0) === 0 && (currentCounts.memories ?? 0) === 0 && !existsAgents(o.ctx))
    const warnings: Inspection['warnings'] = []
    if (rw.stillOld.length) warnings.push({ code: 'old_paths', items: rw.stillOld })
    if (manifest.missing?.length) warnings.push({ code: 'backup_had_missing', n: manifest.missing.length })
    const payload = payloadBytes(manifest)
    const free = freeBytes(o.ctx.storeDir)
    const enough = free === null ? true : free >= payload * 3
    if (!enough) warnings.push({ code: 'disk_space' })
    return {
      stagingDir, header, manifest, compat, integrity,
      categories: [...cats.values()].sort((a, b) => a.id.localeCompare(b.id)),
      dbCounts: { backup: backupCounts, current: currentCounts },
      pathRewrites, rewritten: rw.rewritten, warnings,
      needsLogin: ['main', ...(manifest.agents ?? [])],
      freshInstall: fresh,
      bytes: { payload, free, enough },
    }
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw err
  }
}

function exists(p: string): boolean { try { lstatSync(p); return true } catch { return false } }

function existsAgents(ctx: RestoreCtx): boolean {
  try {
    const dir = join(ctx.projectRoot, 'agents')
    return existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith('.') && n !== 'heartbeat-worker')
  } catch { return false }
}
