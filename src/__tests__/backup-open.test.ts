/**
 * #414 -- a backup with a key (protected, the default) or without (open):
 *
 *   - the open format (2) round-trips, carries no key material, and is still
 *     refused when damaged, reordered or cut short;
 *   - a protected backup with no key is refused (key_needed), before any data;
 *   - a file written by the #396 code (format 1) still opens -- the fixture
 *     below was made by the crypto.ts of 6c5d92bb, before this change;
 *   - an open backup restores onto an empty install with no key at all, and
 *     does not carry store/.backup-key either;
 *   - the daily (scheduled) run follows the owner's choice; an open backup
 *     never creates a key file; the kit is not nagged about while open.
 */
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BackupDecryptError, decryptStream, encryptStream, FORMAT, FORMAT_OPEN, generateRecoveryKey, headerKeyId,
  isOpenBackup, readHeader,
} from '../backup/crypto.js'
import { createBackup } from '../backup/create.js'
import { extractBackup } from '../backup/extract.js'
import { inspectBackup } from '../backup/inspect.js'
import { verifyBackup } from '../backup/verify.js'
import { buildRestorePlan, pauseStagedSchedules } from '../backup/restore.js'
import { runRestore } from '../backup/restore-runner.js'
import { resolveKey, RestoreError } from '../backup/restore-service.js'
import { runFullBackup, pruneAll } from '../backup/pipeline.js'
import { backupKeyFor } from '../backup/service.js'
import { defaultConfig, readConfig, writeConfig, type DestinationDeps } from '../backup/destinations.js'
import { keyFilePath, getOrCreateKey, readKeyFile, rotateKey } from '../backup/key-store.js'
import { readState } from '../backup/state.js'
import { computeBackupHealth } from '../backup/health.js'
import { populatedInstall, emptyInstall, makeDb } from './backup-fixture.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const CHUNK = 1024
const base = { createdAt: '2026-09-27T10:00:00+02:00', appVersion: '1.29.0', appCommit: 'abcd1234', kind: 'manual' as const }

async function seal(key: string | null, plain: Buffer): Promise<Buffer> {
  const { header, transform } = encryptStream(key, base, { kdfN: 1024, chunkSize: CHUNK })
  const out: Buffer[] = [header]
  await pipeline(Readable.from([plain]), transform, new Writable({ write(c, _e, cb) { out.push(c); cb() } }))
  return Buffer.concat(out)
}

async function unseal(key: string | null, file: Buffer): Promise<Buffer> {
  const { header, headerBytes, payloadOffset } = readHeader(file)
  const out: Buffer[] = []
  const dec = decryptStream(key, header, headerBytes)
  const body = file.subarray(payloadOffset)
  const pieces: Buffer[] = []
  for (let i = 0; i < body.length; i += 777) pieces.push(body.subarray(i, i + 777))
  await pipeline(Readable.from(pieces), dec, new Writable({ write(c, _e, cb) { out.push(c); cb() } }))
  return Buffer.concat(out)
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof p === 'function' ? p() : p); return 'ok' } catch (e) {
    if (e instanceof BackupDecryptError) return e.code
    throw e
  }
}

describe('the open format (2)', () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 5 * CHUNK + 17])('%i bytes round-trip with no key', async (n) => {
    const plain = randomBytes(n)
    expect((await unseal(null, await seal(null, plain))).equals(plain)).toBe(true)
  })

  it('its header says so, and holds no key material', async () => {
    const file = await seal(null, Buffer.from('payload'))
    const { header } = readHeader(file)
    expect(header.format).toBe(FORMAT_OPEN)
    expect(isOpenBackup(header)).toBe(true)
    expect(headerKeyId(header)).toBeNull()
    for (const k of ['kdf', 'wrappedKey', 'keyId']) expect(Object.keys(header)).not.toContain(k)
  })

  it('is not encrypted: the plaintext is in the file (what the page warns about)', async () => {
    const file = await seal(null, Buffer.from('a very secret password'))
    expect(file.toString('latin1')).toContain('a very secret password')
  })

  it('a key given for an open backup is not needed and does no harm', async () => {
    const plain = randomBytes(3000)
    expect((await unseal(generateRecoveryKey(), await seal(null, plain))).equals(plain)).toBe(true)
  })

  it('a flipped bit, a cut at a chunk boundary, an edited header: refused', async () => {
    const plain = randomBytes(4 * CHUNK + 100)
    const file = await seal(null, plain)
    const { payloadOffset } = readHeader(file)
    const bad = Buffer.from(file); bad[payloadOffset + 2 * (CHUNK + 16) + 5] ^= 0x01
    expect(await codeOf(unseal(null, bad))).toBe('corrupt')
    expect(await codeOf(unseal(null, file.subarray(0, payloadOffset + 3 * (CHUNK + 16))))).toBe('truncated')
    expect(await codeOf(unseal(null, file.subarray(0, payloadOffset)))).toBe('truncated')
    const edited = Buffer.from(file.toString('latin1').replace('T10:00:00', 'T10:00:01'), 'latin1')
    expect(await codeOf(unseal(null, edited))).toBe('corrupt')
    // two middle chunks swapped
    const r = CHUNK + 16
    const swapped = Buffer.concat([file.subarray(0, payloadOffset), file.subarray(payloadOffset + r, payloadOffset + 2 * r), file.subarray(payloadOffset, payloadOffset + r), file.subarray(payloadOffset + 2 * r)])
    expect(await codeOf(unseal(null, swapped))).toBe('corrupt')
  })

  it('the format number and the protection field must agree', async () => {
    const withHeader = (file: Buffer, edit: (h: any) => void) => {
      const { header, payloadOffset } = readHeader(file)
      const h = JSON.parse(JSON.stringify(header)); edit(h)
      const json = Buffer.from(JSON.stringify(h))
      const len = Buffer.alloc(4); len.writeUInt32BE(json.length, 0)
      return Buffer.concat([file.subarray(0, 8), len, json, file.subarray(payloadOffset)])
    }
    const open = await seal(null, Buffer.from('x'))
    const keyed = await seal(generateRecoveryKey(), Buffer.from('x'))
    expect(await codeOf(() => readHeader(withHeader(open, (h) => { h.format = FORMAT })))).toBe('corrupt')
    expect(await codeOf(() => readHeader(withHeader(keyed, (h) => { h.protection = 'none' })))).toBe('corrupt')
    expect(await codeOf(() => readHeader(withHeader(keyed, (h) => { h.format = FORMAT_OPEN })))).toBe('corrupt')
    // a protected file dressed up as an open one does not pass the checksum
    expect(await codeOf(unseal(null, withHeader(keyed, (h) => { h.format = FORMAT_OPEN; h.protection = 'none'; delete h.kdf; delete h.wrappedKey; delete h.keyId })))).toBe('corrupt')
    expect(await codeOf(() => readHeader(withHeader(open, (h) => { h.format = 3 })))).toBe('format_unknown')
  })
})

describe('a protected backup (format 1)', () => {
  it('is still written as format 1, with its key id', async () => {
    const key = generateRecoveryKey()
    const { header } = readHeader(await seal(key, Buffer.from('x')))
    expect(header.format).toBe(FORMAT)
    expect(isOpenBackup(header)).toBe(false)
    expect(headerKeyId(header)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('without a key it is refused (key_needed), before any data flows', async () => {
    const file = await seal(generateRecoveryKey(), randomBytes(3000))
    const { header, headerBytes } = readHeader(file)
    expect(await codeOf(() => decryptStream(null, header, headerBytes))).toBe('key_needed')
  })

  it('a file written by the #396 code (before #414) opens unchanged', async () => {
    const OLD = Buffer.from(
  'TVJWTkJLMDEAAAGCeyJmb3JtYXQiOjEsImNyZWF0ZWRBdCI6IjIwMjYtMDktMjVUMjA6MTU6MDArMDI6MDAiLCJhcHBWZXJzaW9u' +
  'IjoiMS4yOS4wIiwiYXBwQ29tbWl0IjoiYWJjZDEyMzQiLCJraW5kIjoibWFudWFsIiwia2RmIjp7ImFsZyI6InNjcnlwdCIsIk4i' +
  'OjEwMjQsInIiOjgsInAiOjEsInNhbHQiOiJMTFM5UHl0dnN5NGxTMWIvUmYyY2hRPT0ifSwid3JhcHBlZEtleSI6eyJhbGciOiJB' +
  'MjU2R0NNIiwibm9uY2UiOiJnODFCOEcxaXQxZ0tRQ0NvIiwiY3QiOiI4aklmRHBLamVTWnA0T28wWlJ0aHdWeFhSWG1KSjd0ZjhS' +
  'OU12MUhvbDhITHAwVmplYlpnS2N3b2dSVDNVaDRqIn0sImtleUlkIjoiYTg1NWUxNmUiLCJub25jZVByZWZpeCI6ImUvai9SakF5' +
  'Rnc9PSIsImNodW5rU2l6ZSI6MTAyNH1XVBR7Dde9dydm/+036BHQGMVVQs2mQF1BIJgTXmqMFG9R9DtcjsbpGGAjtc1fpug0BNm8' +
  'wHpFY4U08bZcnpyyijEGIgP5UFTjhaTsZFroDqMPbN5lJsHJizCjby7M/JPdADkKEFmudGjThraVkqhk69aEkxwOHVEmwHS8DTDU' +
  'CxK37Iz4WAe7snTO3sfzGUJw1MkIViiQBTa8ETpEKyZ371YqjzoaBJfzgxz6RLh2EHUDdzfPOzbAzSGNuS9C3155rcyaqv5syeAY' +
  'XH+VzDXhTvsBVzT/VjFU7ZeColh2HR8vhamZMMUsxbjSdSbuc2s6tjfuj1Sxd9SKrdpaAIDYMU6I3RxdOneR4fSLvJ8scUqWwn2d' +
  'yF2lWNcVryvbyAiqMFOMwphrX3XO/GiCwX0ijyCQWk+gQ5m7j3ynQHPAeQCv+kbc05/OwncxejGTu4b4eBv7+8LKh4fhx+CmodRV' +
  'bLs9/4XQBXTo6GXjQr9dJTFjStlVNXReFa6jagoVeU6MEgWi2Reu62+jBXjA+AdGLmIcqkBRIdZuveg8nkookq2cTKsBt5KjxzID' +
  '5wSo6v2FH0o/Y2HxlxVuJkf6gM1/m+JUoW4Uh+0TOZzQAmvAe6Bfxp0AHw3AS9MugaDREIPf46ixhFMxUR2nD2z6Y/qwzER2iTWQ' +
  'EwWQ74EuZQsp/sj3y9H99IAhvdRrBvhmwco+L/JMBD9TRIsALTLoySjlGgDO8ftcBFaar+dmpoxf6wIMKp+89xtNzCCfxHCljrL4' +
  'LTFcA0qMypP+Ope0K3jxsqrQOu5rmh+zb6AL9Yy7xB6utmKknCAn/p6u4CYL9/NgyT3AYb2cI7wduk36GtKMlB8FyTn9XQgZhG85' +
  'WFemtaLx7wPt8YWOjD1CFBlSVYOuUrff1yNC5hQf3ejJf617y+ojLJR3z4cUY/y05sut5Q3/Ca1JZq2fUEgwseOqTNE565zycj6o' +
  'TtURKc5VRTqrG6jUsmSJ3s+zkJ5v+u7jSbOIfia52vOGEDnVJSEDc3kaXG+Yfo6HKliPYf9maZJTmMxotrTQgzLvn0FActXTKYIg' +
  'sR4BoNtAtoFPHAQLfB36GBrdwmFJE+q7yo9mTqIke3rxtp8HjXjDf6IJwkC6Tp7fDJEcj4tBUwZ0LZjLUvsgKv7w3Nzl59V7V3SC' +
  'rzX9D35RjATBLZsY15x0dtE/RzggqmVD7OCEQRSnFzhTxSUhfQhAKOJN1eZ4/oTo+tRsJYDg52S9rUJvFmFfh8KW/hG8GsMMYSMz' +
  'Z/k1+Xw2YztbMzh04qiz3qPRzID7fIUkarFWrjR2G2AhEqCRHPAzf7Ek6t4qIRwlyGBrB5R+WQl50Xzj6+xTaqHzMoHr14JKzGOY' +
  'GeTq6ZKXfVpghvW5/Yfc4tVGNZ3KaO/o3X/k000tJHjNVpZPf1d2osZnDtWZtZcbs+9CVDWJEE6PcGbpv7laXzZyDljIuV8WOZc3' +
  'FyP3UsZIHJmCMMuE5aAmV5Fib6ae1BH51gXbpHyI/i2iwkSZl3zfheZ7Pi5Sqg9kQgtxLhkXW4vxMcLu/fSp4pgYGc5ytfTbxPRP' +
  'ncL4ZItVCm5P9ZW/v5OfBgKusXToAxxpk5sC0jE54Spkn13A1zP0gLLvfVDQgSeG6Z6S0Zudcz9lbiQYpQTCuc1YTYp8DFKoA1FV' +
  'dixMl5JWXEE3f4nz44ZzuxaC8swaacWaz51VrsF7K72YZOYtoX931BcR+9TeQfs7wkjmj3//bpdwF6JQw4vbU3PlXtDd0We7l1MA' +
  '8c89+OpKJI61ssAhPS7McaXby4gemNOJAnreeRZzkUGO0Ka2clANwP5CF+eNUAudw50M/CrZfPwGJ8VthEj50mmsd16X64Hch/xZ' +
  '2rS3eh/cvfHAYEGdZTP062gg8JnsxosXedVCDI7EaRiSsu7CYaMUszknGSeIgFFIrzODeJmIDJRYPyrMJq1RhNJ1nFIzUVOQGNJ2' +
  'tbmv0xSn7ZiGAg4DADiuHk4K536ETlwAcGG7BO8/fK1MSjoYlgd+mx5SeevgG1fDLSXvGZKGniwOBNljoJl1F9ZugKYAmb1Icfnu' +
  'i+DZ6yno1CvDAwL6sP7WSatf1fPiNndfcqZXe/RtxawF9x6EqMGiPX15xLq4khV3QnFi+1G9EV4Cuh1fO/nQwIaayDKBG2s3ioqF' +
  'VGzjljbJ4Wcf/EnWETMph4I67dE1gyRGFCOa446xGPnXt5IC7bb0VlXxOBTMlwAnjZzo6oH8y32WjSxWgnH8fDETBabB1vdnJzPE' +
  '4tWBMf0GG595IpcygRfqlwoU0NqUtAhuVuEU4kh9zLhEp9ssWa9/bvBnu/UiNgVBVCm6V5GClafoGs55pyNjtqze48HB1/hXYbtj' +
  'V2aVaJUJ9Z0kcTtx7hIse8w3/jl0IPhNmVwRYKkJMfmg9jEfmi6mmYgt+L8K1L7LmfMD7kGmI51AQYXLWygegWb94Ht7xrtnBuBz' +
  'zM1wqyF8GqkqWwWQGHbTiOUdY+RmwEFIKnFphZWXTEzDwl8/2BfyE4XYypphgp9L9m4Hn3Yz+jzbr4Pg3se3O+hrbcadTESURDyW' +
  '0y5c+ZRsxu6G7c1c43GC6tOKE26RagxOCUCjYaWqCRNNrqfrVRN6V8wPr8W0CxbVYQdrCTc0qvyHD3wokTcWiNTRUoMZTjZBUWSi' +
  'XRKUqx8AogOP9bEhlYUysBuFLvaAENq/l7JwWIVlyX3IVfsfkphGhNzf/xW6Gr819thp/ESMYl/hcWP7SuGOHVkskdETRfiaPR/s' +
  'VUVf9pNrHSfHjHQxSiwYnwldyQ4t7cgeMKwtqwSghmChcJMaQA9eR5eSfkFkT9t+Jn2WAekx4ABkpqgYHOs1UcR0sSP4S2CsbO1H' +
  '7KTxz4SDAV9O6KY21Eymq5XIXRlc+P1UQGA4wEO1sxX4SlAVNWE73HE3Iv5RV2IYT9CuSjYX9FnpCk0yr5Gh74bIlWWK5kNc5Zmo' +
  'ZmuGPhiAjytEY6YM7/kEzQp/5uj5F8BffOXTnOscz4e1KQHCJ+AKocOc2XuMzcehK4Np5E7XCMjkEInR7oqGHB9C3ihIb8SLL3N8' +
  'uClrjGuTqH5ek+4DXQC38R4dJ2g05AvHjSH+OxnDksH0UQCZbNWPP2vGvFgw98S4ScsUn8Xe5lyzqsRkVzdrwU2zEHZhDi3YD+qR' +
  'wD6maKcgIPs3PH8KDCRevU2bT1O2JP5pMITpmtjtJRs3lTNIm3x2xOOzbzyR0jFxnLSe13Npsss7ivmBTEkY2vwMIUN6wqfXUBkq' +
  '2Wg1g4pBTu3+PcI87q5xmcoayPp7oBRwf4bx8iG3zDdNugE8J0hgFh1R5UPsR/lmZkMKF3WJpaMlY1+M+bx+S4TYX8FG5hUJRiPJ' +
  'wONLvQ7laGWoIgUhBRC1952QfChg'
      , 'base64')
    const { header } = readHeader(OLD)
    expect(header.format).toBe(1)
    expect('protection' in header).toBe(false)
    const plain = Buffer.alloc(2500)
    for (let i = 0; i < plain.length; i++) plain[i] = i % 251
    expect((await unseal('FRMT1-FXTR0-396AB-CDEFG-HJKMN-PQRST', OLD)).equals(plain)).toBe(true)
    expect(await codeOf(unseal('FRMT1-FXTR0-396AB-CDEFG-HJKMN-PQRS0', OLD))).toBe('wrong_key')
    expect(await codeOf(unseal(null, OLD))).toBe('key_needed')
  })
})

describe('an open backup of a whole install', async () => {
  const A = populatedInstall('open-a')
  roots.push(A.root)
  // The fixture's store has a .backup-key: an open backup must not carry it.
  expect(existsSync(keyFilePath(A.storeDir))).toBe(true)
  const made = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: null, appCommit: 't', appVersion: '1.29.0' })

  it('is made, as format 2', () => {
    expect(made.ok, JSON.stringify(made)).toBe(true)
    expect(isOpenBackup(readHeader(made.file!).header)).toBe(true)
  })

  it('does not carry store/.backup-key', async () => {
    const dir = mkdtempSync(join(A.root, 'x-'))
    const { manifest } = await extractBackup(made.file!, null, dir)
    expect(manifest.files.some((f) => f.path.endsWith('.backup-key'))).toBe(false)
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    expect(walk(dir).some((p) => p.endsWith('.backup-key'))).toBe(false)
  })

  it('verifies (trial restore) with no key', async () => {
    const r = await verifyBackup({ file: made.file!, recoveryKey: null, scratchBase: mkdtempSync(join(A.root, 'scratch-')) })
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, stage: 'done' })
  })

  it('restores onto an empty install with no key at all, and makes no key there', async () => {
    const B = emptyInstall('open-b')
    roots.push(B.root)
    makeDb(join(B.storeDir, 'claudeclaw.db'), 0, 0)
    const ctx = { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }
    // What the page does: resolveKey says "no key needed" for this file.
    const key = resolveKey(B.storeDir, made.file!, null)
    expect(key).toBeNull()
    const ins = await inspectBackup({ file: made.file!, recoveryKey: key, ctx, appVersion: '1.29.0', currentDb: join(B.storeDir, 'claudeclaw.db') })
    const plan = buildRestorePlan({ id: 'open1', file: made.file!, stagingDir: ins.stagingDir, manifest: ins.manifest, ctx })
    const dbItem = plan.items.find((i) => i.category === 'database')!
    plan.pausedTaskIds = pauseStagedSchedules(dbItem.staged)
    const out = await runRestore(plan, { stop: () => {}, start: () => {}, sleep: async () => {} })
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true })
    const db = new Database(join(B.storeDir, 'claudeclaw.db'), { readonly: true })
    const n = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n
    expect([n('kanban_cards'), n('memories')]).toEqual([5, 7])
    db.close()
    expect(existsSync(keyFilePath(B.storeDir))).toBe(false)
  })
})

describe('a protected backup with no key on this machine is refused', async () => {
  const A = populatedInstall('open-keyed')
  roots.push(A.root)
  const key = generateRecoveryKey()
  const made = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, encrypt: { kdfN: 1024 }, appCommit: 't', appVersion: '1.29.0' })
  const B = emptyInstall('open-keyed-b')
  roots.push(B.root)

  it('asks for the key, names its id, and stages nothing', async () => {
    let err: unknown
    try { resolveKey(B.storeDir, made.file!, null) } catch (e) { err = e }
    expect(err).toBeInstanceOf(RestoreError)
    expect((err as RestoreError).code).toBe('key_needed')
    expect((err as RestoreError).vars.keyId).toBe(headerKeyId(readHeader(made.file!).header))
    const ctx = { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }
    expect(await codeOf(inspectBackup({ file: made.file!, recoveryKey: null, ctx, appVersion: '1.29.0', currentDb: null }))).toBe('key_needed')
    expect(existsSync(join(B.storeDir, 'tmp')) ? readdirSync(join(B.storeDir, 'tmp')) : []).toEqual([])
  })

  it('the typed key opens it', () => {
    expect(resolveKey(B.storeDir, made.file!, key)).toBe(key)
  })
})

describe('every backup follows the choice', () => {
  function deps(f: ReturnType<typeof emptyInstall>): DestinationDeps {
    return { storeDir: f.storeDir, depotRoot: () => null, depotBackupDir: () => null, lang: 'hu' }
  }

  it('default: protected -- the key is created on first use', () => {
    const f = emptyInstall('choice-default'); roots.push(f.root)
    expect(readConfig(f.storeDir).protection).toBe('key')
    const k = backupKeyFor(f.storeDir)
    expect(k).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){5}$/)
    expect(existsSync(keyFilePath(f.storeDir))).toBe(true)
  })

  it('a damaged or unknown value stays protected', () => {
    const f = emptyInstall('choice-bad'); roots.push(f.root)
    writeFileSync(join(f.storeDir, 'backup-config.json'), JSON.stringify({ protection: 'NONE' }))
    expect(readConfig(f.storeDir).protection).toBe('key')
  })

  it('"without a key": the daily run makes an open backup and never a key file', async () => {
    const f = emptyInstall('choice-open'); roots.push(f.root)
    makeDb(join(f.storeDir, 'claudeclaw.db'), 2, 1)
    writeConfig(f.storeDir, { ...defaultConfig(), protection: 'none' })
    const r = await runFullBackup({ kind: 'scheduled', ctx: f.ctx, recoveryKey: backupKeyFor(f.storeDir), deps: deps(f), appCommit: 't', appVersion: '1.29.0' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(isOpenBackup(readHeader(r.file!).header)).toBe(true)
    expect(existsSync(keyFilePath(f.storeDir))).toBe(false)
    expect(readState(f.storeDir).backups![r.name!]).toMatchObject({ kind: 'scheduled', keyId: null, open: true })
  })

  it('back to "with a key": the next daily run is protected again', async () => {
    const f = emptyInstall('choice-back'); roots.push(f.root)
    makeDb(join(f.storeDir, 'claudeclaw.db'), 2, 1)
    writeConfig(f.storeDir, { ...defaultConfig(), protection: 'key' })
    const r = await runFullBackup({ kind: 'scheduled', ctx: f.ctx, recoveryKey: backupKeyFor(f.storeDir), deps: deps(f), encrypt: { kdfN: 1024 }, appCommit: 't', appVersion: '1.29.0' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const h = readHeader(r.file!).header
    expect(isOpenBackup(h)).toBe(false)
    expect(headerKeyId(h)).toBe(getOrCreateKey(f.storeDir).keyId)
  })

  it('previous keys are kept only for protected backups still retained; open ones need none', async () => {
    const f = emptyInstall('choice-prune'); roots.push(f.root)
    makeDb(join(f.storeDir, 'claudeclaw.db'), 1, 1)
    const k1 = getOrCreateKey(f.storeDir)
    rotateKey(f.storeDir)
    writeConfig(f.storeDir, { ...defaultConfig(), protection: 'none' })
    // one protected backup made with the old key is still around
    writeFileSync(join(f.storeDir, 'backup-state.json'), JSON.stringify({ backups: { 'marveen-backup-20260901-030000-h.mbk': { kind: 'scheduled', keyId: k1.keyId, createdAt: 1 } } }))
    const r = await runFullBackup({ kind: 'manual', ctx: f.ctx, recoveryKey: backupKeyFor(f.storeDir), deps: deps(f), appCommit: 't', appVersion: '1.29.0' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(readKeyFile(f.storeDir)!.previous.map((k) => k.keyId)).toEqual([k1.keyId])
    // only open backups left: no retained backup needs the old key any more
    writeFileSync(join(f.storeDir, 'backup-state.json'), JSON.stringify({ backups: { [r.name!]: { kind: 'manual', keyId: null, open: true, createdAt: 2 } } }))
    await pruneAll({ ctx: f.ctx, deps: deps(f) })
    expect(readKeyFile(f.storeDir)!.previous).toEqual([])
  })

  it('the Overview does not nag about the kit while backups are open', () => {
    const f = emptyInstall('choice-health'); roots.push(f.root)
    getOrCreateKey(f.storeDir) // a key exists, never confirmed
    const now = Date.now()
    writeFileSync(join(f.storeDir, 'backup-state.json'), JSON.stringify({ lastSuccessAt: now - 1000, lastSuccessName: 'x', replicas: { depot: { at: now, ok: true, reachable: true, name: 'x' } } }))
    const dests: any = [{ id: 'local', kind: 'local', enabled: true, where: '' }, { id: 'depot', kind: 'depot', enabled: true, where: '' }]
    expect(computeBackupHealth({ storeDir: f.storeDir, destinations: dests, newestLocalMs: now, freshInstall: false, now }).id).toBe('backup_kit_unconfirmed')
    writeConfig(f.storeDir, { ...defaultConfig(), protection: 'none' })
    expect(computeBackupHealth({ storeDir: f.storeDir, destinations: dests, newestLocalMs: now, freshInstall: false, now }).id).toBe('backup_ok_copies')
  })
})
