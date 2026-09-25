/**
 * #395 -- the Kuka lives at the tree root (`<root>/Kuka`), not under
 * `Rendszer/Kuka` (Boss TG 1608). One place says where it is
 * (`trashRelPath()`), an old install is migrated at startup without
 * overwriting anything, the Kuka itself cannot be renamed / moved / trashed,
 * and the walkers leave its contents out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-kuka-root-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-kuka-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const {
  trashLife, purgeLife, renameLife, moveLife, autoPurgeTrash, migrateLegacyTrash, searchLife, listLife, explorerRoot, kukaBelyeg,
} = await import('../life-explorer.js')
const { trashRelPath, legacyTrashRelPath, isInTrash, planLifeTree } = await import('../life-tree.js')
const { findRepos } = await import('../git-sync.js')
const { mentesKihagyUt, mentesAgHiba } = await import('../web/routes/drive-sync.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

const KUKA = trashRelPath('hu')
const REGI = legacyTrashRelPath('hu')

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
})

describe('the Kuka path is defined in one place', () => {
  it('is at the tree root, in both languages', () => {
    expect(trashRelPath('hu')).toBe('Kuka')
    expect(trashRelPath('en')).toBe('Trash')
    expect(legacyTrashRelPath('hu')).toBe('Rendszer/Kuka')
  })

  it('isInTrash covers the Kuka and what is inside, nothing else', () => {
    expect(isInTrash('Kuka', 'hu')).toBe(true)
    expect(isInTrash('Kuka/2026-01-01_00-00-00/x', 'hu')).toBe(true)
    expect(isInTrash('Kukacska', 'hu')).toBe(false)
    expect(isInTrash('Rendszer/Kuka', 'hu')).toBe(false)
  })

  it('a fresh install plans it at the root', () => {
    const plan = planLifeTree({ persons: [], companies: [] } as any, 'hu').map((n) => n.rel)
    expect(plan).toContain('Kuka')
    expect(plan).not.toContain('Rendszer/Kuka')
  })

  it('the listing tells the UI where it is', () => {
    expect(listLife('').trashRel).toBe('Kuka')
  })
})

describe('trash / purge / auto-empty at the new place', () => {
  it('trashLife moves into <root>/Kuka/<stamp>/', () => {
    writeFileSync(join(root, 'Beérkező', 'a.txt'), 'A')
    const r = trashLife('Beérkező/a.txt')
    expect(r.ok).toBe(true)
    expect(r.rel.startsWith('Kuka/')).toBe(true)
    expect(existsSync(join(root, 'Rendszer', 'Kuka'))).toBe(false)
  })

  it('purging the Kuka empties it and keeps the folder', () => {
    writeFileSync(join(root, 'Beérkező', 'a.txt'), 'A')
    trashLife('Beérkező/a.txt')
    const r = purgeLife(KUKA)
    expect(r.ok).toBe(true)
    expect(readdirSync(join(root, KUKA))).toEqual([])
  })

  it('auto-empty works at the root Kuka', () => {
    mkdirSync(join(root, KUKA, '2020-01-01_10-00-00', 'regi'), { recursive: true })
    expect(autoPurgeTrash(30).torolt).toBe(1)
  })
})

describe('the Kuka itself cannot be renamed, moved or trashed', () => {
  beforeEach(() => { mkdirSync(join(root, KUKA), { recursive: true }) })

  it('rename is refused', () => {
    const r = renameLife(KUKA, 'Szemet')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('trash_itself')
    expect(existsSync(join(root, KUKA))).toBe(true)
  })

  it('move is refused', () => {
    const r = moveLife(KUKA, 'Beérkező')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('trash_itself')
    expect(existsSync(join(root, KUKA))).toBe(true)
  })

  it('trash is refused', () => {
    const r = trashLife(KUKA)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('trash_itself')
  })

  it('the refusal speaks both languages', () => {
    expect(renameLife(KUKA, 'x', 'en').message).toMatch(/Trash cannot be renamed/)
    expect(renameLife(KUKA, 'x', 'hu').message).toMatch(/Kukát nem lehet/)
  })
})

describe('startup migration from Rendszer/Kuka', () => {
  it('moves everything, never overwrites, removes the empty old folder', () => {
    mkdirSync(join(root, REGI, '2026-01-01_00-00-00'), { recursive: true })
    writeFileSync(join(root, REGI, '2026-01-01_00-00-00', 'x.txt'), 'REGI')
    writeFileSync(join(root, REGI, 'ugyanaz.txt'), 'REGI')
    mkdirSync(join(root, KUKA), { recursive: true })
    writeFileSync(join(root, KUKA, 'ugyanaz.txt'), 'UJ')

    const r = migrateLegacyTrash()
    expect(r).toEqual({ moved: 2, failed: 0, removedOld: true })
    expect(existsSync(join(root, REGI))).toBe(false)
    expect(readFileSync(join(root, KUKA, '2026-01-01_00-00-00', 'x.txt'), 'utf8')).toBe('REGI')
    // the collision kept BOTH
    expect(readFileSync(join(root, KUKA, 'ugyanaz.txt'), 'utf8')).toBe('UJ')
    expect(readFileSync(join(root, KUKA, 'ugyanaz (2).txt'), 'utf8')).toBe('REGI')
    // the Rendszer branch itself stays
    expect(existsSync(join(root, 'Rendszer'))).toBe(true)
  })

  it('is idempotent: a second run does nothing', () => {
    mkdirSync(join(root, REGI), { recursive: true })
    writeFileSync(join(root, REGI, 'a.txt'), 'A')
    migrateLegacyTrash()
    expect(migrateLegacyTrash()).toEqual({ moved: 0, failed: 0, removedOld: false })
    expect(readdirSync(join(root, KUKA))).toEqual(['a.txt'])
  })

  it('an empty old Kuka is just removed', () => {
    mkdirSync(join(root, REGI), { recursive: true })
    expect(migrateLegacyTrash()).toEqual({ moved: 0, failed: 0, removedOld: true })
    expect(existsSync(join(root, REGI))).toBe(false)
  })
})

describe('walkers leave the Kuka out', () => {
  beforeEach(() => {
    mkdirSync(join(root, KUKA, '2026-01-01_00-00-00', 'kidobott-projekt', '.git'), { recursive: true })
    writeFileSync(join(root, KUKA, '2026-01-01_00-00-00', 'kidobott-level.txt'), 'x')
    writeFileSync(join(root, 'Beérkező', 'megtartott-level.txt'), 'x')
    mkdirSync(join(root, 'Beérkező', 'elo-projekt', '.git'), { recursive: true })
  })

  it('search from the root does not return Kuka items', () => {
    const names = searchLife('', 'level').entries.map((e) => e.name)
    expect(names).toContain('megtartott-level.txt')
    expect(names).not.toContain('kidobott-level.txt')
  })

  it('search started INSIDE the Kuka still finds them', () => {
    const names = searchLife(KUKA, 'level').entries.map((e) => e.name)
    expect(names).toContain('kidobott-level.txt')
  })

  it('git pull does not find a repo thrown into the Kuka', async () => {
    const repos = (await findRepos()).map((p) => p.replace(root, ''))
    expect(repos.some((p) => p.includes('elo-projekt'))).toBe(true)
    expect(repos.some((p) => p.includes('kidobott-projekt'))).toBe(false)
  })

  it('the Drive backup of the whole depot skips the Kuka, and it cannot be a backup branch', () => {
    expect([...mentesKihagyUt('')]).toContain(KUKA)
    expect(mentesAgHiba(KUKA)).toBeTruthy()
    expect(mentesAgHiba('Beérkező')).toBeNull()
  })
})

describe('the stamp folder name is local time, not UTC', () => {
  it('names the folder by the machine clock', () => {
    const regi = process.env.TZ
    process.env.TZ = 'Europe/Budapest'
    try {
      // 18:50:42 UTC is 20:50:42 in Budapest summer time -- the user saw the UTC one.
      expect(kukaBelyeg(new Date('2026-09-25T18:50:42Z'))).toBe('2026-09-25_20-50-42')
    } finally {
      if (regi === undefined) delete process.env.TZ; else process.env.TZ = regi
    }
  })

  it('trashLife uses it', () => {
    writeFileSync(join(root, 'Beérkező', 'a.txt'), 'A')
    const elotte = kukaBelyeg(new Date())
    const r = trashLife('Beérkező/a.txt')
    const utana = kukaBelyeg(new Date())
    const stamp = r.rel.split('/')[1]
    expect(stamp >= elotte && stamp <= utana).toBe(true)
  })

  it('auto-empty reads local stamps back, and old UTC-named folders still count', () => {
    const nap = 24 * 60 * 60 * 1000
    const most = Date.now()
    mkdirSync(join(root, KUKA, kukaBelyeg(new Date(most - 31 * nap))), { recursive: true })
    mkdirSync(join(root, KUKA, kukaBelyeg(new Date(most - 29 * nap))), { recursive: true })
    const regiUtc = new Date(most - 40 * nap).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
    mkdirSync(join(root, KUKA, regiUtc), { recursive: true })
    const r = autoPurgeTrash(30, most)
    expect(r.torolt).toBe(2)
    expect(readdirSync(join(root, KUKA))).toEqual([kukaBelyeg(new Date(most - 29 * nap))])
  })
})
