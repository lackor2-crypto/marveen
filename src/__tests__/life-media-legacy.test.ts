// #464 B (Boss 2026-10-03): the media type (photo/video/audio) is a search FILTER,
// not a folder. A fresh tree builds `Média/[ország/]csoport` with no type level;
// what still sits in the legacy Fotók/Videók/Audió folders moves UP under Média
// (no overwrite, no delete) and on success the config switches to the flat model.
// Szkennek (paperwork) is only counted, never moved.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-legmedia-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-legmedia-store-'))
process.env.MARVEEN_DEPOT = depot

// Never write to the live store/: the life config and the label registers live there.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const {
  planLifeTree, ensureLifeTree, defaultMediaKinds, MEDIA_KINDS, defaultCountrySplit,
} = await import('../life-tree.js')
const { planLegacyMedia, moveLegacyMedia, switchToFlatMedia } = await import('../life-media-legacy.js')

/** A fresh (flat) person: empty mediaKinds -> Média/[ország/]csoport. */
function flatCfg() {
  return {
    persons: [{
      id: 'a', name: 'Teszt Elek', role: 'owner' as const,
      countries: [] as string[], countrySplit: defaultCountrySplit(),
      mediaKinds: defaultMediaKinds(), // [] -> flat
      mediaGroups: ['Mykael család', 'Barátok'],
      projects: [],
    }],
    companies: [{ id: 'c', name: 'Teszt Kft', countries: [] as string[], countrySplit: [] as string[] }],
  }
}

/** A legacy person: explicit mediaKinds -> Média/Fotók/... until migrated. */
function legacyCfg() {
  const c = flatCfg()
  c.persons[0].mediaKinds = ['photos']
  return c
}

const media = join(depot, 'Teszt Elek', 'Média')
const put = (rel: string, body = 'x') => {
  const abs = join(depot, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

beforeEach(() => {
  for (const n of ['Teszt Elek', 'Cégek', 'Tudás', 'Digitális', 'Beérkező', 'Megosztott', 'Archív', 'Rendszer', 'Kuka']) {
    rmSync(join(depot, n), { recursive: true, force: true })
  }
})

describe('the flat media model (no type folder)', () => {
  it('MEDIA_KINDS stays photos (for legacy); the default is empty (flat)', async () => {
    expect([...MEDIA_KINDS]).toEqual(['photos'])
    expect(defaultMediaKinds()).toEqual([])
  })

  it('a fresh tree builds Média/<csoport> for the person and a single Média for the company, no type folder', async () => {
    const rels = planLifeTree(flatCfg(), 'hu').map((n) => n.rel)
    expect(rels).toContain('Teszt Elek/Média/Mykael család')
    expect(rels).toContain('Cégek/Teszt Kft/Média')
    for (const gone of ['Fotók', 'Videók', 'Audió', 'Szkennek']) {
      expect(rels.some((r) => r.includes(`/Média/${gone}`))).toBe(false)
    }
  })

  it('a legacy saved config (explicit mediaKinds) keeps Média/Fotók until migrated', async () => {
    const rels = planLifeTree(legacyCfg(), 'hu').map((n) => n.rel)
    expect(rels).toContain('Teszt Elek/Média/Fotók/Mykael család')
  })

  it('"Create the structure" makes Média/<csoport> on a fresh install, no type folder', async () => {
    const r = ensureLifeTree(flatCfg(), 'hu')
    expect(r.failed).toEqual([])
    expect(existsSync(join(media, 'Mykael család'))).toBe(true)
    for (const gone of ['Fotók', 'Videók', 'Audió', 'Szkennek']) {
      expect(existsSync(join(media, gone))).toBe(false)
    }
  })
})

describe('flattening the legacy type folders up under Média', () => {
  it('on a fresh flat install there is nothing to move', async () => {
    ensureLifeTree(flatCfg(), 'hu')
    const plan = await planLegacyMedia(flatCfg(), 'hu')
    expect(plan.moves).toEqual([])
    expect(plan.clashes).toEqual([])
    expect(plan.folders).toEqual([])
  })

  it('moves photos, a video and a recording straight under Média, keeping the group/event', async () => {
    put('Teszt Elek/Média/Fotók/Mykael család/a.jpg', 'photo-a')
    put('Teszt Elek/Média/Videók/Mykael család/Vállóper/b.mp4', 'video-b')
    put('Teszt Elek/Média/Audió/Barátok/hang.m4a', 'sound')
    const plan = await planLegacyMedia(flatCfg(), 'hu')
    const tos = plan.moves.map((m) => m.to).sort()
    expect(tos).toContain('Teszt Elek/Média/Mykael család/a.jpg')
    expect(tos).toContain('Teszt Elek/Média/Mykael család/Vállóper/b.mp4')
    expect(tos).toContain('Teszt Elek/Média/Barátok/hang.m4a')
    const r = await moveLegacyMedia(flatCfg(), 'hu')
    expect(r.ok).toBe(true)
    expect(r.moved).toBe(3)
    expect(readFileSync(join(media, 'Mykael család', 'a.jpg'), 'utf8')).toBe('photo-a')
    expect(readFileSync(join(media, 'Mykael család', 'Vállóper', 'b.mp4'), 'utf8')).toBe('video-b')
    expect(readFileSync(join(media, 'Barátok', 'hang.m4a'), 'utf8')).toBe('sound')
    // Source type folder is left on disk (nothing deletes).
    expect(existsSync(join(media, 'Fotók', 'Mykael család', 'a.jpg'))).toBe(false)
  })

  it('switches a legacy config to the flat model after a successful move', async () => {
    put('Teszt Elek/Média/Fotók/Mykael család/a.jpg')
    const cfg = legacyCfg()
    const r = await moveLegacyMedia(cfg, 'hu')
    expect(r.ok).toBe(true)
    expect(r.switched).toBe(true)
    expect(cfg.persons[0].mediaKinds).toEqual([])
    const rels = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(rels.some((rel) => /\/Média\/(Fotók|Videók|Audió|Szkennek)(\/|$)/.test(rel))).toBe(false)
  })

  it('names a folder that would be NEW under Média, so a near-duplicate is never silent', async () => {
    put('Teszt Elek/Média/Mykael család/x.jpg')
    put('Teszt Elek/Média/Videók/Mykael családja/juci.mp4')
    const plan = await planLegacyMedia(flatCfg(), 'hu')
    expect(plan.newFolders).toEqual(['Teszt Elek/Média/Mykael családja'])
  })

  it('NEVER overwrites a same-name file and never deletes: the clash stays, reported', async () => {
    put('Teszt Elek/Média/Videók/Mykael család/a.mp4', 'LEGACY')
    put('Teszt Elek/Média/Mykael család/a.mp4', 'ALREADY-THERE')
    put('Teszt Elek/Média/Videók/Barátok/c.mp4', 'video-c')
    const r = await moveLegacyMedia(flatCfg(), 'hu')
    expect(r.moved).toBe(1)
    expect(r.skipped.map((m) => m.from)).toEqual(['Teszt Elek/Média/Videók/Mykael család/a.mp4'])
    expect(readFileSync(join(media, 'Mykael család', 'a.mp4'), 'utf8')).toBe('ALREADY-THERE')
    expect(readFileSync(join(media, 'Videók', 'Mykael család', 'a.mp4'), 'utf8')).toBe('LEGACY')
    // The emptied folders are left for the owner: nothing here deletes.
    expect(existsSync(join(media, 'Videók', 'Barátok'))).toBe(true)
  })

  it('ignores Windows housekeeping files, so an "empty" folder reports nothing to move', async () => {
    put('Teszt Elek/Média/Videók/Barátok/desktop.ini', '[.ShellClassInfo]')
    put('Teszt Elek/Média/Videók/Barátok/Thumbs.db', 'x')
    const plan = await planLegacyMedia(flatCfg(), 'hu')
    expect(plan.moves).toEqual([])
    expect(plan.folders).toEqual([])
  })

  it('Szkennek is only COUNTED: paperwork is never moved or guessed a folder for', async () => {
    put('Teszt Elek/Média/Szkennek/Egyéb/szerzodes.pdf', 'paper')
    put('Teszt Elek/Média/Szkennek/Egyéb/szamla.pdf', 'paper2')
    const plan = await planLegacyMedia(flatCfg(), 'hu')
    expect(plan.scans).toBe(2)
    expect(plan.moves).toEqual([])
    const r = await moveLegacyMedia(flatCfg(), 'hu')
    expect(r.moved).toBe(0)
    expect(readFileSync(join(media, 'Szkennek', 'Egyéb', 'szerzodes.pdf'), 'utf8')).toBe('paper')
  })

  it('covers a company too: its Fotók content moves up to the company Média', async () => {
    put('Cégek/Teszt Kft/Média/Fotók/bemutato.mp4', 'v')
    const r = await moveLegacyMedia(flatCfg(), 'hu')
    expect(r.ok).toBe(true)
    expect(r.moved).toBe(1)
    expect(existsSync(join(depot, 'Cégek', 'Teszt Kft', 'Média', 'bemutato.mp4'))).toBe(true)
  })
})

describe('switchToFlatMedia', () => {
  it('empties non-empty mediaKinds and reports the change', async () => {
    const cfg = legacyCfg()
    expect(switchToFlatMedia(cfg)).toBe(true)
    expect(cfg.persons[0].mediaKinds).toEqual([])
    expect(switchToFlatMedia(cfg)).toBe(false)
  })
})
