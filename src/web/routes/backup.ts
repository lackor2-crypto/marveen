// Settings -> Backup (kanban #396, docs/BACKUP-RESTORE-PLAN.md Phase 3).
//
//   GET  /api/backup/status              -- state, destinations, key, schedule
//   POST /api/backup/run                 -- start a backup -> { jobId }
//   GET  /api/backup/jobs/:id            -- stage / result of a running backup
//   GET  /api/backup/list                -- backups per destination (+ verified)
//   GET  /api/backup/download/:name      -- the encrypted file (listed names only)
//   POST /api/backup/kit                 -- the recovery key(s): needs the
//                                           dashboard password when login is on
//   POST /api/backup/kit/confirm         -- "I saved it"
//   POST /api/backup/key/rotate          -- new generated key, or own password
//   PUT  /api/backup/config              -- destinations / time / logs
//   GET  /api/backup/cloud-accounts      -- connected Google + MEGA accounts
//
// Every error is { error: <code>, message: <human sentence in the request's
// language> } -- the UI shows `message`, never the code.
//
// The kit is a POST, not the plan's GET: the password travels in the body, and
// a GET with a password would end up in logs and history.
import { createReadStream, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { json, readBody } from '../http-helpers.js'
import { APP_LANG, STORE_DIR } from '../../config.js'
import { countDashboardUsers, getDashboardUser, getDb } from '../../db.js'
import { verifyPassword } from '../password-hash.js'
import type { RouteContext } from './types.js'
import { BACKUP_NAME_RE, type BackupStage } from '../../backup/create.js'
import { runBackup, listBackupsIn, localBackupDir } from '../../backup/service.js'
import { readState } from '../../backup/state.js'
import {
  readConfig, writeConfig, resolveDestinations, listDestination, realDeps, defaultCloudFolder,
  type BackupConfig,
} from '../../backup/destinations.js'
import { readKeyFile, getOrCreateKey, confirmKitSaved, rotateKey } from '../../backup/key-store.js'
import { timeFromName } from '../../backup/retention.js'
import { computeBackupHealth } from '../../backup/health.js'
import { dbLooksFresh } from '../system-health.js'

type Lang = 'hu' | 'en'

function uiLang(url: URL): Lang {
  const v = url.searchParams.get('lang')
  return v === 'en' || v === 'hu' ? v : (APP_LANG === 'en' ? 'en' : 'hu')
}

const MESSAGES: Record<string, { hu: string; en: string }> = {
  busy: {
    hu: 'Most is fut egy mentés vagy visszaállítás. Várd meg, amíg befejeződik.',
    en: 'A backup or restore is already running. Wait until it finishes.',
  },
  restore_in_progress: {
    hu: 'Visszaállítás folyamatban -- addig nem indul mentés.',
    en: 'A restore is in progress -- no backup starts until it ends.',
  },
  job_not_found: {
    hu: 'Ez a mentési folyamat már nem ismert (a dashboard közben újraindult). A lista mutatja, mi készült el.',
    en: 'This backup job is no longer known (the dashboard restarted meanwhile). The list shows what was made.',
  },
  not_found: {
    hu: 'Ilyen mentésfájl nincs ezen a gépen.',
    en: 'There is no such backup file on this machine.',
  },
  password_required: {
    hu: 'A kulcs megmutatásához add meg a dashboard jelszavadat.',
    en: 'Enter your dashboard password to show the key.',
  },
  password_wrong: {
    hu: 'Ez a jelszó nem jó. Próbáld újra.',
    en: 'That password is not right. Try again.',
  },
  kit_forbidden: {
    hu: 'A mentés kulcsát csak bejelentkezett ember nézheti meg a dashboardon, ágens vagy távoli gép nem.',
    en: 'Only a person logged in to the dashboard can see the backup key -- not an agent or a remote machine.',
  },
  no_key: {
    hu: 'Még nincs mentési kulcs. Az első mentés létrehozza.',
    en: 'There is no backup key yet. The first backup creates it.',
  },
  password_too_short: {
    hu: 'A saját jelszó legyen legalább 12 karakter -- ez nyitja a mentést egy új gépen.',
    en: 'Your own password must be at least 12 characters -- it opens the backup on a new machine.',
  },
  bad_config: {
    hu: 'A beállítás nem menthető: {detail}',
    en: 'The setting cannot be saved: {detail}',
  },
  bad_request: {
    hu: 'Hibás kérés.',
    en: 'Bad request.',
  },
  failed: {
    hu: 'A mentés nem sikerült: {detail}',
    en: 'The backup failed: {detail}',
  },
}

function msg(code: string, lang: Lang, vars: Record<string, string> = {}): string {
  const m = MESSAGES[code] ?? MESSAGES.bad_request
  return m[lang].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

function fail(ctx: RouteContext, status: number, code: string, vars: Record<string, string> = {}): true {
  json(ctx.res, { error: code, message: msg(code, uiLang(ctx.url), vars) }, status)
  return true
}

// ---------------------------------------------------------------------------
// Jobs (in memory: a backup is short, and after a restart the list tells)
// ---------------------------------------------------------------------------

interface Job {
  id: string
  kind: 'manual'
  startedAt: number
  stage: BackupStage | 'starting'
  done: boolean
  result?: Record<string, unknown>
}

const jobs = new Map<string, Job>()
let running: Job | null = null

export function _resetBackupJobsForTest(): void { jobs.clear(); running = null }

/** Test seam: replace the real run. */
let runImpl: typeof runBackup = runBackup
export function _setBackupRunForTest(fn: typeof runBackup | null): void { runImpl = fn ?? runBackup }

function startJob(): Job {
  const job: Job = { id: randomBytes(8).toString('hex'), kind: 'manual', startedAt: Date.now(), stage: 'starting', done: false }
  jobs.set(job.id, job)
  running = job
  for (const [id, j] of jobs) if (j.done && Date.now() - j.startedAt > 24 * 60 * 60 * 1000) jobs.delete(id)
  let db = null
  try { db = getDb() } catch { /* CLI-less test: the file path is used */ }
  runImpl({ kind: 'manual', db, onStage: (s) => { job.stage = s } })
    .then((r) => {
      job.result = {
        ok: r.ok, name: r.name, size: r.size, error: r.error, detail: r.detail,
        replicas: r.replicas, warnings: r.warnings, durationMs: r.durationMs,
      }
    })
    .catch((err) => { job.result = { ok: false, error: 'io_error', detail: String(err?.message || err).slice(0, 300) } })
    .finally(() => { job.done = true; job.stage = 'done'; if (running === job) running = null })
  return job
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function status(ctx: RouteContext): Promise<boolean> {
  const cfg = readConfig(STORE_DIR)
  const deps = await realDeps(STORE_DIR)
  const destinations = resolveDestinations(cfg, deps)
  let key: Record<string, unknown> = { exists: false }
  try {
    const kf = readKeyFile(STORE_DIR)
    if (kf) key = { exists: true, keyId: kf.current.keyId, createdAt: kf.current.createdAt, confirmedAt: kf.current.confirmedAt, custom: kf.current.custom === true, previous: kf.previous.length }
  } catch { key = { exists: true, damaged: true } }
  const state = readState(STORE_DIR)
  let loginOn = false
  try { loginOn = countDashboardUsers() > 0 } catch { loginOn = false }
  const local = (() => { try { return listBackupsIn(localBackupDir(STORE_DIR))[0] ?? null } catch { return null } })()
  const health = computeBackupHealth({ storeDir: STORE_DIR, destinations, newestLocalMs: local?.mtimeMs ?? null, freshInstall: dbLooksFresh() })
  json(ctx.res, {
    health,
    loginOn,
    state: {
      lastRun: state.lastRun ?? null,
      lastSuccessAt: state.lastSuccessAt ?? null,
      lastSuccessName: state.lastSuccessName ?? null,
      replicas: state.replicas ?? {},
      lastVerify: state.lastVerify ?? null,
    },
    config: cfg,
    destinations,
    defaultCloudFolder: defaultCloudFolder(uiLang(ctx.url)),
    key,
    running: running ? { jobId: running.id, stage: running.stage } : null,
  })
  return true
}

async function list(ctx: RouteContext): Promise<boolean> {
  const cfg = readConfig(STORE_DIR)
  const deps = await realDeps(STORE_DIR)
  const known = readState(STORE_DIR).backups ?? {}
  const rows = new Map<string, { name: string; size: number; time: number; where: string[]; kind: string | null; verified: boolean | null }>()
  const sources: Record<string, { ok: boolean; reachable?: boolean; reason?: string; count?: number }> = {}
  for (const d of resolveDestinations(cfg, deps)) {
    if (!d.enabled) { sources[d.id] = { ok: false, reachable: false, reason: d.off }; continue }
    const l = await listDestination(d, deps)
    if (!l.ok) { sources[d.id] = { ok: false, reachable: l.reachable, reason: l.reason }; continue }
    sources[d.id] = { ok: true, count: l.files.length }
    for (const f of l.files) {
      const r = rows.get(f.name) ?? { name: f.name, size: f.size, time: timeFromName(f.name), where: [], kind: known[f.name]?.kind ?? null, verified: known[f.name]?.verified ?? null }
      r.where.push(d.id)
      if (d.id === 'local') r.size = f.size
      rows.set(f.name, r)
    }
  }
  json(ctx.res, { backups: [...rows.values()].sort((a, b) => b.name.localeCompare(a.name)), sources })
  return true
}

function download(ctx: RouteContext, name: string): boolean {
  if (!BACKUP_NAME_RE.test(name)) return fail(ctx, 404, 'not_found')
  // Only names the directory listing returns: never a path built from input.
  const entry = listBackupsIn(localBackupDir(STORE_DIR)).find((b) => b.name === name)
  if (!entry) return fail(ctx, 404, 'not_found')
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(statSync(entry.file).size),
    'Content-Disposition': `attachment; filename="${entry.name}"`,
    'Cache-Control': 'no-store',
  })
  createReadStream(entry.file).pipe(ctx.res)
  return true
}

/** Who may read or change the recovery key. */
async function kitAuth(ctx: RouteContext, body: any): Promise<boolean | 'answered'> {
  const kind = ctx.auth?.kind
  if (kind && kind !== 'session' && kind !== 'token') { fail(ctx, 403, 'kit_forbidden'); return 'answered' }
  let loginOn = false
  try { loginOn = countDashboardUsers() > 0 } catch { loginOn = false }
  if (!loginOn) return true
  // With a login, the bearer token (which every agent holds) is not enough.
  if (kind !== 'session' || !ctx.auth?.user) { fail(ctx, 403, 'kit_forbidden'); return 'answered' }
  const pw = typeof body?.password === 'string' ? body.password : ''
  if (!pw) { fail(ctx, 401, 'password_required'); return 'answered' }
  const user = getDashboardUser(ctx.auth.user)
  if (!user || !(await verifyPassword(pw, user.password_hash))) { fail(ctx, 401, 'password_wrong'); return 'answered' }
  return true
}

async function readJson(ctx: RouteContext): Promise<any> {
  try { return JSON.parse((await readBody(ctx.req)).toString() || '{}') } catch { return null }
}

function applyConfigPatch(cur: BackupConfig, p: any): BackupConfig | string {
  const next: BackupConfig = JSON.parse(JSON.stringify(cur))
  if (p?.depot && 'enabled' in p.depot) {
    if (p.depot.enabled !== null && typeof p.depot.enabled !== 'boolean') return 'depot.enabled'
    next.depot.enabled = p.depot.enabled
  }
  if (p?.cloud) {
    const kind = p.cloud.kind
    if (kind !== null && kind !== 'gdrive' && kind !== 'mega') return 'cloud.kind'
    next.cloud.kind = kind
    next.cloud.account = kind ? (typeof p.cloud.account === 'string' && p.cloud.account.trim() ? p.cloud.account.trim().slice(0, 200) : null) : null
    if (kind && !next.cloud.account) return 'cloud.account'
    const fn = typeof p.cloud.folderName === 'string' ? p.cloud.folderName.trim() : ''
    if (fn && !/^[^/\\:*?"<>|]{1,100}$/.test(fn)) return 'cloud.folderName'
    next.cloud.folderName = fn || null
  }
  if (p?.schedule) {
    if ('time' in p.schedule) {
      if (typeof p.schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.schedule.time)) return 'schedule.time'
      next.schedule.time = p.schedule.time
    }
    if ('enabled' in p.schedule) next.schedule.enabled = p.schedule.enabled !== false
  }
  if ('includeLogs' in (p ?? {})) next.includeLogs = p.includeLogs === true
  return next
}

async function cloudAccounts(ctx: RouteContext): Promise<boolean> {
  const out: { kind: 'gdrive' | 'mega'; account: string; label: string }[] = []
  try {
    const { listGoogleAccounts } = await import('../google-auth-runner.js')
    for (const a of listGoogleAccounts()) out.push({ kind: 'gdrive', account: a.id, label: a.email || a.id })
  } catch { /* no Google connected */ }
  try {
    const { readMegaAccounts } = await import('../../mega.js')
    for (const a of readMegaAccounts()) out.push({ kind: 'mega', account: a.name, label: a.email })
  } catch { /* no MEGA connected */ }
  json(ctx.res, { accounts: out })
  return true
}

export async function tryHandleBackup(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx
  if (!path.startsWith('/api/backup/')) return false

  if (path === '/api/backup/status' && method === 'GET') return status(ctx)
  if (path === '/api/backup/list' && method === 'GET') return list(ctx)
  if (path === '/api/backup/cloud-accounts' && method === 'GET') return cloudAccounts(ctx)

  if (path === '/api/backup/run' && method === 'POST') {
    if (running) return fail(ctx, 409, 'busy')
    const job = startJob()
    json(ctx.res, { jobId: job.id }, 202)
    return true
  }

  const jm = path.match(/^\/api\/backup\/jobs\/([a-f0-9]{16})$/)
  if (jm && method === 'GET') {
    const job = jobs.get(jm[1])
    if (!job) return fail(ctx, 404, 'job_not_found')
    const r = job.result as any
    json(ctx.res, {
      jobId: job.id, stage: job.stage, done: job.done, startedAt: job.startedAt, result: job.result ?? null,
      ...(r && !r.ok ? { message: msg(r.error === 'locked' ? 'busy' : r.error === 'restore_in_progress' ? 'restore_in_progress' : 'failed', uiLang(ctx.url), { detail: String(r.detail || r.error || '') }) } : {}),
    })
    return true
  }

  const dm = path.match(/^\/api\/backup\/download\/([^/]+)$/)
  if (dm && method === 'GET') {
    let name = ''
    try { name = decodeURIComponent(dm[1]) } catch { return fail(ctx, 404, 'not_found') }
    return download(ctx, name)
  }

  if (path === '/api/backup/kit' && method === 'POST') {
    const body = await readJson(ctx)
    const ok = await kitAuth(ctx, body)
    if (ok === 'answered') return true
    const kf = readKeyFile(STORE_DIR) ?? { current: getOrCreateKey(STORE_DIR), previous: [] }
    json(ctx.res, {
      current: { key: kf.current.key, keyId: kf.current.keyId, createdAt: kf.current.createdAt, confirmedAt: kf.current.confirmedAt, custom: kf.current.custom === true },
      previous: kf.previous.map((k) => ({ key: k.key, keyId: k.keyId, createdAt: k.createdAt })),
    })
    return true
  }

  if (path === '/api/backup/kit/confirm' && method === 'POST') {
    try {
      const k = confirmKitSaved(STORE_DIR)
      json(ctx.res, { ok: true, confirmedAt: k.confirmedAt })
    } catch { return fail(ctx, 409, 'no_key') }
    return true
  }

  if (path === '/api/backup/key/rotate' && method === 'POST') {
    const body = await readJson(ctx)
    const ok = await kitAuth(ctx, body)
    if (ok === 'answered') return true
    try {
      const own = typeof body?.ownPassword === 'string' && body.ownPassword.length ? body.ownPassword : undefined
      const k = rotateKey(STORE_DIR, own)
      json(ctx.res, { ok: true, keyId: k.keyId, key: k.key, custom: k.custom === true })
    } catch (err: any) {
      if (String(err?.message) === 'password_too_short') return fail(ctx, 400, 'password_too_short')
      throw err
    }
    return true
  }

  if (path === '/api/backup/config' && method === 'PUT') {
    const body = await readJson(ctx)
    if (!body || typeof body !== 'object') return fail(ctx, 400, 'bad_request')
    const next = applyConfigPatch(readConfig(STORE_DIR), body)
    if (typeof next === 'string') return fail(ctx, 400, 'bad_config', { detail: next })
    writeConfig(STORE_DIR, next)
    json(ctx.res, { ok: true, config: next })
    return true
  }

  return false
}

export const _test = { applyConfigPatch }
