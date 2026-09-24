// A projekt mappa-utja koveti a szemelyek gyujtomappajat (kanban #359).
//
// Mert: a "Csalad" koltoztetes utan (#270) minden projekt a regi, mar nem
// letezo helyre mutatott, es a Fajlok ful "nincs meg a mappa"-t mondott.
//   - a koltoztetes a projekt folder_path-jat is viszi (elotag-csere, a
//     hasonlo nevu szomszed NEM valtozik),
//   - az inditaskori javitas CSAK akkor ir, ha a regi hely nincs meg es az uj
//     pontosan megvan; a meglevo, jo utat nem bantja.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-pfollow-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-pfstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, APP_LANG: 'hu' }
})

const { initDatabase } = await import('../db.js')
const { createProject, getProject } = await import('../projects.js')
const { saveLifeConfig, normalizeLifeConfig, ensureLifeTree } = await import('../life-tree.js')
const { planPersonsGroupMove, applyPersonsGroupMove } = await import('../life-persons-group.js')
const { moveProjectFoldersPrefix, healProjectFoldersForPersonsGroup } = await import('../project-folder-follow.js')

const person = (id: string, name: string) => ({ id, name, role: 'owner' as const, countries: [], mediaGroups: [] })
const flat = { persons: [person('a', 'Teszt Elek')], companies: [] }
const grouped = { ...flat, personsGroup: 'Család' }

beforeEach(() => {
  initDatabase(':memory:')
  for (const d of [depot, store]) for (const n of readdirSync(d)) rmSync(join(d, n), { recursive: true, force: true })
})

function proj(name: string, folder: string) {
  mkdirSync(join(depot, ...folder.split('/')), { recursive: true })
  const r = createProject({ name, folder_path: folder })
  if (!r.ok) throw new Error(r.code)
  return r.project.id
}

describe('projekt mappa-ut koveti az eletfat', () => {
  it('elotag-csere: a projekt alatta kovet, a hasonlo nevu szomszed nem', () => {
    const a = proj('A', 'Teszt Elek/Projektek/Tőzsde')
    const b = proj('B', 'Teszt Elekné/Projektek')
    const c = proj('C', 'Teszt Elek')
    expect(moveProjectFoldersPrefix('Teszt Elek', 'Család/Teszt Elek')).toBe(2)
    expect(getProject(a)!.folder_path).toBe('Család/Teszt Elek/Projektek/Tőzsde')
    expect(getProject(b)!.folder_path).toBe('Teszt Elekné/Projektek')
    expect(getProject(c)!.folder_path).toBe('Család/Teszt Elek')
  })

  it('a Csalad-koltoztetes a projektet is viszi', () => {
    ensureLifeTree(normalizeLifeConfig(flat), 'hu')
    const a = proj('A', 'Teszt Elek/Projektek/Web')
    const r = applyPersonsGroupMove(planPersonsGroupMove(normalizeLifeConfig(flat), normalizeLifeConfig(grouped), 'hu'))
    expect(r.ok).toBe(true)
    expect(getProject(a)!.folder_path).toBe('Család/Teszt Elek/Projektek/Web')
  })

  it('inditaskori javitas: csak a regi-nincs + uj-megvan esetet irja at', () => {
    saveLifeConfig(normalizeLifeConfig(grouped))
    const broken = proj('Broken', 'Család/Teszt Elek/Projektek/Tőzsde')
    const ok = proj('Ok', 'Cégek/Valami')
    const gone = proj('Gone', 'Teszt Elek/Projektek/Eltunt')
    rmSync(join(depot, 'Teszt Elek'), { recursive: true, force: true })
    moveProjectFoldersPrefix('Család/Teszt Elek/Projektek/Tőzsde', 'Teszt Elek/Projektek/Tőzsde') // visszaallitjuk a hibas allapotot
    const out = healProjectFoldersForPersonsGroup()
    expect(out.fixed).toEqual([{ id: broken, from: 'Teszt Elek/Projektek/Tőzsde', to: 'Család/Teszt Elek/Projektek/Tőzsde' }])
    expect(getProject(broken)!.folder_path).toBe('Család/Teszt Elek/Projektek/Tőzsde')
    expect(getProject(ok)!.folder_path).toBe('Cégek/Valami')
    // Az uj helyen sincs meg: nem talalgatunk.
    expect(getProject(gone)!.folder_path).toBe('Teszt Elek/Projektek/Eltunt')
  })

  it('raktar nelkul: nem lat oda, nem ir', () => {
    const saved = process.env.MARVEEN_DEPOT
    delete process.env.MARVEEN_DEPOT
    try { expect(healProjectFoldersForPersonsGroup()).toEqual({ root: null, fixed: [] }) } finally { process.env.MARVEEN_DEPOT = saved }
  })
})
