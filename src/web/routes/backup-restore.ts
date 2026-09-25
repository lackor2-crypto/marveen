// Restore from a backup (kanban #396, docs/BACKUP-RESTORE-PLAN.md Phase 5).
//
//   POST /api/backup/restore/upload          -- the .mbk as the raw body -> { uploadId }
//   POST /api/backup/restore/open            -- { source: local|depot|cloud|upload, name?, uploadId?, key? }
//                                               -> the preview (nothing is changed yet)
//   POST /api/backup/restore/start           -- { previewId, exclude[] } -> pre-restore backup,
//                                               then the detached runner restarts the dashboard
//   GET  /api/backup/restore/status          -- read from files, so it survives the restart
//   POST /api/backup/restore/release         -- "the old machine is off": held channels +
//                                               paused schedules come back
//   POST /api/backup/restore/cancel          -- drop a preview
//   GET  /api/backup/onboarding              -- ask "do you have a backup?" on a fresh install?
//   POST /api/backup/onboarding              -- { choice: restore|fresh }, asked once
//
// Every error is { error, message } with the message in the request language.
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { json, readBody } from '../http-helpers.js'
import { APP_LANG, PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { countDashboardUsers, getDb } from '../../db.js'
import { restartAvailability } from '../../self-restart.js'
import type { RouteContext } from './types.js'
import { readHeader, BackupDecryptError } from '../../backup/crypto.js'
import { runBackup, listBackupsIn, localBackupDir } from '../../backup/service.js'
import { readConfig, resolveDestinations, listDestination, realDeps } from '../../backup/destinations.js'
import { openPreview, startRestore, dropPreview, restoreStatus, launchRunner, RestoreError } from '../../backup/restore-service.js'
import { releaseHeld, OPTIONAL_CATEGORIES } from '../../backup/restore.js'
import { InspectError, type Inspection } from '../../backup/inspect.js'
import type { BackupCategory } from '../../backup/inventory.js'

type Lang = 'hu' | 'en'
const UPLOAD_MAX = 8 * 1024 * 1024 * 1024

function uiLang(ctx: RouteContext): Lang {
  const v = ctx.url.searchParams.get('lang') || String(ctx.req.headers?.['x-ui-lang'] || '')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const M: Record<string, { hu: string; en: string }> = {
  key_needed: { hu: 'Ehhez a mentéshez add meg a helyreállító kulcsot (a vészhelyzeti lapon áll, kulcs-azonosító: {keyId}).', en: 'Enter the recovery key for this backup (it is on the emergency kit, key id: {keyId}).' },
  wrong_key: { hu: 'Ez a kulcs nem ehhez a mentéshez tartozik. Nézd meg a vészhelyzeti lapot: a kulcs-azonosítónak egyeznie kell.', en: 'This key does not belong to this backup. Check the emergency kit: the key id must match.' },
  corrupt: { hu: 'A mentésfájl sérült, ebből nem lehet visszaállni. Próbálj egy másik mentést (a Raktárból vagy a felhőből).', en: 'The backup file is damaged and cannot be restored. Try another backup (from the depot or the cloud).' },
  truncated: { hu: 'A mentésfájl csonka (nem töltődött le vagy fel teljesen). Töltsd le/fel újra.', en: 'The backup file is cut short (it did not download or upload completely). Get it again.' },
  not_a_backup: { hu: 'Ez nem Marveen mentésfájl (.mbk).', en: 'This is not a Marveen backup file (.mbk).' },
  format_unknown: { hu: 'Ezt a mentést egy újabb Marveen készítette. Előbb frissítsd a Marveent (Beállítások → Frissítés), utána töltsd be a mentést.', en: 'A newer Marveen made this backup. Update Marveen first (Settings → Update), then load the backup.' },
  backup_newer: { hu: 'Ezt a mentést egy újabb Marveen készítette. Előbb frissítsd a Marveent (Beállítások → Frissítés), utána töltsd be a mentést.', en: 'A newer Marveen made this backup. Update Marveen first (Settings → Update), then load the backup.' },
  hash_mismatch: { hu: 'A mentésben lévő fájlok nem egyeznek a saját leírásukkal -- ebből nem állok vissza.', en: 'The files in the backup do not match their own record -- I will not restore from it.' },
  db_integrity: { hu: 'A mentésben lévő adatbázis sérült -- ebből nem állok vissza.', en: 'The database inside the backup is damaged -- I will not restore from it.' },
  preview_expired: { hu: 'Az előnézet lejárt (egy óra után). Nyisd meg újra a mentést.', en: 'The preview expired (after an hour). Open the backup again.' },
  restore_running: { hu: 'Már fut egy visszaállítás.', en: 'A restore is already running.' },
  busy: { hu: 'Most fut egy mentés. Várd meg, utána indítsd a visszaállítást.', en: 'A backup is running now. Wait for it, then start the restore.' },
  cannot_restart: { hu: 'Ez a telepítés nem tudja magát újraindítani, ezért innen nem tudok visszaállítani. {reason}', en: 'This install cannot restart itself, so the restore cannot run from here. {reason}' },
  pre_backup_failed: { hu: 'A mostani állapotot nem sikerült előbb elmenteni, ezért nem kezdtem bele a visszaállításba: {detail}', en: 'Saving the current state first failed, so the restore did not start: {detail}' },
  disk_space: { hu: 'Nincs elég szabad hely a visszaállításhoz (kell kb. {need} bájt, van {free}).', en: 'There is not enough free space for the restore (needs about {need} bytes, has {free}).' },
  upload_too_big: { hu: 'A feltöltött fájl túl nagy.', en: 'The uploaded file is too big.' },
  not_found: { hu: 'Ez a mentés nem található (lehet, hogy közben törlődött).', en: 'This backup cannot be found (it may have been removed meanwhile).' },
  unreachable: { hu: 'Ez a hely most nem elérhető: {detail}', en: 'This place is not reachable right now: {detail}' },
  bad_request: { hu: 'Hibás kérés.', en: 'Bad request.' },
  failed: { hu: 'Nem sikerült: {detail}', en: 'It failed: {detail}' },
}

function fail(ctx: RouteContext, status: number, code: string, vars: Record<string, string> = {}): true {
  const m = (M[code] ?? M.failed)[uiLang(ctx)].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  json(ctx.res, { error: code, message: m }, status)
  return true
}

async function body(ctx: RouteContext): Promise<any> {
  try { return JSON.parse((await readBody(ctx.req)).toString() || '{}') } catch { return null }
}

function tmpDir(): string {
  const d = join(STORE_DIR, 'tmp')
  mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

const uploads = new Map<string, string>()
export function _resetRestoreRoutesForTest(): void { uploads.clear() }

async function upload(ctx: RouteContext): Promise<boolean> {
  const id = randomBytes(8).toString('hex')
  const file = join(tmpDir(), `upload-${id}.mbk`)
  let total = 0
  let tooBig = false
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file, { mode: 0o600 })
    ctx.req.on('data', (c: Buffer) => {
      total += c.length
      if (total > UPLOAD_MAX) { tooBig = true; ctx.req.destroy(); out.destroy(); resolve() }
    })
    ctx.req.pipe(out)
    out.on('finish', () => resolve())
    out.on('error', reject)
    ctx.req.on('error', () => resolve())
  })
  if (tooBig) { rmSync(file, { force: true }); return fail(ctx, 413, 'upload_too_big') }
  try { readHeader(file) } catch (e) {
    rmSync(file, { force: true })
    return fail(ctx, 400, e instanceof BackupDecryptError ? e.code : 'not_a_backup')
  }
  uploads.set(id, file)
  json(ctx.res, { uploadId: id, size: total })
  return true
}

function previewPayload(id: string, ins: Inspection) {
  return {
    previewId: id,
    createdAt: ins.manifest.createdAt,
    appVersion: ins.manifest.appVersion,
    compat: ins.compat,
    categories: ins.categories,
    optional: OPTIONAL_CATEGORIES,
    dbCounts: ins.dbCounts,
    warnings: ins.warnings,
    needsLogin: ins.needsLogin,
    freshInstall: ins.freshInstall,
    bytes: ins.bytes,
    pathMoved: ins.pathRewrites.length > 0,
    agents: ins.manifest.agents,
    keyId: ins.header.keyId,
  }
}

async function open(ctx: RouteContext): Promise<boolean> {
  const b = await body(ctx)
  if (!b || typeof b.source !== 'string') return fail(ctx, 400, 'bad_request')
  let file = ''
  let uploaded = false
  if (b.source === 'upload') {
    file = uploads.get(String(b.uploadId || '')) ?? ''
    if (!file || !existsSync(file)) return fail(ctx, 404, 'not_found')
    uploads.delete(String(b.uploadId))
    uploaded = true
  } else if (b.source === 'local') {
    file = listBackupsIn(localBackupDir(STORE_DIR)).find((x) => x.name === b.name)?.file ?? ''
    if (!file) return fail(ctx, 404, 'not_found')
  } else if (b.source === 'depot' || b.source === 'cloud') {
    const deps = await realDeps(STORE_DIR)
    const d = resolveDestinations(readConfig(STORE_DIR), deps).find((x) => x.id === b.source)
    if (!d || !d.enabled) return fail(ctx, 404, 'not_found')
    const l = await listDestination(d, deps)
    if (!l.ok) return fail(ctx, 503, 'unreachable', { detail: l.reason })
    const f = l.files.find((x) => x.name === b.name)
    if (!f) return fail(ctx, 404, 'not_found')
    if (b.source === 'depot') file = f.ref
    else {
      const api = d.kind === 'mega' ? deps.mega : deps.gdrive
      if (!api?.download) return fail(ctx, 503, 'unreachable', { detail: d.kind })
      file = join(tmpDir(), `download-${randomBytes(6).toString('hex')}.mbk`)
      try { await api.download(d.account!, d.folderName!, f.ref, file) } catch (e: any) {
        rmSync(file, { force: true })
        return fail(ctx, 503, 'unreachable', { detail: String(e?.message || e).slice(0, 200) })
      }
      uploaded = true
    }
  } else return fail(ctx, 400, 'bad_request')

  let appVersion = '0.0.0'
  try { appVersion = String(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version) } catch { /* keep */ }
  let currentDb: any = null
  try { currentDb = getDb() } catch { currentDb = join(STORE_DIR, 'claudeclaw.db') }
  try {
    const { id, inspection } = await openPreview({ file, uploaded, key: typeof b.key === 'string' ? b.key : null, ctx: { projectRoot: PROJECT_ROOT, storeDir: STORE_DIR, home: homedir() }, appVersion, currentDb })
    json(ctx.res, previewPayload(id, inspection))
  } catch (e: any) {
    if (e instanceof RestoreError && e.code === 'key_needed') {
      // The file stays for the second try, with the key typed in.
      let uploadId: string | undefined
      if (uploaded) { uploadId = randomBytes(8).toString('hex'); uploads.set(uploadId, file) }
      json(ctx.res, { error: e.code, message: M.key_needed[uiLang(ctx)].replace('{keyId}', e.vars.keyId ?? ''), keyId: e.vars.keyId, ...(uploadId ? { uploadId } : {}) }, 400)
      return true
    }
    if (uploaded) rmSync(file, { force: true })
    if (e instanceof RestoreError) return fail(ctx, 400, e.code, e.vars)
    if (e instanceof BackupDecryptError || e instanceof InspectError) return fail(ctx, 400, e.code)
    return fail(ctx, 500, 'failed', { detail: String(e?.message || e).slice(0, 200) })
  }
  return true
}

async function start(ctx: RouteContext): Promise<boolean> {
  const b = await body(ctx)
  if (!b || typeof b.previewId !== 'string') return fail(ctx, 400, 'bad_request')
  const exclude = (Array.isArray(b.exclude) ? b.exclude : []).filter((c: unknown) => OPTIONAL_CATEGORIES.includes(c as BackupCategory)) as BackupCategory[]
  const avail = restartAvailability()
  let db: any = null
  try { db = getDb() } catch { db = null }
  try {
    const r = await startRestore(b.previewId, exclude, {
      ctx: { projectRoot: PROJECT_ROOT, storeDir: STORE_DIR, home: homedir() },
      unit: avail.possible ? avail.unit : null,
      unitReason: avail.reason,
      preBackup: async () => runBackup({ kind: 'pre-restore', db }),
      launch: (planFile) => launchRunner(PROJECT_ROOT, planFile),
    })
    json(ctx.res, { ok: true, ...r }, 202)
  } catch (e: any) {
    if (e instanceof RestoreError) return fail(ctx, 409, e.code, e.vars)
    return fail(ctx, 500, 'failed', { detail: String(e?.message || e).slice(0, 200) })
  }
  return true
}

function onboardingFile(): string { return join(STORE_DIR, 'onboarding-choice.json') }

/** Server-side fresh-install test: no dashboard login, no cards, no memories, not asked yet. */
export function shouldAskForBackup(): boolean {
  if (existsSync(onboardingFile())) return false
  try {
    if (countDashboardUsers(true) !== 0) return false
    const db = getDb()
    const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    return n('kanban_cards') === 0 && n('memories') === 0
  } catch { return false }
}

export async function tryHandleBackupRestore(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx
  if (path === '/api/backup/onboarding' && method === 'GET') { json(ctx.res, { ask: shouldAskForBackup() }); return true }
  if (path === '/api/backup/onboarding' && method === 'POST') {
    const b = await body(ctx)
    if (!b || (b.choice !== 'restore' && b.choice !== 'fresh')) return fail(ctx, 400, 'bad_request')
    writeFileSync(onboardingFile(), JSON.stringify({ choice: b.choice, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
    json(ctx.res, { ok: true })
    return true
  }
  if (!path.startsWith('/api/backup/restore/')) return false
  if (path === '/api/backup/restore/upload' && method === 'POST') return upload(ctx)
  if (path === '/api/backup/restore/open' && method === 'POST') return open(ctx)
  if (path === '/api/backup/restore/start' && method === 'POST') return start(ctx)
  if (path === '/api/backup/restore/status' && method === 'GET') { json(ctx.res, restoreStatus(STORE_DIR)); return true }
  if (path === '/api/backup/restore/cancel' && method === 'POST') {
    const b = await body(ctx)
    if (b && typeof b.previewId === 'string') dropPreview(b.previewId)
    json(ctx.res, { ok: true })
    return true
  }
  if (path === '/api/backup/restore/release' && method === 'POST') {
    const r = releaseHeld(STORE_DIR, (ids) => {
      const db = getDb()
      const up = db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ? AND status = 'paused'")
      let n = 0
      for (const id of ids) n += up.run(id).changes
      return n
    })
    json(ctx.res, { ok: true, ...r })
    return true
  }
  return false
}
