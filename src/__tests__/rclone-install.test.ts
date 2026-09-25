// #360: rclone from the UI on a fresh install -- download, checksum, unpack
// into ~/.local/bin. Never reaches the network: fetch and unzip are stubs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checksumFor, installRclone, parseRcloneVersion, rcloneTarget, RCLONE_DOWNLOADS } from '../rclone-install.js'

const ZIP = Buffer.from('fake-zip-bytes')
const SHA = createHash('sha256').update(ZIP).digest('hex')
const NAME = 'rclone-v1.75.1-linux-amd64.zip'

function fakeFetch(opts: { sums?: string; version?: string; zipStatus?: number } = {}): typeof fetch {
  return (async (url: string) => {
    const u = String(url)
    const ok = (body: string | Buffer, status = 200) => ({
      ok: status < 400, status,
      text: async () => String(body),
      arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) },
    })
    if (u === `${RCLONE_DOWNLOADS}/version.txt`) return ok(opts.version ?? 'rclone v1.75.1\n')
    if (u.endsWith('/SHA256SUMS')) return ok(opts.sums ?? `${SHA}  ${NAME}\n`)
    if (u.endsWith(NAME)) return ok(ZIP, opts.zipStatus ?? 200)
    return ok('', 404)
  }) as unknown as typeof fetch
}

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rclone-home-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const unzipOk = async (_zip: string, member: string, dest: string) => {
  expect(member).toBe('rclone-v1.75.1-linux-amd64/rclone')
  writeFileSync(join(dest, 'rclone'), '#!/bin/sh\necho rclone v1.75.1\n')
  return { ok: true, detail: '' }
}

describe('rclone install (#360)', () => {
  it('maps Linux and macOS to the publisher file names, refuses the rest', () => {
    expect(rcloneTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'amd64' })
    expect(rcloneTarget('darwin', 'arm64')).toEqual({ os: 'osx', arch: 'arm64' })
    expect(rcloneTarget('win32', 'x64')).toBeNull()
    expect(rcloneTarget('linux', 'ia32')).toBeNull()
  })

  it('reads the version and the checksum line exactly', () => {
    expect(parseRcloneVersion('rclone v1.75.1\n')).toBe('v1.75.1')
    expect(parseRcloneVersion('<html>error</html>')).toBeNull()
    expect(checksumFor(`${SHA}  other.zip\n${SHA}  ${NAME}\n`, NAME)).toBe(SHA)
    expect(checksumFor(`${SHA}  ${NAME}.sig\n`, NAME)).toBeNull()
  })

  it('installs into ~/.local/bin, executable, after the checksum matches', async () => {
    const r = await installRclone({ fetchImpl: fakeFetch(), unzip: unzipOk, home, platform: 'linux', arch: 'x64' })
    expect(r).toEqual({ ok: true, version: 'v1.75.1', path: join(home, '.local', 'bin', 'rclone') })
    const dest = join(home, '.local', 'bin', 'rclone')
    expect(readFileSync(dest, 'utf-8')).toContain('rclone')
    expect(statSync(dest).mode & 0o111).not.toBe(0)
  })

  it('a checksum mismatch installs NOTHING', async () => {
    const r = await installRclone({ fetchImpl: fakeFetch({ sums: `${'0'.repeat(64)}  ${NAME}\n` }), unzip: unzipOk, home, platform: 'linux', arch: 'x64' })
    expect(r).toMatchObject({ ok: false, code: 'checksum_mismatch' })
    expect(existsSync(join(home, '.local', 'bin', 'rclone'))).toBe(false)
  })

  it('a file missing from SHA256SUMS installs nothing', async () => {
    const r = await installRclone({ fetchImpl: fakeFetch({ sums: '' }), unzip: unzipOk, home, platform: 'linux', arch: 'x64' })
    expect(r).toMatchObject({ ok: false, code: 'checksum_missing' })
    expect(existsSync(join(home, '.local', 'bin', 'rclone'))).toBe(false)
  })

  it('an unreadable version.txt is its own error, not a download failure', async () => {
    const r = await installRclone({ fetchImpl: fakeFetch({ version: 'nope' }), unzip: unzipOk, home, platform: 'linux', arch: 'x64' })
    expect(r).toMatchObject({ ok: false, code: 'version_failed' })
  })

  it('a broken download and a failed unpack say so', async () => {
    const d = await installRclone({ fetchImpl: fakeFetch({ zipStatus: 503 }), unzip: unzipOk, home, platform: 'linux', arch: 'x64' })
    expect(d).toMatchObject({ ok: false, code: 'download_failed' })
    const u = await installRclone({ fetchImpl: fakeFetch(), unzip: async () => ({ ok: false, detail: 'unzip: not found' }), home, platform: 'linux', arch: 'x64' })
    expect(u).toMatchObject({ ok: false, code: 'unzip_failed', detail: 'unzip: not found' })
    expect(existsSync(join(home, '.local', 'bin', 'rclone'))).toBe(false)
  })

  it('an unsupported platform never touches the network', async () => {
    let called = false
    const f = (async () => { called = true; throw new Error('no') }) as unknown as typeof fetch
    const r = await installRclone({ fetchImpl: f, unzip: unzipOk, home, platform: 'win32', arch: 'x64' })
    expect(r).toMatchObject({ ok: false, code: 'unsupported_platform' })
    expect(called).toBe(false)
  })

  it('every server error code has a HU and an EN sentence', () => {
    const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
    const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
    for (const c of ['unsupported_platform', 'version_failed', 'download_failed', 'checksum_missing', 'checksum_mismatch', 'unzip_failed', 'write_failed', 'busy', 'unknown']) {
      expect(hu).toContain(`'mega.rclone_err_${c}'`)
      expect(en).toContain(`'mega.rclone_err_${c}'`)
    }
  })
})
