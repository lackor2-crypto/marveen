// Card #350, last part -- the MEGA upload of a backup rule.
//
// Owner, 2026-09-24: "de még ne töltsd fel semmit" -- so every rclone call here
// goes to a MOCK Runner; no test can reach a real account.
//
// Measured here:
//   1. new / changed files go up, unchanged ones do not;
//   2. a file deleted ON MEGA is not uploaded again;
//   3. a file deleted on the machine only reaches the confirmation queue, and
//      only from a complete picture, behind the percentage brake;
//   4. the upload is `rclone copy` with an explicit list -- never `sync`,
//      never a `--delete*` flag -- and only confirmed arrivals are recorded;
//   5. a yes/no answer: "no" never calls rclone, "yes" deletes one file.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setMegaBackupStoreForTests, walkForMega, planMegaBackup, runMegaUpload, loadMegaState, saveMegaState,
  syncMegaDeleteQueue, loadMegaDeleteQueue, decideMegaDelete, megaItemId, listMegaRemote, megaRemoteDir,
  megaRemoteFile, MEGA_MIRROR, type MegaBackupState,
} from '../mega-backup.js'
import { excludeRules } from '../backup-exclude.js'
import type { Runner } from '../mega.js'

const root = mkdtempSync(join(tmpdir(), 'marveen-megabk-'))
const storeDir = join(root, 'store')
const base = join(root, 'depot')
const none = excludeRules([])

function file(rel: string, body = 'x', mtime = 1_700_000_000): void {
  const p = join(base, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
  utimesSync(p, mtime, mtime)
}

/** A mock rclone: records every call; `remote` is what MEGA "has". */
function mockRclone(remote: Set<string>, opts: { failCopy?: boolean; arrive?: (rels: string[]) => string[] } = {}) {
  const calls: string[][] = []
  const run: Runner = async (_bin, args) => {
    calls.push(args)
    if (args[0] === 'lsjson') return { code: 0, stdout: JSON.stringify([...remote].map((Path) => ({ Path }))), stderr: '' }
    if (args[0] === 'copy') {
      const listFile = args[args.indexOf('--files-from-raw') + 1]
      const rels = readFileSync(listFile, 'utf-8').split('\n').filter(Boolean)
      for (const r of (opts.arrive ? opts.arrive(rels) : rels)) remote.add(r)
      return opts.failCopy ? { code: 1, stdout: '', stderr: 'upload failed: quota' } : { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'deletefile') { remote.delete(args[args.length - 1]); return { code: 0, stdout: '', stderr: '' } }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  return { run, calls }
}

beforeEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  setMegaBackupStoreForTests(storeDir)
})
afterAll(() => {
  setMegaBackupStoreForTests(null)
  rmSync(root, { recursive: true, force: true })
})

const st = (files: MegaBackupState['files'] = {}): MegaBackupState => ({ account: 'a', path: 'P', files })

describe('local walk', () => {
  it('applies folder and file-type exclusions, skips .part, reports an unreachable root', () => {
    file('keep.txt'); file('big.fxt'); file('Old/x.txt'); file('dl.part')
    const w = walkForMega(base, excludeRules(['Old', '*.fxt']))
    expect(w.files.map((f) => f.rel).sort()).toEqual(['keep.txt'])
    expect(w.unreachable).toBe(false)
    expect(walkForMega(join(root, 'missing'), none).unreachable).toBe(true)
  })

  it('a walk over the limit is truncated', () => {
    file('a'); file('b'); file('c')
    expect(walkForMega(base, none, 2).truncated).toBe(true)
  })
})

describe('plan', () => {
  it('fresh install: nothing recorded, nothing on MEGA -> everything uploads, nothing to delete', () => {
    file('a.txt', 'aa'); file('d/b.txt', 'bbb')
    const p = planMegaBackup(walkForMega(base, none), st(), new Set(), none)
    expect(p.upload.map((f) => f.rel).sort()).toEqual(['a.txt', 'd/b.txt'])
    expect(p.uploadBytes).toBe(5)
    expect(p.wouldDelete).toEqual([])
  })

  it('unchanged files stay, changed ones go up again', () => {
    file('same.txt', 'aa', 100); file('changed.txt', 'new-body', 200)
    const state = st({ 'same.txt': { size: 2, mtimeMs: 100_000, uploadedAt: 'x' }, 'changed.txt': { size: 3, mtimeMs: 100_000, uploadedAt: 'x' } })
    const p = planMegaBackup(walkForMega(base, none), state, new Set(['same.txt', 'changed.txt']), none)
    expect(p.upload.map((f) => f.rel)).toEqual(['changed.txt'])
  })

  it('a file deleted ON MEGA is not uploaded again', () => {
    file('gone-up.txt', 'aa', 100)
    const state = st({ 'gone-up.txt': { size: 2, mtimeMs: 100_000, uploadedAt: 'x' } })
    const p = planMegaBackup(walkForMega(base, none), state, new Set(), none)
    expect(p.upload).toEqual([])
    expect(p.remoteDeleted).toEqual(['gone-up.txt'])
  })

  it('a file deleted on the machine becomes a question, not a deletion', () => {
    file('here.txt')
    const state = st({ 'here.txt': { size: 1, mtimeMs: 1_700_000_000_000, uploadedAt: 'x' }, 'deleted.txt': { size: 9, mtimeMs: 1, uploadedAt: 'x' } })
    const p = planMegaBackup(walkForMega(base, none), state, new Set(['here.txt', 'deleted.txt']), none)
    expect(p.wouldDelete).toEqual([{ rel: 'deleted.txt', size: 9 }])
    expect(p.brake).toBe(false)
  })

  it('gone from both sides: only forgotten', () => {
    const p = planMegaBackup(walkForMega(base, none), st({ 'x.txt': { size: 1, mtimeMs: 1, uploadedAt: 'x' } }), new Set(), none)
    expect(p.forget).toEqual(['x.txt'])
    expect(p.wouldDelete).toEqual([])
  })

  it('a truncated walk concludes no deletion (brake 2)', () => {
    file('a'); file('b'); file('c')
    const state = st(Object.fromEntries(['a', 'b', 'c', 'x', 'y'].map((r) => [r, { size: 1, mtimeMs: 1, uploadedAt: 'x' }])))
    const p = planMegaBackup(walkForMega(base, none, 2), state, new Set(['a', 'b', 'c', 'x', 'y']), none)
    expect(p.truncated).toBe(true)
    expect(p.wouldDelete).toEqual([])
  })

  it('a mass disappearance fires the percentage brake (brake 3)', () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, { size: 1, mtimeMs: 1, uploadedAt: 'x' }]))
    const p = planMegaBackup(walkForMega(base, none), st(files), new Set(Object.keys(files)), none)
    expect(p.wouldDelete.length).toBe(20)
    expect(p.brake).toBe(true)
  })

  it('an exclusion added later is not a deletion', () => {
    const state = st({ 'old.fxt': { size: 1, mtimeMs: 1, uploadedAt: 'x' } })
    const ex = excludeRules(['*.fxt'])
    const p = planMegaBackup(walkForMega(base, ex), state, new Set(['old.fxt']), ex)
    expect(p.wouldDelete).toEqual([])
    expect(p.forget).toEqual([])
  })
})

describe('upload', () => {
  it('uses rclone copy with the exact list -- never sync, never a delete flag', async () => {
    file('a.txt'); file('b.txt')
    const { run, calls } = mockRclone(new Set())
    const files = walkForMega(base, none).files
    const r = await runMegaUpload({ bin: '/fake/rclone', remote: 'mega_a', account: 'a', path: 'P', base, files, run })
    expect(r).toEqual({ uploaded: 2, failed: [], error: null })
    const copy = calls.find((c) => c[0] === 'copy')!
    expect(copy).toContain('--files-from-raw')
    expect(copy).toContain(megaRemoteDir('mega_a', 'P'))
    for (const c of calls) {
      expect(c[0]).not.toBe('sync')
      expect(c.some((x) => /^--delete|^--max-delete|^purge$|^move$/.test(x))).toBe(false)
    }
    expect(Object.keys(loadMegaState('a', 'P').state.files).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('records only what really arrived; the rest is offered again', async () => {
    file('ok.txt'); file('lost.txt')
    const { run } = mockRclone(new Set(), { failCopy: true, arrive: (rels) => rels.filter((r) => r === 'ok.txt') })
    const r = await runMegaUpload({ bin: '/fake/rclone', remote: 'mega_a', account: 'a', path: 'P', base, files: walkForMega(base, none).files, run })
    expect(r.uploaded).toBe(1)
    expect(r.failed).toEqual(['lost.txt'])
    expect(r.error).toContain('quota')
    const again = planMegaBackup(walkForMega(base, none), loadMegaState('a', 'P').state, new Set(['ok.txt']), none)
    expect(again.upload.map((f) => f.rel)).toEqual(['lost.txt'])
  })

  it('a missing MEGA folder is a first backup, a login error is an error', async () => {
    const miss: Runner = async () => ({ code: 3, stdout: '', stderr: 'error listing: directory not found' })
    expect(await listMegaRemote('/fake', 'mega_a:x', miss)).toEqual({ ok: true, files: new Set() })
    const login: Runner = async () => ({ code: 1, stdout: '', stderr: 'couldn\'t login: Object (typically, node or user) not found' })
    expect((await listMegaRemote('/fake', 'mega_a:x', login)).ok).toBe(false)
  })

  it('an unreadable record is reported, never read as "empty"', () => {
    saveMegaState(st({ 'a': { size: 1, mtimeMs: 1, uploadedAt: 'x' } }))
    writeFileSync(join(storeDir, 'mega-backup', readdirSync(join(storeDir, 'mega-backup'))[0]), '{broken')
    expect(loadMegaState('a', 'P').broken).toBeTruthy()
  })
})

describe('deletion queue', () => {
  it('"no" never calls rclone; the file stops being tracked and stays on MEGA', async () => {
    saveMegaState(st({ 'd.txt': { size: 1, mtimeMs: 1, uploadedAt: 'x' } }))
    syncMegaDeleteQueue('a', 'P', [{ rel: 'd.txt', size: 1 }])
    const { run, calls } = mockRclone(new Set(['d.txt']))
    const r = await decideMegaDelete({ id: megaItemId('a', 'P', 'd.txt'), yes: false, bin: '/fake', remoteOf: () => 'mega_a', run })
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(loadMegaDeleteQueue().items).toEqual([])
    expect(loadMegaState('a', 'P').state.files).toEqual({})
  })

  it('"yes" deletes exactly that one file with deletefile', async () => {
    saveMegaState(st({ 'd.txt': { size: 1, mtimeMs: 1, uploadedAt: 'x' } }))
    syncMegaDeleteQueue('a', 'P', [{ rel: 'd.txt', size: 1 }])
    const { run, calls } = mockRclone(new Set(['d.txt']))
    await decideMegaDelete({ id: megaItemId('a', 'P', 'd.txt'), yes: true, bin: '/fake', remoteOf: () => 'mega_a', run })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('deletefile')
    expect(calls[0][calls[0].length - 1]).toBe('mega_a:Marveen-backup/P/d.txt')
  })

  it('a re-sync keeps the first-seen time and drops what came back', () => {
    syncMegaDeleteQueue('a', 'P', [{ rel: 'x', size: 1 }, { rel: 'y', size: 1 }], '2026-01-01')
    syncMegaDeleteQueue('a', 'P', [{ rel: 'x', size: 1 }], '2026-02-02')
    const items = loadMegaDeleteQueue().items
    expect(items.map((i) => [i.rel, i.detectedAt])).toEqual([['x', '2026-01-01']])
  })

  it('an unreadable queue is never overwritten', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'mega-delete-queue.json'), '{broken')
    expect(syncMegaDeleteQueue('a', 'P', [{ rel: 'x', size: 1 }])).toBe(0)
    expect(loadMegaDeleteQueue().broken).toBeTruthy()
  })
})

describe('account-root mirror (#360: by hand, into the account root)', () => {
  it('the mirror key points at the account ROOT, a rule at Marveen-backup/<path>', () => {
    expect(megaRemoteDir('mega_a', MEGA_MIRROR)).toBe('mega_a:')
    expect(megaRemoteDir('mega_a', 'Projektek')).toBe('mega_a:Marveen-backup/Projektek')
    expect(megaRemoteFile('mega_a:', 'x/y.txt')).toBe('mega_a:x/y.txt')
    expect(megaRemoteFile('mega_a:Marveen-backup/P', 'y.txt')).toBe('mega_a:Marveen-backup/P/y.txt')
  })

  it('a file already on MEGA that Marveen never uploaded is NOT overwritten', () => {
    file('mine.txt'); file('theirs.txt')
    const walk = walkForMega(base, none)
    const plan = planMegaBackup(walk, st(), new Set(['theirs.txt']), none, { keepRemoteUntracked: true })
    expect(plan.upload.map((f) => f.rel)).toEqual(['mine.txt'])
    expect(plan.remoteUntracked).toEqual(['theirs.txt'])
    // A rule upload keeps the old behaviour (its folder is Marveen's own).
    expect(planMegaBackup(walk, st(), new Set(['theirs.txt']), none).upload.map((f) => f.rel).sort()).toEqual(['mine.txt', 'theirs.txt'])
  })

  it('"yes" on a mirror file deletes exactly that file at the account root', async () => {
    const remote = new Set(['a/gone.txt'])
    const { run, calls } = mockRclone(remote)
    syncMegaDeleteQueue('a', MEGA_MIRROR, [{ rel: 'a/gone.txt', size: 1 }])
    const r = await decideMegaDelete({ id: megaItemId('a', MEGA_MIRROR, 'a/gone.txt'), yes: true, bin: '/fake/rclone', remoteOf: () => 'mega_a', run })
    expect(r).toEqual({ ok: true })
    expect(calls[0][0]).toBe('deletefile')
    expect(calls[0][calls[0].length - 1]).toBe('mega_a:a/gone.txt')
  })
})

