// Sub-card e801eee8 (Boss TG 2200): the MEGA account comes down into its mirror folder.
// Every rclone call goes to a MOCK Runner: no test can reach a real account.
//
// Measured here:
//   1. a name that already exists locally is skipped (plan AND rclone --ignore-existing);
//   2. MEGA's Marveen-backup folder is not brought back down;
//   3. the download is `rclone copy` with an explicit list, never `sync`, never a --delete* flag;
//   4. a file that did not arrive is reported as failed;
//   5. the preview lists, an empty/missing account is not an error.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listMegaRemoteSized, planMegaDownload, runMegaDownload, walkMirrorForDownload } from '../mega-download.js'
import type { Runner } from '../mega.js'

const root = mkdtempSync(join(tmpdir(), 'marveen-megadown-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function local(dir: string, files: Record<string, string>): string {
  const base = join(root, dir)
  for (const [rel, body] of Object.entries(files)) {
    const p = join(base, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  mkdirSync(base, { recursive: true })
  return base
}

function mockRclone(remote: { Path: string; Size: number }[], opts: { fail?: boolean } = {}) {
  const calls: string[][] = []
  const run: Runner = async (_bin, args) => {
    calls.push(args)
    if (args[0] === 'lsjson') return { code: 0, stdout: JSON.stringify(remote), stderr: '' }
    return opts.fail ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('planMegaDownload', () => {
  it('skips names that exist locally and the Marveen-backup folder, offers the rest', () => {
    const base = local('plan', { 'a.txt': '1', 'sub/b.txt': '2' })
    const plan = planMegaDownload(
      [{ rel: 'a.txt', size: 1 }, { rel: 'sub/b.txt', size: 2 }, { rel: 'new.txt', size: 5 }, { rel: 'Marveen-backup/x.bin', size: 9 }],
      walkMirrorForDownload(base),
    )
    expect(plan.download.map((f) => f.rel)).toEqual(['new.txt'])
    expect(plan.downloadBytes).toBe(5)
    expect(plan.skippedExisting).toBe(2)
    expect(plan.skippedBackupDir).toBe(1)
  })

  it('an unreadable local folder is flagged incomplete (only rclone --ignore-existing protects then)', () => {
    const plan = planMegaDownload([{ rel: 'a.txt', size: 1 }], { files: [], truncated: false, unreachable: true })
    expect(plan.localIncomplete).toBe(true)
  })
})

describe('listMegaRemoteSized', () => {
  it('reads sizes; a missing folder is an empty account, not an error', async () => {
    const ok = await listMegaRemoteSized('rclone', 'm:', mockRclone([{ Path: 'a.txt', Size: 7 }]).run)
    expect(ok).toEqual({ ok: true, files: [{ rel: 'a.txt', size: 7 }] })
    const missing = await listMegaRemoteSized('rclone', 'm:', async () => ({ code: 3, stdout: '', stderr: 'directory not found' }))
    expect(missing).toEqual({ ok: true, files: [] })
    const bad = await listMegaRemoteSized('rclone', 'm:', async () => ({ code: 1, stdout: '', stderr: 'login failed' }))
    expect(bad.ok).toBe(false)
  })
})

describe('runMegaDownload', () => {
  it('is rclone copy with an explicit list and --ignore-existing: never sync, never a delete flag', async () => {
    const dest = local('run', {})
    const m = mockRclone([])
    await runMegaDownload({ bin: 'rclone', remote: 'm', dest, files: [{ rel: 'new.txt', size: 5 }], run: m.run, arrived: () => new Set(['new.txt']) })
    const copy = m.calls.find((c) => c[0] === 'copy')!
    expect(copy).toContain('--files-from-raw')
    expect(copy).toContain('--ignore-existing')
    expect(copy.some((a) => a === 'sync' || a.startsWith('--delete'))).toBe(false)
    expect(copy.slice(1, 3)).toEqual(['m:', dest])
  })

  it('reports files that did not arrive as failed, and the rclone error', async () => {
    const dest = local('fail', {})
    const m = mockRclone([], { fail: true })
    const r = await runMegaDownload({ bin: 'rclone', remote: 'm', dest, files: [{ rel: 'a', size: 1 }, { rel: 'b', size: 1 }], run: m.run, arrived: () => new Set(['a']) })
    expect(r.downloaded).toBe(1)
    expect(r.failed).toEqual(['b'])
    expect(r.error).toContain('boom')
  })

  it('an empty list calls nothing', async () => {
    const m = mockRclone([])
    const r = await runMegaDownload({ bin: 'rclone', remote: 'm', dest: root, files: [], run: m.run })
    expect(r).toEqual({ downloaded: 0, failed: [], error: null })
    expect(m.calls.length).toBe(0)
  })
})
