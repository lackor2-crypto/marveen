// Card #360 -- the MEGA upload tried with the REAL rclone binary, but against a
// LOCAL remote (a temp folder). Owner, 2026-09-25: "Kipróbálni kipróbálhatja,
// hogy működik-e, de ne kezdje el a feltöltést." So no test here can reach a
// MEGA account: every call's --config is swapped for a temp config whose only
// remote is `type = local`, and a call without --config fails the test.
//
// Measured with the real binary (the mock tests in mega-backup.test.ts cannot):
//   1. the exact previewed list arrives, nothing else;
//   2. a second upload of the same list leaves the target unchanged;
//   3. a file already on the target that is NOT in the list survives (copy,
//      never sync).
// Skipped where rclone is not installed (CI runner).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rcloneBin, type Runner } from '../mega.js'
import { setMegaBackupStoreForTests, walkForMega, runMegaUpload, longRunner, MEGA_BACKUP_DIR, MEGA_MIRROR, listMegaRemote, megaRemoteDir, planMegaBackup, loadMegaState } from '../mega-backup.js'
import { excludeRules } from '../backup-exclude.js'

const bin = rcloneBin()
const root = mkdtempSync(join(tmpdir(), 'marveen-megalocal-'))
const base = join(root, 'depot')
const target = join(root, 'target')
const conf = join(root, 'rclone.conf')
writeFileSync(conf, '[mega_t]\ntype = local\n')

/** The real rclone, pointed at the local-only config. */
const run: Runner = (b, args, input) => {
  const i = args.indexOf('--config')
  if (i < 0) throw new Error('rclone call without --config: could reach a real account')
  const safe = [...args]
  safe[i + 1] = conf
  // `mega_t:<dir>` -> the temp folder; any other remote name is refused.
  const j = safe.findIndex((a) => /^[\w-]+:/.test(a))
  if (j >= 0) {
    if (!safe[j].startsWith('mega_t:')) throw new Error(`unexpected remote ${safe[j]}`)
    const rest = safe[j].slice('mega_t:'.length)
    safe[j] = 'mega_t:' + (rest ? join(target, rest) : target)
  }
  return longRunner(b, safe, input)
}

function put(rel: string, body: string): void {
  const p = join(base, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

beforeEach(() => {
  for (const d of [base, target, join(root, 'store')]) rmSync(d, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  setMegaBackupStoreForTests(join(root, 'store'))
})
afterAll(() => {
  setMegaBackupStoreForTests(null)
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!bin)('MEGA upload with the real rclone against a local remote (#360)', () => {
  const up = (files = walkForMega(base, excludeRules([])).files) =>
    runMegaUpload({ bin: bin!, remote: 'mega_t', account: 't', path: 'P', base, files, run })
  const dest = (rel: string) => join(target, MEGA_BACKUP_DIR, 'P', rel)

  it('uploads exactly the previewed list and records every arrival', async () => {
    put('a.txt', 'alpha')
    put('sub/b.txt', 'beta')
    put('skip.txt', 'not in the list')
    const files = walkForMega(base, excludeRules([])).files.filter((f) => f.rel !== 'skip.txt')
    const r = await up(files)
    expect(r).toEqual({ uploaded: 2, failed: [], error: null })
    expect(readFileSync(dest('a.txt'), 'utf-8')).toBe('alpha')
    expect(readFileSync(dest('sub/b.txt'), 'utf-8')).toBe('beta')
    expect(existsSync(dest('skip.txt'))).toBe(false)
  }, 60_000)

  it('copy, never sync: a file only on the target survives a second upload', async () => {
    put('a.txt', 'alpha')
    await up()
    mkdirSync(join(target, MEGA_BACKUP_DIR, 'P'), { recursive: true })
    writeFileSync(dest('only-there.txt'), 'keep me')
    const r = await up()
    expect(r.error).toBeNull()
    expect(readFileSync(dest('only-there.txt'), 'utf-8')).toBe('keep me')
    expect(readFileSync(dest('a.txt'), 'utf-8')).toBe('alpha')
  }, 60_000)
})

describe.skipIf(!bin)('account-root mirror with the real rclone against a local remote (#360)', () => {
  it('goes to the ROOT in the same layout, and never overwrites a file Marveen did not upload', async () => {
    put('Docs/a.txt', 'alpha')
    put('theirs.txt', 'local version')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'theirs.txt'), 'put there on the MEGA website')
    const ex = excludeRules([MEGA_BACKUP_DIR])
    const remote = await listMegaRemote(bin!, megaRemoteDir('mega_t', MEGA_MIRROR), run)
    expect(remote.ok).toBe(true)
    const plan = planMegaBackup(walkForMega(base, ex), loadMegaState('t', MEGA_MIRROR).state, remote.ok ? remote.files : new Set(), ex, { keepRemoteUntracked: true })
    expect(plan.remoteUntracked).toEqual(['theirs.txt'])
    const r = await runMegaUpload({ bin: bin!, remote: 'mega_t', account: 't', path: MEGA_MIRROR, base, files: plan.upload, run })
    expect(r).toEqual({ uploaded: 1, failed: [], error: null })
    expect(readFileSync(join(target, 'Docs', 'a.txt'), 'utf-8')).toBe('alpha')
    expect(readFileSync(join(target, 'theirs.txt'), 'utf-8')).toBe('put there on the MEGA website')
  }, 60_000)
})

