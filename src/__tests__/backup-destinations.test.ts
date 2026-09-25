/**
 * #396 Phase 2 -- destinations and the full run: the same file lands locally,
 * in the depot and in the cloud; an unplugged depot or an expired cloud login
 * is "unreachable" (not a crash, not a failure to hide); a failed listing
 * prunes nothing; the daily timer runs once per day.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  listDestination, readConfig, replicate, resolveDestinations, writeConfig, defaultConfig,
  type CloudApi, type DestinationDeps, type RemoteFile,
} from '../backup/destinations.js'
import { runFullBackup } from '../backup/pipeline.js'
import { readState } from '../backup/state.js'
import { backupHealthRow } from '../backup/health.js'
import { isDue, schedulerTick } from '../backup/scheduler.js'
import { backupFileName } from '../backup/create.js'
import { generateRecoveryKey } from '../backup/crypto.js'
import { populatedInstall } from './backup-fixture.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

function fakeCloud(opts: { failList?: Error; failUpload?: Error } = {}): CloudApi & { files: Map<string, RemoteFile>; removed: string[] } {
  const files = new Map<string, RemoteFile>()
  const removed: string[] = []
  return {
    files, removed,
    async list() { if (opts.failList) throw opts.failList; return [...files.values()] },
    async upload(_a, _f, name, file) { if (opts.failUpload) throw opts.failUpload; files.set(name, { name, size: readFileSync(file).length, ref: `id-${name}` }) },
    async remove(_a, _f, ref) { removed.push(ref); for (const [k, v] of files) if (v.ref === ref) files.delete(k) },
  }
}

function setup(label: string, cloud?: CloudApi, depotPresent = true) {
  const f = populatedInstall(label)
  roots.push(f.root)
  const depotRoot = join(f.root, 'depot')
  if (depotPresent) mkdirSync(depotRoot, { recursive: true })
  const deps: DestinationDeps = {
    storeDir: f.storeDir,
    depotRoot: () => depotRoot,
    depotBackupDir: () => join(depotRoot, 'Rendszer', 'Marveen', 'Mentések'),
    gdrive: cloud,
    lang: 'hu',
  }
  return { f, deps, depotRoot }
}

const key = generateRecoveryKey()
const run = (f: any, deps: DestinationDeps, extra: Record<string, unknown> = {}) =>
  runFullBackup({ kind: 'manual', ctx: f.ctx, recoveryKey: key, deps, encrypt: { kdfN: 1024 }, appCommit: 't', ...extra })

describe('destinations', () => {
  it('fresh config: depot on by default when configured, cloud off', () => {
    const { deps } = setup('cfg')
    const ds = resolveDestinations(readConfig(deps.storeDir), deps)
    expect(ds.map((d) => [d.id, d.enabled])).toEqual([['local', true], ['depot', true], ['cloud', false]])
    const noDepot = resolveDestinations(defaultConfig(), { ...deps, depotBackupDir: () => null, depotRoot: () => null })
    expect(noDepot[1]).toMatchObject({ id: 'depot', enabled: false, off: 'not_configured' })
  })

  it('a manual run writes the same file to local, depot and cloud', async () => {
    const cloud = fakeCloud()
    const { f, deps, depotRoot } = setup('three', cloud)
    writeConfig(f.storeDir, { ...defaultConfig(), cloud: { kind: 'gdrive', account: 'me@example.com', folderName: null } })
    const r = await run(f, deps)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.replicas?.map((x) => [x.dest, x.ok])).toEqual([['local', true], ['depot', true], ['cloud', true]])
    const local = readFileSync(r.file!)
    expect(readFileSync(join(depotRoot, 'Rendszer', 'Marveen', 'Mentések', r.name!)).equals(local)).toBe(true)
    expect(cloud.files.get(r.name!)?.size).toBe(local.length)
    const st = readState(f.storeDir)
    expect(st.lastSuccessName).toBe(r.name)
    expect(st.replicas?.depot?.ok).toBe(true)
    expect(st.backups?.[r.name!]?.kind).toBe('manual')
  })

  it('depot unplugged -> reachable:false with a reason, no exception, local still made', async () => {
    const { f, deps } = setup('unplugged', undefined, false)
    const r = await run(f, deps)
    expect(r.ok).toBe(true)
    expect(r.replicas?.find((x) => x.dest === 'depot')).toMatchObject({ ok: false, reachable: false, reason: 'depot_unreachable' })
    const d = resolveDestinations(readConfig(f.storeDir), deps).find((x) => x.id === 'depot')!
    expect(await listDestination(d, deps)).toMatchObject({ ok: false, reachable: false })
  })

  it('an expired cloud login is unreachable, not a crash', async () => {
    const cloud = fakeCloud({ failUpload: new Error('Drive 401: Request had invalid authentication credentials.') })
    const { f, deps } = setup('expired', cloud)
    writeConfig(f.storeDir, { ...defaultConfig(), cloud: { kind: 'gdrive', account: 'me', folderName: 'X' } })
    const r = await run(f, deps)
    expect(r.replicas?.find((x) => x.dest === 'cloud')).toMatchObject({ ok: false, reachable: false, reason: 'cloud_auth' })
  })

  it('a failed cloud listing prunes nothing there', async () => {
    const cloud = fakeCloud({ failList: new Error('Drive 500: backend error') })
    const { f, deps } = setup('nolist', cloud)
    writeConfig(f.storeDir, { ...defaultConfig(), cloud: { kind: 'gdrive', account: 'me', folderName: 'X' } })
    // Pretend there are many old backups in the cloud.
    for (let d = 1; d <= 40; d++) {
      const name = backupFileName(new Date(Date.now() - d * 86400000), 'old')
      cloud.files.set(name, { name, size: 1, ref: `id-${name}` })
    }
    await run(f, deps)
    expect(cloud.removed).toEqual([])
  })

  it('retention actually prunes the local folder down to 3', async () => {
    const { f, deps } = setup('prune')
    const dir = join(f.storeDir, 'backups')
    mkdirSync(dir, { recursive: true })
    for (let d = 1; d <= 6; d++) writeFileSync(join(dir, backupFileName(new Date(Date.now() - d * 86400000), 'old')), 'x')
    const r = await run(f, deps)
    const left = readdirSync(dir).filter((n) => n.endsWith('.mbk'))
    expect(left).toHaveLength(3)
    expect(left).toContain(r.name)
    expect(r.pruned?.local?.length).toBe(4)
  })

  it('a scheduled run right after a success is skipped', async () => {
    const { f, deps } = setup('skip')
    const a = await run(f, deps)
    expect(a.ok).toBe(true)
    const b = await run(f, deps, { kind: 'scheduled' })
    expect(b).toMatchObject({ ok: true, skipped: true })
  })

  it('replicate() alone reports every destination', async () => {
    const { f, deps } = setup('rep')
    const file = join(f.root, backupFileName(new Date(), 'x'))
    writeFileSync(file, 'data')
    const reps = await replicate(file, backupFileName(new Date(), 'x'), readConfig(f.storeDir), deps)
    expect(reps.map((x) => x.dest)).toEqual(['local', 'depot'])
    expect(existsSync(join(deps.depotBackupDir()!, backupFileName(new Date(), 'x')))).toBe(true)
  })
})

describe('daily timer', () => {
  it('is due once per wall-clock day, after the configured time', () => {
    const tz = 'Europe/Budapest'
    // 2026-09-25 01:10 UTC = 03:10 Budapest (before 03:30)
    expect(isDue(new Date(Date.UTC(2026, 8, 25, 1, 10)), tz, '03:30', undefined).due).toBe(false)
    // 01:40 UTC = 03:40 Budapest
    const r = isDue(new Date(Date.UTC(2026, 8, 25, 1, 40)), tz, '03:30', undefined)
    expect(r).toEqual({ due: true, day: '2026-09-25' })
    expect(isDue(new Date(Date.UTC(2026, 8, 25, 20, 0)), tz, '03:30', '2026-09-25').due).toBe(false)
  })

  it('a tick runs once and marks the day, a second tick does nothing', async () => {
    const { f } = setup('tick')
    let runs = 0
    const d = { storeDir: f.storeDir, tz: 'UTC', run: async () => { runs++ } }
    const at = new Date(Date.UTC(2026, 8, 25, 12, 0))
    expect(await schedulerTick(d, at)).toBe(true)
    expect(await schedulerTick(d, at)).toBe(false)
    expect(runs).toBe(1)
    writeConfig(f.storeDir, { ...defaultConfig(), schedule: { enabled: false, time: '03:30' } })
    expect(await schedulerTick(d, new Date(Date.UTC(2026, 8, 26, 12, 0)))).toBe(false)
  })
})

describe('health (§9)', () => {
  const base = { now: Date.now(), state: {}, stateExists: false, newestLocalMs: null, destinations: [], kitConfirmed: null, freshInstall: false, scheduleTime: '03:30' }
  const both = [
    { id: 'local', kind: 'local', enabled: true, where: 'x' },
    { id: 'depot', kind: 'depot', enabled: true, where: 'y' },
    { id: 'cloud', kind: 'gdrive', enabled: true, where: 'z' },
  ] as any
  const H = 60 * 60 * 1000

  it('fresh install, no backup yet: neutral, names the time', () => {
    expect(backupHealthRow({ ...base, freshInstall: true })).toEqual({ id: 'backup_none_yet', status: 'ok', params: { time: '03:30' } })
  })
  it('an install with data and no backup: bad', () => {
    expect(backupHealthRow(base).status).toBe('bad')
  })
  it('last run failed: bad', () => {
    const now = Date.now()
    const r = backupHealthRow({ ...base, now, state: { lastSuccessAt: now - 2 * H, lastRun: { at: now - H, ok: false, kind: 'manual', error: 'io_error', durationMs: 1 } } })
    expect(r).toMatchObject({ id: 'backup_failed', status: 'bad' })
  })
  it('older than 36 h: orange', () => {
    const now = Date.now()
    expect(backupHealthRow({ ...base, now, state: { lastSuccessAt: now - 40 * H } })).toMatchObject({ id: 'backup_stale', status: 'warn' })
  })
  it('depot unreachable vs. failed are different lines', () => {
    const now = Date.now()
    const st = (reachable: boolean) => ({ lastSuccessAt: now - H, replicas: { depot: { at: now, ok: false, reachable } } })
    expect(backupHealthRow({ ...base, now, destinations: both, state: st(false) }).id).toBe('backup_depot_unreachable')
    expect(backupHealthRow({ ...base, now, destinations: both, state: st(true) }).id).toBe('backup_depot_failed')
  })
  it('only on this machine: orange', () => {
    const now = Date.now()
    expect(backupHealthRow({ ...base, now, destinations: [both[0]], state: { lastSuccessAt: now - H } }).id).toBe('backup_single_copy')
  })
  it('verify failed: bad; kit unconfirmed: orange, never red', () => {
    const now = Date.now()
    const ok = { lastSuccessAt: now - H, replicas: { depot: { at: now, ok: true, reachable: true }, cloud: { at: now, ok: true, reachable: true } } }
    expect(backupHealthRow({ ...base, now, destinations: both, state: { ...ok, lastVerify: { at: now, ok: false, name: 'x' } } }).status).toBe('bad')
    expect(backupHealthRow({ ...base, now, destinations: both, state: ok, kitConfirmed: false })).toMatchObject({ id: 'backup_kit_unconfirmed', status: 'warn' })
    expect(backupHealthRow({ ...base, now, destinations: both, state: ok, kitConfirmed: true })).toMatchObject({ id: 'backup_ok_copies', status: 'ok', params: { n: 3 } })
  })
})

describe('the auto-deploy never touches the local backups', () => {
  it('scripts/deploy-live.sh has no git clean and no rm on store/', () => {
    const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'deploy-live.sh'), 'utf8')
    const code = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/git\b[^\n]*\bclean\b/)
    expect(code).not.toMatch(/\brm\b[^\n]*(store|STATE_DIR)/)
  })
})
