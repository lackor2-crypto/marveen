/**
 * #396 Phase 6 -- verify: a good backup passes the trial restore (with the
 * app's real migrations); a correctly encrypted archive with a damaged DB fails
 * at the integrity check; a missing file fails the hash stage; the trial never
 * writes outside its throwaway root; the weekly / monthly triggers fire once.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBackup } from '../backup/create.js'
import { encryptStream, generateRecoveryKey, readHeader } from '../backup/crypto.js'
import { extractBackup } from '../backup/extract.js'
import { verifyBackup } from '../backup/verify.js'
import { verifyTick } from '../backup/scheduler.js'
import { updateState, readState } from '../backup/state.js'
import { populatedInstall, emptyInstall } from './backup-fixture.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const key = generateRecoveryKey()
const A = populatedInstall('verify-a'); roots.push(A.root)
// The app's real schema: the trial restore runs the real migrations, and a real
// backup always carries the full schema (the fixture's three-table DB does not).
{
  const { initDatabase, getDb } = await import('../db.js')
  const dbFile = join(A.storeDir, 'claudeclaw.db')
  rmSync(dbFile, { force: true })
  initDatabase(dbFile)
  getDb().prepare("INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at) VALUES ('c', 'm', 'semantic', 1, 1, 1)").run()
  getDb().close()
}
const made = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, encrypt: { kdfN: 1024 }, appVersion: '1.29.0', appCommit: 't' })
const scratch = mkdtempSync(join(A.root, 'scratch-'))

/** Unpack, let `edit` change the staged tree, pack + encrypt it again. */
async function repack(edit: (dir: string, manifest: any) => void): Promise<string> {
  const dir = mkdtempSync(join(A.root, 'repack-'))
  const { manifest, header } = await extractBackup(made.file!, key, dir)
  edit(dir, manifest)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const tgz = execFileSync('tar', ['-czf', '-', '-C', dir, ...readdirSync(dir)], { maxBuffer: 256 * 1024 * 1024 })
  const enc = encryptStream(key, { createdAt: header.createdAt, appVersion: header.appVersion, appCommit: header.appCommit, kind: header.kind }, { kdfN: 1024 })
  const parts: Buffer[] = [enc.header]
  await pipeline(Readable.from([tgz]), enc.transform, new Writable({ write(c, _e, cb) { parts.push(c); cb() } }))
  const out = join(A.root, `repacked-${Math.random().toString(36).slice(2)}.mbk`)
  writeFileSync(out, Buffer.concat(parts))
  return out
}

describe('verifyBackup', () => {
  it('a good backup passes, including the app\'s real DB migrations on the restored copy', async () => {
    const { initDatabase, getDb } = await import('../db.js')
    const r = await verifyBackup({ file: made.file!, recoveryKey: key, scratchBase: scratch, migrate: (db) => { initDatabase(db); getDb().close() } })
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, stage: 'done' })
    expect(readdirSync(scratch)).toEqual([])
  })

  it('a damaged DB inside a correctly encrypted archive fails at the integrity check', async () => {
    const file = await repack((dir, m) => {
      const p = join(dir, 'project/store/claudeclaw.db')
      const b = readFileSync(p)
      // Scribble over the middle pages, keep the header so it still opens.
      for (let i = 4096; i < Math.min(b.length, 4096 * 3); i++) b[i] = 0x5a
      writeFileSync(p, b)
      const f = m.files.find((x: any) => x.path === 'project/store/claudeclaw.db')
      f.sha256 = createHash('sha256').update(b).digest('hex')
      f.size = b.length
    })
    expect(readHeader(file).header.format).toBe(1)
    const r = await verifyBackup({ file, recoveryKey: key, scratchBase: scratch })
    expect(r.ok).toBe(false)
    expect(['database', 'counts']).toContain(r.stage)
  })

  it('a missing file fails the hash stage', async () => {
    const file = await repack((dir) => { unlinkSync(join(dir, 'project/store/vault.json')) })
    const r = await verifyBackup({ file, recoveryKey: key, scratchBase: scratch })
    expect(r).toMatchObject({ ok: false, stage: 'hashes' })
  })

  it('a wrong key fails at decrypt', async () => {
    const r = await verifyBackup({ file: made.file!, recoveryKey: generateRecoveryKey(), scratchBase: scratch })
    expect(r).toMatchObject({ ok: false, stage: 'decrypt', reason: 'wrong_key' })
  })

  it('the trial restore never writes outside its own root', async () => {
    const outside = mkdtempSync(join(A.root, 'outside-'))
    const file = await repack((_dir, m) => { m.roots['config/beta'] = { kind: 'agent', base: 'abs', rel: outside } })
    const r = await verifyBackup({ file, recoveryKey: key, scratchBase: scratch })
    expect(r.ok).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('verify triggers', () => {
  it('weekly verify and monthly off-site verify start once, then wait', () => {
    const f = emptyInstall('vt'); roots.push(f.root)
    updateState(f.storeDir, (s) => { s.lastSuccessName = 'x.mbk'; s.replicas = { cloud: { at: 1, ok: true, reachable: true } } })
    const started: string[] = []
    const d = { storeDir: f.storeDir, tz: 'UTC', run: async () => {}, verify: (n: string) => started.push('v:' + n), offsite: () => started.push('o') }
    expect(verifyTick(d)).toEqual({ verify: true, offsite: true })
    expect(verifyTick(d)).toEqual({ verify: false, offsite: false })
    expect(started).toEqual(['v:x.mbk', 'o'])
    expect(readState(f.storeDir).lastVerifyStartedAt).toBeGreaterThan(0)
    expect(existsSync(join(f.storeDir, 'backup-state.json'))).toBe(true)
  })
})
