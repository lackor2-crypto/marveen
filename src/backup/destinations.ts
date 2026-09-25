/**
 * Where a full backup goes (#396, plan Phase 2) -- the 3-2-1 rule:
 *   local  store/backups/, always on
 *   depot  <depot>/Rendszer/Marveen/Mentések (another physical disk), on by
 *          default when a depot is configured
 *   cloud  one off-site copy: a Google Drive folder or a MEGA account, through
 *          the uploaders the app already has (drive-sync / rclone)
 *
 * The depot's own Drive backup does NOT carry these files off-site: it skips
 * `Rendszer/` on purpose (mentesKihagyUt), so the cloud copy is its own step.
 *
 * "Unreachable" is not "failed" (§9): an unplugged F: drive or an expired
 * token is reported as reachable:false with a reason, and nothing is concluded
 * from its (non-)listing -- in particular, nothing is pruned.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { BACKUP_NAME_RE } from './create.js'

export type DestinationId = 'local' | 'depot' | 'cloud'
export type CloudKind = 'gdrive' | 'mega'

export interface BackupConfig {
  depot: { enabled: boolean | null }
  cloud: { kind: CloudKind | null; account: string | null; folderName: string | null }
  schedule: { enabled: boolean; time: string }
  includeLogs: boolean
}

export const DEFAULT_SCHEDULE_TIME = '03:30'

export function defaultConfig(): BackupConfig {
  return {
    depot: { enabled: null },
    cloud: { kind: null, account: null, folderName: null },
    schedule: { enabled: true, time: DEFAULT_SCHEDULE_TIME },
    includeLogs: false,
  }
}

export function configPath(storeDir: string): string {
  return join(storeDir, 'backup-config.json')
}

export function readConfig(storeDir: string): BackupConfig {
  const d = defaultConfig()
  let raw: any = {}
  try { raw = JSON.parse(readFileSync(configPath(storeDir), 'utf8')) } catch { return d }
  const time = typeof raw?.schedule?.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.schedule.time) ? raw.schedule.time : d.schedule.time
  const kind = raw?.cloud?.kind === 'gdrive' || raw?.cloud?.kind === 'mega' ? raw.cloud.kind : null
  return {
    depot: { enabled: typeof raw?.depot?.enabled === 'boolean' ? raw.depot.enabled : null },
    cloud: {
      kind,
      account: kind && typeof raw?.cloud?.account === 'string' && raw.cloud.account ? raw.cloud.account : null,
      folderName: typeof raw?.cloud?.folderName === 'string' && raw.cloud.folderName.trim() ? raw.cloud.folderName.trim().slice(0, 100) : null,
    },
    schedule: { enabled: raw?.schedule?.enabled !== false, time },
    includeLogs: raw?.includeLogs === true,
  }
}

export function writeConfig(storeDir: string, cfg: BackupConfig): void {
  mkdirSync(storeDir, { recursive: true })
  atomicWriteFileSync(configPath(storeDir), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Dependencies (real ones by default, fakes in tests)
// ---------------------------------------------------------------------------

export interface RemoteFile { name: string; size: number; ref: string }

export interface CloudApi {
  list(account: string, folderName: string): Promise<RemoteFile[]>
  upload(account: string, folderName: string, name: string, file: string): Promise<void>
  remove(account: string, folderName: string, ref: string): Promise<void>
  download?(account: string, folderName: string, ref: string, dest: string): Promise<void>
}

export interface DestinationDeps {
  storeDir: string
  /** Absolute depot backup folder, or null when no depot is configured. */
  depotBackupDir: () => string | null
  /** Just the depot root (reachability probe). */
  depotRoot: () => string | null
  gdrive?: CloudApi
  mega?: CloudApi
  lang?: 'hu' | 'en'
}

export function defaultCloudFolder(lang: 'hu' | 'en' = 'hu'): string {
  return lang === 'en' ? 'Marveen backups' : 'Marveen mentések'
}

export interface Destination {
  id: DestinationId
  kind: 'local' | 'depot' | CloudKind
  enabled: boolean
  /** depot: resolved folder; local: store/backups; cloud: "<account> / <folder>". */
  where: string | null
  account?: string | null
  folderName?: string | null
  /** why it is off / not set up, when enabled=false */
  off?: 'not_configured' | 'disabled'
}

export function localDir(storeDir: string): string {
  return join(storeDir, 'backups')
}

export function resolveDestinations(cfg: BackupConfig, deps: DestinationDeps): Destination[] {
  const out: Destination[] = [{ id: 'local', kind: 'local', enabled: true, where: localDir(deps.storeDir) }]
  const depotDir = deps.depotBackupDir()
  if (!depotDir) out.push({ id: 'depot', kind: 'depot', enabled: false, where: null, off: 'not_configured' })
  else {
    const enabled = cfg.depot.enabled ?? true
    out.push({ id: 'depot', kind: 'depot', enabled, where: depotDir, ...(enabled ? {} : { off: 'disabled' as const }) })
  }
  if (cfg.cloud.kind && cfg.cloud.account) {
    const folderName = cfg.cloud.folderName ?? defaultCloudFolder(deps.lang)
    out.push({ id: 'cloud', kind: cfg.cloud.kind, enabled: true, where: `${cfg.cloud.account} / ${folderName}`, account: cfg.cloud.account, folderName })
  } else {
    out.push({ id: 'cloud', kind: 'gdrive', enabled: false, where: null, off: 'not_configured' })
  }
  return out
}

// ---------------------------------------------------------------------------
// List / put / remove
// ---------------------------------------------------------------------------

export type ListResult =
  | { ok: true; files: RemoteFile[] }
  | { ok: false; reachable: boolean; reason: string; detail?: string }

export interface ReplicaResult {
  dest: DestinationId
  ok: boolean
  reachable: boolean
  reason?: string
  detail?: string
}

function cloudApi(d: Destination, deps: DestinationDeps): CloudApi | null {
  return d.kind === 'gdrive' ? deps.gdrive ?? null : d.kind === 'mega' ? deps.mega ?? null : null
}

function depotReachable(deps: DestinationDeps): boolean {
  const root = deps.depotRoot()
  if (!root) return false
  try { readdirSync(root); return true } catch { return false }
}

function listDir(dir: string): RemoteFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => BACKUP_NAME_RE.test(n))
    .map((name) => ({ name, size: statSync(join(dir, name)).size, ref: join(dir, name) }))
}

/** Classify a cloud error: an auth problem is "unreachable", anything else a failure. */
export function cloudReason(err: unknown): { reachable: boolean; reason: string; detail: string } {
  const detail = String((err as any)?.message || err).slice(0, 300)
  if (/\b(401|403)\b|invalid_grant|unauthori[sz]ed|invalid authentication|login|token/i.test(detail)) {
    return { reachable: false, reason: 'cloud_auth', detail }
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(detail)) {
    return { reachable: false, reason: 'cloud_offline', detail }
  }
  return { reachable: true, reason: 'cloud_failed', detail }
}

export async function listDestination(d: Destination, deps: DestinationDeps): Promise<ListResult> {
  if (!d.enabled) return { ok: false, reachable: false, reason: d.off === 'disabled' ? 'disabled' : 'not_configured' }
  if (d.kind === 'local') {
    try { return { ok: true, files: listDir(d.where!) } } catch (e: any) { return { ok: false, reachable: true, reason: 'list_failed', detail: String(e?.message || e) } }
  }
  if (d.kind === 'depot') {
    if (!depotReachable(deps)) return { ok: false, reachable: false, reason: 'depot_unreachable' }
    try { return { ok: true, files: listDir(d.where!) } } catch (e: any) { return { ok: false, reachable: true, reason: 'list_failed', detail: String(e?.message || e) } }
  }
  const api = cloudApi(d, deps)
  if (!api) return { ok: false, reachable: false, reason: 'cloud_unavailable' }
  try {
    const files = (await api.list(d.account!, d.folderName!)).filter((f) => BACKUP_NAME_RE.test(f.name))
    return { ok: true, files }
  } catch (err) {
    const c = cloudReason(err)
    return { ok: false, ...c }
  }
}

async function putOne(d: Destination, file: string, name: string, deps: DestinationDeps): Promise<ReplicaResult> {
  if (d.kind === 'depot') {
    if (!depotReachable(deps)) return { dest: d.id, ok: false, reachable: false, reason: 'depot_unreachable' }
    const dir = d.where!
    const partial = join(dir, `${name}.partial`)
    try {
      mkdirSync(dir, { recursive: true })
      copyFileSync(file, partial)
      if (statSync(partial).size !== statSync(file).size) throw new Error('size mismatch after copy')
      renameSync(partial, join(dir, name))
      return { dest: d.id, ok: true, reachable: true }
    } catch (e: any) {
      rmSync(partial, { force: true })
      return { dest: d.id, ok: false, reachable: true, reason: 'copy_failed', detail: String(e?.message || e).slice(0, 300) }
    }
  }
  const api = cloudApi(d, deps)
  if (!api) return { dest: d.id, ok: false, reachable: false, reason: 'cloud_unavailable' }
  try {
    await api.upload(d.account!, d.folderName!, name, file)
    return { dest: d.id, ok: true, reachable: true }
  } catch (err) {
    return { dest: d.id, ok: false, ...cloudReason(err) }
  }
}

/** Copy a finished local backup to every enabled non-local destination. */
export async function replicate(file: string, name: string, cfg: BackupConfig, deps: DestinationDeps): Promise<ReplicaResult[]> {
  const out: ReplicaResult[] = [{ dest: 'local', ok: existsSync(file), reachable: true }]
  for (const d of resolveDestinations(cfg, deps)) {
    if (d.id === 'local' || !d.enabled) continue
    out.push(await putOne(d, file, name, deps))
  }
  return out
}

export async function removeFromDestination(d: Destination, f: RemoteFile, deps: DestinationDeps): Promise<void> {
  if (d.kind === 'local' || d.kind === 'depot') { rmSync(f.ref, { force: true }); return }
  const api = cloudApi(d, deps)
  if (!api) throw new Error('cloud_unavailable')
  await api.remove(d.account!, d.folderName!, f.ref)
}

// ---------------------------------------------------------------------------
// Real cloud adapters (lazy: drive-sync and mega pull in a lot)
// ---------------------------------------------------------------------------

export function realGdrive(): CloudApi {
  const folderIds = new Map<string, string>()
  const lib = async () => (await import('../web/routes/drive-sync.js')).backupDriveApi
  const folder = async (account: string, name: string) => {
    const k = `${account}\u0000${name}`
    if (folderIds.has(k)) return folderIds.get(k)!
    const api = await lib()
    const id = await api.ensureFolder(name, 'root', api.token(account))
    folderIds.set(k, id)
    return id
  }
  return {
    async list(account, name) {
      const api = await lib()
      const id = await folder(account, name)
      const files = await api.listFolder(id, api.token(account))
      return files.filter((f: any) => f.mimeType !== 'application/vnd.google-apps.folder')
        .map((f: any) => ({ name: String(f.name), size: Number(f.size || 0), ref: String(f.id) }))
    },
    async upload(account, name, fileName, file) {
      const api = await lib()
      await api.uploadNewFile(fileName, await folder(account, name), file, api.token(account))
    },
    async remove(account, _name, ref) {
      const api = await lib()
      await api.trashFile(ref, api.token(account))
    },
    async download(account, _name, ref, dest) {
      const api = await lib()
      await api.downloadFile(ref, dest, api.token(account))
    },
  }
}

export function realMega(): CloudApi {
  const rc = async () => {
    const mega = await import('../mega.js')
    const mb = await import('../mega-backup.js')
    const bin = mega.rcloneBin()
    if (!bin) throw new Error('rclone is not installed')
    return { mega, mb, bin }
  }
  const remoteOf = async (account: string) => {
    const { mega } = await rc()
    const a = mega.readMegaAccounts().find((x) => x.name === account || x.email === account)
    if (!a) throw new Error(`MEGA account not connected (login): ${account}`)
    return a.remote
  }
  const dirOf = (remote: string, folder: string) => `${remote}:${folder}`
  return {
    async list(account, folder) {
      const { mega, mb, bin } = await rc()
      const r = await mb.longRunner(bin, ['lsjson', '--files-only', '--no-mimetype', '--config', mega.rcloneConfigPath(), dirOf(await remoteOf(account), folder)])
      if (r.code !== 0) {
        if (/directory not found/i.test(r.stderr)) return []
        throw new Error(r.stderr.trim().slice(-300) || `rclone exit ${r.code}`)
      }
      const arr = JSON.parse(r.stdout || '[]')
      return (Array.isArray(arr) ? arr : []).map((x: any) => ({ name: String(x.Name || x.Path), size: Number(x.Size || 0), ref: String(x.Path) }))
    },
    async upload(account, folder, name, file) {
      const { mega, mb, bin } = await rc()
      const r = await mb.longRunner(bin, ['copyto', file, `${dirOf(await remoteOf(account), folder)}/${name}`, '--config', mega.rcloneConfigPath()])
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(-300) || `rclone exit ${r.code}`)
    },
    async remove(account, folder, ref) {
      const { mega, mb, bin } = await rc()
      const r = await mb.longRunner(bin, ['deletefile', `${dirOf(await remoteOf(account), folder)}/${ref}`, '--config', mega.rcloneConfigPath()])
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(-300) || `rclone exit ${r.code}`)
    },
    async download(account, folder, ref, dest) {
      const { mega, mb, bin } = await rc()
      const r = await mb.longRunner(bin, ['copyto', `${dirOf(await remoteOf(account), folder)}/${ref}`, dest, '--config', mega.rcloneConfigPath()])
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(-300) || `rclone exit ${r.code}`)
    },
  }
}

export async function realDeps(storeDir: string): Promise<DestinationDeps> {
  const depot = await import('../depot.js')
  const { APP_LANG } = await import('../config.js')
  return {
    storeDir,
    depotRoot: () => depot.depotRoot(),
    depotBackupDir: () => {
      const root = depot.depotRoot()
      return root ? join(root, depot.DEPOT_BACKUPS) : null
    },
    gdrive: realGdrive(),
    mega: realMega(),
    lang: APP_LANG === 'en' ? 'en' : 'hu',
  }
}
