/**
 * #396 Phase 4 -- the end-to-end case the whole card is about: install A is
 * backed up, an EMPTY install B with a DIFFERENT project root and home is
 * restored from it. Every count matches, the memories land under B's slug,
 * paths in agent-config.json point into B, channels and schedules are held
 * until "the old machine is off", and a failure half-way leaves B exactly as it
 * was.
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createBackup } from '../backup/create.js'
import { generateRecoveryKey } from '../backup/crypto.js'
import { inspectBackup } from '../backup/inspect.js'
import { buildRestorePlan, pauseStagedSchedules, performRestore, releaseHeld, recoverInterruptedRestore, FLAG } from '../backup/restore.js'
import { runRestore } from '../backup/restore-runner.js'
import { populatedInstall, emptyInstall, slugOf, makeDb } from './backup-fixture.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const key = generateRecoveryKey()

async function backupOfA() {
  const A = populatedInstall('e2e-a')
  roots.push(A.root)
  // a DB-scheduled task that is active on A
  const db = new Database(join(A.storeDir, 'claudeclaw.db'))
  db.exec("CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, chat_id TEXT, prompt TEXT, schedule TEXT, next_run INTEGER, status TEXT)")
  db.prepare("INSERT INTO scheduled_tasks VALUES ('t1','c','p','0 8 * * *',0,'active')").run()
  db.close()
  // an agent skills link pointing into A's home, like on a real install
  mkdirSync(join(A.projectRoot, 'agents', 'beta', '.claude'), { recursive: true })
  symlinkSync(join(A.home, '.claude', 'skills'), join(A.projectRoot, 'agents', 'beta', '.claude', 'skills'))
  const r = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, encrypt: { kdfN: 1024 }, appCommit: 't', appVersion: '1.29.0' })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return { A, file: r.file! }
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out[relative(dir, p)] = 'link:' + readlinkSync(p)
      else if (st.isDirectory()) walk(p)
      else out[relative(dir, p)] = readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}

async function prepare(B: ReturnType<typeof emptyInstall>, file: string, id: string) {
  const ctx = { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }
  const ins = await inspectBackup({ file, recoveryKey: key, ctx, appVersion: '1.29.0', currentDb: join(B.storeDir, 'claudeclaw.db') })
  const plan = buildRestorePlan({ id, file, stagingDir: ins.stagingDir, manifest: ins.manifest, ctx })
  const dbItem = plan.items.find((i) => i.category === 'database')!
  plan.pausedTaskIds = pauseStagedSchedules(dbItem.staged)
  return { ins, plan, ctx }
}

describe('restore A -> empty B with different paths', async () => {
  const { A, file } = await backupOfA()
  const B = emptyInstall('e2e-b')
  roots.push(B.root)
  makeDb(join(B.storeDir, 'claudeclaw.db'), 0, 0)
  const { ins, plan } = await prepare(B, file, 'plan1')
  let stopped = 0
  let started = 0
  const out = await runRestore(plan, { stop: () => { stopped++ }, start: () => { started++ }, sleep: async () => {} })

  it('the preview saw a fresh install and the path moves', () => {
    expect(ins.freshInstall).toBe(true)
    expect(ins.compat).toMatchObject({ ok: true })
    expect(ins.pathRewrites.map((r) => r.what).sort()).toEqual(['home', 'project_root', 'slug'])
    expect(ins.categories.find((c) => c.id === 'memory')!.willAdd).toBeGreaterThan(0)
    expect(ins.needsLogin).toEqual(['main', 'alpha', 'beta'])
  })

  it('succeeds, stops and starts the dashboard once', () => {
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true })
    expect([stopped, started]).toEqual([1, 1])
    expect(existsSync(join(B.storeDir, FLAG))).toBe(false)
  })

  it('every count matches', () => {
    const db = new Database(join(B.storeDir, 'claudeclaw.db'), { readonly: true })
    const n = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n
    expect([n('kanban_cards'), n('memories')]).toEqual([5, 7])
    // the DB task is paused until the owner confirms
    expect((db.prepare("SELECT status FROM scheduled_tasks WHERE id='t1'").get() as any).status).toBe('paused')
    db.close()
    expect(existsSync(join(B.storeDir, 'claudeclaw.db-wal'))).toBe(false)
  })

  it('memories land under B\'s slug, agent paths point into B', () => {
    const slugB = slugOf(B.projectRoot)
    expect(readFileSync(join(B.home, '.claude-marvin', 'projects', slugB, 'memory', 'x.md'), 'utf8')).toBe('main memory')
    expect(existsSync(join(B.home, '.claude-beta', 'projects', slugOf(join(B.projectRoot, 'agents', 'beta')), 'memory', 'b.md'))).toBe(true)
    expect(existsSync(join(B.storeDir, 'accounts', 'acct1', 'projects', slugB, 'memory', 'acct.md'))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(B.projectRoot, 'agents', 'beta', 'agent-config.json'), 'utf8'))
    expect(cfg.claudeConfigDir).toBe(join(B.home, '.claude-beta'))
    expect(readFileSync(join(B.storeDir, 'life-mounts.json'), 'utf8')).toContain(B.projectRoot)
    expect(readFileSync(join(B.storeDir, 'life-mounts.json'), 'utf8')).not.toContain(A.projectRoot)
    expect(readlinkSync(join(B.projectRoot, 'agents', 'beta', '.claude', 'skills'))).toBe(join(B.home, '.claude', 'skills'))
    expect(readFileSync(join(B.home, '.claude', 'skills', 'k1', 'SKILL.md'), 'utf8')).toBe('home skill')
    expect(readFileSync(join(B.projectRoot, '.env'), 'utf8')).toContain('FOO=bar')
  })

  it('keeps the new install\'s own access token (the browser stays signed in)', () => {
    expect(existsSync(join(B.storeDir, '.dashboard-token'))).toBe(false)
    expect(existsSync(join(B.storeDir, 'vault.json'))).toBe(true)
  })

  it('never restores Claude logins, hooks, or service units', () => {
    expect(existsSync(join(B.home, '.claude-marvin', '.credentials.json'))).toBe(false)
    expect(existsSync(join(B.projectRoot, 'agents', 'alpha', '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(B.home, '.config', 'systemd'))).toBe(false)
  })

  it('channels and file schedules are held until the owner confirms', () => {
    expect(existsSync(join(B.projectRoot, '.claude', 'channels', 'telegram', '.env'))).toBe(false)
    expect(existsSync(join(B.home, '.claude', 'scheduled-tasks', 't1', 'SKILL.md'))).toBe(false)
    let resumed: string[] = []
    const rel = releaseHeld(B.storeDir, (ids) => { resumed = ids; return ids.length })
    expect(rel.kept).toEqual([])
    expect(resumed).toEqual(['t1'])
    expect(readFileSync(join(B.projectRoot, '.claude', 'channels', 'telegram', '.env'), 'utf8')).toBe('TELEGRAM_BOT_TOKEN=1')
    expect(existsSync(join(B.projectRoot, 'agents', 'alpha', '.claude', 'channels', 'telegram', '.env'))).toBe(true)
    expect(existsSync(join(B.home, '.claude', 'scheduled-tasks', 't1', 'SKILL.md'))).toBe(true)
  })
})

describe('rollback', async () => {
  const { file } = await backupOfA()

  it('a failure half-way leaves B byte-identical', async () => {
    const B = emptyInstall('rb-b')
    roots.push(B.root)
    makeDb(join(B.storeDir, 'claudeclaw.db'), 2, 3)
    writeFileSync(join(B.projectRoot, '.env'), 'B_OWN=1\n')
    mkdirSync(join(B.home, '.claude', 'skills', 'mine'), { recursive: true })
    writeFileSync(join(B.home, '.claude', 'skills', 'mine', 'SKILL.md'), 'B skill')
    const { plan } = await prepare(B, file, 'plan2')
    // After the preview: reading B's WAL-mode DB there creates its -wal/-shm,
    // which is SQLite's doing, not the restore's.
    const before = { p: snapshotTree(B.projectRoot), h: snapshotTree(B.home) }
    const victim = plan.items.find((i) => i.logical === 'home/.claude/skills/k1/SKILL.md')!.logical
    const out = performRestore(plan, { failAt: victim })
    expect(out).toMatchObject({ ok: false, rolledBack: true })
    expect(out.rollbackErrors).toEqual([])
    const after = { p: snapshotTree(B.projectRoot), h: snapshotTree(B.home) }
    // Files the restore added are gone, files it replaced are back; the
    // bookkeeping it writes into store/ (result, rollback dir) is the only
    // difference, by design.
    const strip = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !/^store\/(restore-|tmp\/)/.test(k)))
    expect(Object.keys(strip(after.p)).filter((k) => !(k in before.p))).toEqual([])
    expect(strip(after.p)).toEqual(strip(before.p))
    expect(after.h).toEqual(before.h)
    expect(JSON.parse(readFileSync(join(B.storeDir, 'restore-result.json'), 'utf8')).rolledBack).toBe(true)
  })

  it('a runner that died half-way is rolled back on the next start', async () => {
    const B = emptyInstall('crash-b')
    roots.push(B.root)
    makeDb(join(B.storeDir, 'claudeclaw.db'), 1, 1)
    const before = readFileSync(join(B.storeDir, 'claudeclaw.db'))
    const { plan } = await prepare(B, file, 'plan3')
    // simulate the crash: flag written, some moves done, no cleanup
    writeFileSync(join(B.storeDir, FLAG), JSON.stringify({ planId: plan.id, rollbackDir: plan.rollbackDir, pid: 999999 }))
    const { applyRestore } = await import('../backup/restore.js')
    applyRestore(plan)
    expect(readFileSync(join(B.storeDir, 'claudeclaw.db')).equals(before)).toBe(false)
    const rec = recoverInterruptedRestore(B.storeDir, () => false)
    expect(rec).toMatchObject({ ok: false, reason: 'interrupted', rolledBack: true })
    expect(readFileSync(join(B.storeDir, 'claudeclaw.db')).equals(before)).toBe(true)
    expect(existsSync(join(B.storeDir, FLAG))).toBe(false)
  })

  it('a living runner is left alone', () => {
    const B = emptyInstall('alive-b')
    roots.push(B.root)
    writeFileSync(join(B.storeDir, FLAG), JSON.stringify({ planId: 'x', rollbackDir: '/nope', pid: 12345 }))
    expect(recoverInterruptedRestore(B.storeDir, () => true)).toBeNull()
    expect(existsSync(join(B.storeDir, FLAG))).toBe(true)
  })

  it('wrong key is refused before anything is staged', async () => {
    const B = emptyInstall('wk-b')
    roots.push(B.root)
    await expect(inspectBackup({ file, recoveryKey: generateRecoveryKey(), ctx: { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }, appVersion: '1.29.0', currentDb: null }))
      .rejects.toMatchObject({ code: 'wrong_key' })
    expect(readdirSync(join(B.storeDir, 'tmp'))).toEqual([])
  })
})
