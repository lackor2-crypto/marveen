// ARCHIVING IN PLACE (card 4f3471f1).
//
// What must hold:
//   - an archived item stays where it is, the list flags it and puts it LAST
//     in its own group (folders / files); switching it off restores the order,
//   - the mark follows a move and a rename, and goes away with the Trash,
//   - a fresh install has no archive branch and no marks,
//   - a damaged register is never overwritten (the marks are not lost).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-archived-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-archstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { setArchived, isArchived, moveArchivedPrefix, dropArchivedPrefix } = await import('../life-archived.js')
const { listLife, moveLife, renameLife, trashLife } = await import('../life-explorer.js')
const { planLifeTree } = await import('../life-tree.js')

function wipe(): void {
  for (const n of readdirSync(depot)) rmSync(join(depot, n), { recursive: true, force: true })
  for (const n of readdirSync(store)) rmSync(join(store, n), { recursive: true, force: true })
}

function seed(): void {
  mkdirSync(join(depot, 'Tudás', 'A mappa'), { recursive: true })
  mkdirSync(join(depot, 'Tudás', 'B mappa'), { recursive: true })
  mkdirSync(join(depot, 'Tudás', 'C mappa'), { recursive: true })
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(depot, 'Tudás', f), 'x', 'utf8')
}

beforeEach(() => { wipe(); seed() })

const names = (rel: string) => {
  const l = listLife(rel, { deep: false, lang: 'hu', content: false })
  return { folders: l.folders.map((f) => f.name), files: l.files.map((f) => f.name), l }
}

describe('store', () => {
  it('on / off / prefix move / drop', () => {
    expect(isArchived('Tudás/a.txt')).toBe(false)
    expect(setArchived('Tudás/A mappa', true).ok).toBe(true)
    expect(setArchived('Tudás/A mappa/x.txt', true).ok).toBe(true)
    expect(isArchived('Tudás/A mappa')).toBe(true)
    // A folder's mark does not grey its children by itself.
    expect(isArchived('Tudás/A mappa/y.txt')).toBe(false)
    expect(moveArchivedPrefix('Tudás/A mappa', 'Tudás/Z')).toBe(2)
    expect(isArchived('Tudás/Z/x.txt')).toBe(true)
    expect(isArchived('Tudás/A mappa')).toBe(false)
    // A prefix is a whole path segment: "Tudás/Z" must not catch "Tudás/Zeta".
    setArchived('Tudás/Zeta', true)
    expect(dropArchivedPrefix('Tudás/Z')).toBe(2)
    expect(isArchived('Tudás/Zeta')).toBe(true)
    expect(setArchived('Tudás/Zeta', false).ok).toBe(true)
    expect(isArchived('Tudás/Zeta')).toBe(false)
  })

  it('a damaged register is refused, not overwritten', () => {
    writeFileSync(join(store, 'life-archived.json'), '{broken', 'utf8')
    expect(isArchived('Tudás/a.txt')).toBe(false)
    expect(setArchived('Tudás/a.txt', true)).toMatchObject({ ok: false, code: 'store_corrupt' })
    expect(readFileSync(join(store, 'life-archived.json'), 'utf8')).toBe('{broken')
  })
})

describe('explorer list', () => {
  it('archived items are flagged and go last in their own group; off = back in place', () => {
    setArchived('Tudás/A mappa', true)
    setArchived('Tudás/a.txt', true)
    const on = names('Tudás')
    expect(on.folders).toEqual(['B mappa', 'C mappa', 'A mappa'])
    expect(on.files).toEqual(['b.txt', 'c.txt', 'a.txt'])
    expect(on.l.files.find((f) => f.name === 'a.txt')?.archived).toBe(true)
    expect(on.l.files.find((f) => f.name === 'b.txt')?.archived).toBe(false)

    setArchived('Tudás/A mappa', false)
    setArchived('Tudás/a.txt', false)
    const off = names('Tudás')
    expect(off.folders).toEqual(['A mappa', 'B mappa', 'C mappa'])
    expect(off.files).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('the mark follows a move and a rename, and goes with the Trash', () => {
    setArchived('Tudás/a.txt', true)
    expect(moveLife('Tudás/a.txt', 'Tudás/B mappa', 'hu').ok).toBe(true)
    expect(isArchived('Tudás/B mappa/a.txt')).toBe(true)
    expect(isArchived('Tudás/a.txt')).toBe(false)

    setArchived('Tudás/B mappa', true)
    const r = renameLife('Tudás/B mappa', 'Régi B', 'hu')
    expect(r.ok).toBe(true)
    expect(isArchived(r.rel)).toBe(true)
    expect(isArchived(`${r.rel}/a.txt`)).toBe(true)

    expect(trashLife(r.rel, 'hu').ok).toBe(true)
    expect(isArchived(r.rel)).toBe(false)
    expect(isArchived(`${r.rel}/a.txt`)).toBe(false)
  })
})

describe('fresh install', () => {
  it('no archive branch in the tree plan, and no register file until something is archived', () => {
    const rels = planLifeTree({ persons: [{ id: 'a', name: 'Teszt Elek', role: 'owner', countries: [], mediaGroups: [] }], companies: [{ id: 'c', name: 'Teszt Kft' }] } as any, 'hu')
      .map((n) => n.rel)
    expect(rels.some((r) => r === 'Archív' || r.startsWith('Archív/'))).toBe(false)
    expect(existsSync(join(store, 'life-archived.json'))).toBe(false)
    expect(names('Tudás').l.files.every((f) => f.archived === false)).toBe(true)
  })
})
