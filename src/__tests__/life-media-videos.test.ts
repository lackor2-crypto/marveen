// #464 (Boss 2026-10-03): the `Média/Videók` folder is gone. Photos AND videos
// of one event live together under `Fotók`; the legacy folder is never planned
// again, and what is still inside it can be moved under `Fotók` -- without
// overwriting and without deleting anything.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-vid-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-vid-store-'))
process.env.MARVEEN_DEPOT = depot

// Never write to the live store/: the life config and the label registers live there.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const {
  planLifeTree, ensureLifeTree, defaultMediaKinds, MEDIA_KINDS, defaultCountrySplit,
} = await import('../life-tree.js')
const { planLegacyVideos, moveLegacyVideos } = await import('../life-media-videos.js')

const cfg = {
  persons: [
    {
      id: 'a', name: 'Teszt Elek', role: 'owner' as const,
      countries: [] as string[],
      countrySplit: defaultCountrySplit(),
      mediaKinds: defaultMediaKinds(),
      mediaGroups: ['Mykael család', 'Barátok'],
      projects: [],
    },
  ],
  companies: [{ id: 'c', name: 'Teszt Kft', countries: [] as string[], countrySplit: [] as string[] }],
}

const media = join(depot, 'Teszt Elek', 'Média')
const put = (rel: string, body = 'x') => {
  const abs = join(depot, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

beforeEach(() => {
  for (const n of ['Teszt Elek', 'Cégek', 'Média', 'Tudás', 'Digitális', 'Beérkező', 'Megosztott', 'Archív', 'Rendszer', 'Kuka']) {
    rmSync(join(depot, n), { recursive: true, force: true })
  }
})

describe('no Videók type folder is planned', () => {
  it('MEDIA_KINDS and the default have no videos', () => {
    expect([...MEDIA_KINDS]).not.toContain('videos')
    expect(defaultMediaKinds()).toEqual(['photos', 'audio', 'scans'])
  })

  it('a fresh tree has Fotók/<group> for the person and one Fotók for the company, never Videók', () => {
    const rels = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(rels).toContain('Teszt Elek/Média/Fotók/Mykael család')
    expect(rels).toContain('Cégek/Teszt Kft/Média/Fotók')
    expect(rels.some((r) => r.includes('Videók'))).toBe(false)
  })

  it('an old saved config that still lists videos does not bring the folder back', () => {
    const old = { ...cfg, persons: [{ ...cfg.persons[0], mediaKinds: ['photos', 'videos', 'audio'] }] }
    const rels = planLifeTree(old as any, 'hu').map((n) => n.rel)
    expect(rels.some((r) => r.includes('Videók'))).toBe(false)
    expect(rels).toContain('Teszt Elek/Média/Fotók/Mykael család')
  })

  it('"Create the structure" does not make a Videók folder on a fresh install', () => {
    const r = ensureLifeTree(cfg, 'hu')
    expect(r.failed).toEqual([])
    expect(existsSync(join(media, 'Fotók', 'Mykael család'))).toBe(true)
    expect(existsSync(join(media, 'Videók'))).toBe(false)
    expect(existsSync(join(depot, 'Cégek', 'Teszt Kft', 'Média', 'Videók'))).toBe(false)
  })
})

describe('the legacy Videók folder', () => {
  it('on a fresh install there is nothing to move', () => {
    ensureLifeTree(cfg, 'hu')
    const plan = planLegacyVideos(cfg, 'hu')
    expect(plan.moves).toEqual([])
    expect(plan.clashes).toEqual([])
    expect(plan.folders).toEqual([])
  })

  it('moves a video to the same family under Fotók, creating the event folder', () => {
    put('Teszt Elek/Média/Videók/Mykael család/Vállóper/b.mp4', 'video-b')
    const plan = planLegacyVideos(cfg, 'hu')
    expect(plan.moves).toEqual([{
      from: 'Teszt Elek/Média/Videók/Mykael család/Vállóper/b.mp4',
      to: 'Teszt Elek/Média/Fotók/Mykael család/Vállóper/b.mp4',
    }])
    const r = moveLegacyVideos(cfg, 'hu')
    expect(r.ok).toBe(true)
    expect(r.moved).toBe(1)
    expect(readFileSync(join(media, 'Fotók', 'Mykael család', 'Vállóper', 'b.mp4'), 'utf8')).toBe('video-b')
    expect(existsSync(join(media, 'Videók', 'Mykael család', 'Vállóper', 'b.mp4'))).toBe(false)
  })

  it('names a folder that would be NEW under Fotók, so a near-duplicate is never silent', () => {
    put('Teszt Elek/Média/Fotók/Jutka család/x.jpg')
    put('Teszt Elek/Média/Videók/Jutka családja/juci.mp4')
    put('Teszt Elek/Média/Videók/Jutka család/ok.mp4')
    const plan = planLegacyVideos(cfg, 'hu')
    expect(plan.newFolders).toEqual(['Teszt Elek/Média/Fotók/Jutka családja'])
  })

  it('NEVER overwrites a same-name file and never deletes: the clash stays, reported', () => {
    put('Teszt Elek/Média/Videók/Mykael család/a.mp4', 'LEGACY')
    put('Teszt Elek/Média/Fotók/Mykael család/a.mp4', 'ALREADY-THERE')
    put('Teszt Elek/Média/Videók/Barátok/c.mp4', 'video-c')
    const r = moveLegacyVideos(cfg, 'hu')
    expect(r.moved).toBe(1)
    expect(r.skipped.map((m) => m.from)).toEqual(['Teszt Elek/Média/Videók/Mykael család/a.mp4'])
    expect(readFileSync(join(media, 'Fotók', 'Mykael család', 'a.mp4'), 'utf8')).toBe('ALREADY-THERE')
    expect(readFileSync(join(media, 'Videók', 'Mykael család', 'a.mp4'), 'utf8')).toBe('LEGACY')
    // The emptied folders are left for the owner: nothing here deletes.
    expect(existsSync(join(media, 'Videók', 'Barátok'))).toBe(true)
    // A second run finds only the clash.
    const again = planLegacyVideos(cfg, 'hu')
    expect(again.moves).toEqual([])
    expect(again.clashes.length).toBe(1)
  })

  it('ignores Windows housekeeping files, so an "empty" folder reports nothing to move', () => {
    put('Teszt Elek/Média/Videók/Barátok/desktop.ini', '[.ShellClassInfo]')
    put('Teszt Elek/Média/Videók/Barátok/Thumbs.db', 'x')
    const plan = planLegacyVideos(cfg, 'hu')
    expect(plan.moves).toEqual([])
    expect(plan.clashes).toEqual([])
    expect(plan.folders).toEqual([])
  })

  it('covers a company too', () => {
    put('Cégek/Teszt Kft/Média/Videók/bemutato.mp4', 'v')
    const r = moveLegacyVideos(cfg, 'hu')
    expect(r.moved).toBe(1)
    expect(existsSync(join(depot, 'Cégek', 'Teszt Kft', 'Média', 'Fotók', 'bemutato.mp4'))).toBe(true)
  })
})
