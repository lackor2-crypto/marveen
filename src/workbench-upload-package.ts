/**
 * ONLINE-UPLOAD PACKAGE (Boss, 2026-11-08, kanban #876): an online form (e.g. DRV S8003) takes files through the browser's
 * file chooser, which cannot follow the Workbench's links -- the annexes sit all over the Life tree. So one button gathers
 * the final letter and every annex into ONE temporary folder under the Downloads folder (copies, clean names in the
 * document's own language), and the folder disappears when the owner marks the letter "uploaded online" (or after a week).
 *
 * Safety: a folder is only ever deleted when it carries this module's marker file for the same work item.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { isWsl } from './web/scheduled-tasks-io.js'
import { listAnnexes } from './workbench-docannex.js'
import { resolverFor } from './workbench-docfinal.js'
import { collectAttachments } from './workbench-maildraft.js'
import { onSentEvent } from './workbench-docsent.js'
import { toWindowsPath } from './open-in-file-manager.js'
import type { WorkItemRow } from './workbench.js'

export const PACKAGE_MARKER = '.marveen-upload-package'
export const PACKAGE_MAX_AGE_DAYS = 7

export interface UploadPackageFile { name: string; bytes: number }
export interface UploadPackageView { item_id: string; dir: string; win_dir: string | null; created_at: number; files: UploadPackageFile[]; exists: boolean }
type Row = { item_id: string; dir: string; created_at: number }

let tableDb: unknown = null
function ensureTable(): void {
  const db = getDb()
  if (tableDb === db) return
  db.exec('CREATE TABLE IF NOT EXISTS wb_upload_package (item_id TEXT PRIMARY KEY, dir TEXT NOT NULL, created_at INTEGER NOT NULL)')
  tableDb = db
}

/** A file name Windows and Linux both accept, accents kept (a German "ä" is fine), at most `max` characters before the extension. */
export function safeName(raw: string, max = 90): string {
  const s = String(raw ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
  return (s.slice(0, max).replace(/[_.]+$/, '')) || 'Dokument'
}

/**
 * The clean names: the letter first ("00_..."), then every annex as "<label>_<title>.pdf" (K1_Abgabenbescheid_der_...).
 * The titles are in the document's own language, so a German letter gets German names without any translation here.
 */
export function packageNames(files: { name: string; kind: string }[], annexes: { label: string; title: string }[]): string[] {
  const used = new Set<string>()
  const unique = (n: string): string => {
    let out = n; let i = 2
    while (used.has(out.toLowerCase())) { out = n.replace(/(\.pdf)$/i, `_${i}$1`); i++ }
    used.add(out.toLowerCase()); return out
  }
  let annexIdx = 0
  return files.map((f) => {
    if (f.kind === 'annex') {
      const a = annexes[annexIdx++]
      return unique(a ? `${safeName(a.label, 12)}_${safeName(a.title)}.pdf` : safeName(f.name.replace(/\.pdf$/i, '')) + '.pdf')
    }
    const base = safeName(f.name.replace(/\.pdf$/i, '').replace(/^\d+[_-]/, ''))
    return unique(`00_${base}.pdf`)
  })
}

/** The Downloads folder of the person using this machine (the Windows one from WSL). */
export async function downloadsRoot(): Promise<string> {
  const env = process.env['MARVEEN_UPLOAD_PACKAGE_ROOT']
  if (env) return env
  if (isWsl()) {
    const profile = await new Promise<string>((resolve) => {
      execFile('cmd.exe', ['/c', 'echo %USERPROFILE%'], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '').replace(/\r|\n/g, '').trim()))
    })
    if (profile && !profile.includes('%')) {
      const unix = await new Promise<string>((resolve) => {
        execFile('wslpath', ['-u', profile], { timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '').trim()))
      })
      if (unix && existsSync(join(unix, 'Downloads'))) return join(unix, 'Downloads')
    }
  }
  const dl = join(homedir(), 'Downloads')
  return existsSync(dl) ? dl : homedir()
}

const stampOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function ownsMarker(dir: string, itemId: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(dir, PACKAGE_MARKER), 'utf8')) as { item_id?: string }
    return m.item_id === itemId
  } catch { return false }
}

function readRow(itemId: string): Row | undefined {
  ensureTable()
  return getDb().prepare('SELECT item_id, dir, created_at FROM wb_upload_package WHERE item_id = ?').get(itemId) as Row | undefined
}

/** Removes the item's package folder -- only when it carries our marker for this item. Returns true when a folder was removed. */
export function removeUploadPackage(itemId: string): boolean {
  const row = readRow(itemId)
  if (!row) return false
  getDb().prepare('DELETE FROM wb_upload_package WHERE item_id = ?').run(itemId)
  try {
    if (!existsSync(row.dir)) return false
    if (!ownsMarker(row.dir, itemId)) { logger.warn({ itemId, dir: row.dir }, '[upload-package] no marker: the folder is left alone'); return false }
    rmSync(row.dir, { recursive: true, force: true })
    return true
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message || err), itemId }, '[upload-package] removing the folder failed')
    return false
  }
}

/** The package of an item as it stands on disk (sync: the page's outline carries it); null when none was made. */
export function uploadPackageInfo(itemId: string): UploadPackageView | null {
  const row = readRow(itemId)
  if (!row) return null
  const exists = existsSync(row.dir)
  let files: UploadPackageFile[] = []
  if (exists) {
    try { files = readdirSync(row.dir).filter((n) => n !== PACKAGE_MARKER).sort().map((n) => ({ name: n, bytes: statSync(join(row.dir, n)).size })) } catch { /* listing is optional */ }
  }
  return { item_id: itemId, dir: row.dir, win_dir: null, created_at: row.created_at, files, exists }
}

export async function uploadPackageView(itemId: string): Promise<UploadPackageView | null> {
  const v = uploadPackageInfo(itemId)
  if (!v) return null
  return { ...v, win_dir: isWsl() ? await toWindowsPath(v.dir) : null }
}

export type PrepareOutcome = { ok: true; package: UploadPackageView } | { ok: false; code: string; detail: string | null; label?: string }

/** Gathers the final letter and the annexes as copies with clean names into a fresh folder under Downloads. */
export async function prepareUploadPackage(item: WorkItemRow, ui: 'hu' | 'en'): Promise<PrepareOutcome> {
  const got = await collectAttachments(item, ui)
  if (!got.ok) return { ok: false, code: got.code, detail: got.detail, label: got.label }
  if (!got.files.length) return { ok: false, code: 'nothing_to_package', detail: null }
  const annexes = listAnnexes(item.id, resolverFor(item)).map((a) => ({ label: a.label, title: a.title }))
  const names = packageNames(got.files, annexes)
  removeUploadPackage(item.id)
  const root = await downloadsRoot()
  const dir = join(root, `Upload_${stampOf(new Date())}_${safeName(item.title, 40)}_${item.id.slice(0, 6)}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, PACKAGE_MARKER), JSON.stringify({ item_id: item.id, created_at: Date.now(), by: 'marveen' }))
    got.files.forEach((f, i) => writeFileSync(join(dir, names[i]!), f.data))
  } catch (err) {
    try { if (ownsMarker(dir, item.id)) rmSync(dir, { recursive: true, force: true }) } catch { /* nothing more to do */ }
    return { ok: false, code: 'write_failed', detail: String((err as Error)?.message || err) }
  }
  ensureTable()
  getDb().prepare('INSERT OR REPLACE INTO wb_upload_package (item_id, dir, created_at) VALUES (?, ?, ?)').run(item.id, dir, Math.floor(Date.now() / 1000))
  const view = await uploadPackageView(item.id)
  return view ? { ok: true, package: view } : { ok: false, code: 'write_failed', detail: null }
}

/** Packages nobody cleaned up: removed after a week (the owner may have forgotten the upload button). */
export function sweepOldUploadPackages(nowMs = Date.now()): number {
  ensureTable()
  const rows = getDb().prepare('SELECT item_id, created_at FROM wb_upload_package').all() as { item_id: string; created_at: number }[]
  let n = 0
  for (const r of rows) if (nowMs / 1000 - r.created_at > PACKAGE_MAX_AGE_DAYS * 86400 && removeUploadPackage(r.item_id)) n++
  return n
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
export function startUploadPackageSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => { try { sweepOldUploadPackages() } catch { /* next round */ } }, 6 * 3600 * 1000)
  sweepTimer.unref?.()
  try { sweepOldUploadPackages() } catch { /* next round */ }
}

// "Uploaded online" (any sending mark) = done with the package: the folder goes in the same step.
onSentEvent((e) => { removeUploadPackage(e.itemId) })
