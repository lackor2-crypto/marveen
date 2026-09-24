// PROJEKT KOTELEZO (Boss, 2026-09-21, kanban #374): "projekt nelkuli kanban
// kartyat tilos letrehozni ... ha nem tudja az agent megitelni, milyen
// projekthez adja hozza, akkor megkerdezi a juzert." A szabaly a LETREHOZAS
// pontjan el (kanban-create.ts), tehat a dashboard, az API es a Munkapad
// agense is ugyanabba utkozik. Friss telepitesen a ket alap-projekt adja meg,
// mihez lehet kotni.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, getKanbanCard, listKanbanCards } from '../db.js'
import { createCardWithRules, NO_PROJECT_MIN_CHARS } from '../kanban-create.js'
import { createProject, getProject, listActiveProjectIds, setProjectArchived } from '../projects.js'
import { seedDefaultProjects, SYSTEM_DEV_SLUG, OFFICE_DEV_SLUG } from '../project-defaults.js'

let dir: string
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'prj-seed-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const base = { status: 'planned', related: [] as string[] }

describe('projekt kotelezo a kartya letrehozasakor', () => {
  it('ha van aktiv projekt, projekt nelkuli felso szintu kartya NEM jon letre, es felsorolja a projekteket', () => {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    const before = listKanbanCards().length
    const r = createCardWithRules({ ...base, title: 'Intezo bug' })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'project_required') {
      expect(r.projects.map((x) => x.id)).toEqual([p.project.id])
      expect(r.error).toContain('PROJEKT KOTELEZO')
      expect(r.error).toContain('megkerdezni a usert')
      expect(r.error).toContain('no_project_reason')
    } else {
      throw new Error('project_required kellett: ' + JSON.stringify(r))
    }
    expect(listKanbanCards().length).toBe(before)
  })

  it('ismeretlen szabad szoveg nem projekt', () => {
    createProject({ name: 'Iroda fejlesztese' })
    const r = createCardWithRules({ ...base, title: 'Valami', project: 'nincs-ilyen-projekt' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('project_required')
  })

  it('projekttel (id vagy pontos nev) letrejon', () => {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    const byName = createCardWithRules({ ...base, title: 'Egy', project: 'Iroda fejlesztese' })
    expect(byName.ok).toBe(true)
    if (byName.ok) expect(getKanbanCard(byName.id)?.project).toBe(p.project.id)
  })

  it('alfeladat a szulo projektjet orokli', () => {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    createKanbanCard({ id: 'aaaa0001', title: 'Szulo', status: 'planned', project: p.project.id } as any)
    const r = createCardWithRules({ title: 'Resz', parent_id: 'aaaa0001' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(getKanbanCard(r.id)?.project).toBe(p.project.id)
  })

  it('kimondott indokkal (a user dontese) projekt nelkul is letrejon, az indok a leirasba kerul', () => {
    createProject({ name: 'Iroda fejlesztese' })
    const reason = 'a user szerint egyik projekthez sem tartozik'
    expect(reason.length).toBeGreaterThanOrEqual(NO_PROJECT_MIN_CHARS)
    const r = createCardWithRules({ ...base, title: 'Magan ugy', no_project_reason: reason })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const card = getKanbanCard(r.id)
      expect(card?.project ?? null).toBeNull()
      expect(card?.description).toContain(`Projekt nelkul, mert: ${reason}`)
    }
  })

  it('tul rovid indok nem indok', () => {
    createProject({ name: 'Iroda fejlesztese' })
    const r = createCardWithRules({ ...base, title: 'Magan ugy', no_project_reason: 'nincs' })
    expect(r.ok).toBe(false)
  })

  it('ismeretlen ertek indokkal: a kartya letrejon, de a project null, nem a nyers ertek (#374 HIANY 2)', () => {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    const r = createCardWithRules({ ...base, title: 'Modellcsere', project: 'system-dev', no_project_reason: 'x'.repeat(NO_PROJECT_MIN_CHARS) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(getKanbanCard(r.id)?.project ?? null).toBeNull()
  })

  it('ismeretlen ertek ures telepitesen (nincs aktiv projekt): sem marad a kartyan', () => {
    const r = createCardWithRules({ ...base, title: 'Elso', project: 'nincs-ilyen-projekt' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(getKanbanCard(r.id)?.project ?? null).toBeNull()
  })

  it('ismert projekt + indok: a projekt nyer, az indok nem kerul a leirasba', () => {
    const p = createProject({ name: 'Rendszer' })
    if (!p.ok) throw new Error('project')
    const r = createCardWithRules({ ...base, title: 'X', project: p.project.id, no_project_reason: 'y'.repeat(NO_PROJECT_MIN_CHARS) })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(getKanbanCard(r.id)?.project).toBe(p.project.id)
      expect(getKanbanCard(r.id)?.description ?? '').not.toContain('Projekt nelkul')
    }
  })

  it('ures telepitesen (egy projekt sincs) nem kovetelheto', () => {
    const r = createCardWithRules({ ...base, title: 'Elso kartya' })
    expect(r.ok).toBe(true)
  })

  it('csak archivalt projekt: nincs mihez kotni, nem kovetelheto', () => {
    const p = createProject({ name: 'Regi' })
    if (!p.ok) throw new Error('project')
    setProjectArchived(p.project.id, true)
    const r = createCardWithRules({ ...base, title: 'Uj' })
    expect(r.ok).toBe(true)
  })
})

describe('alap-projektek friss telepitesen', () => {
  it('ures tablanal letrehozza a ket alap-projektet, allando sluggal, a marka es a nyelv szerint', () => {
    const r = seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'hu' })
    expect(r.reason).toBe('seeded')
    expect(r.seeded.length).toBe(2)
    expect(getProject(SYSTEM_DEV_SLUG)?.name).toBe('Geza fejlesztése')
    expect(getProject(OFFICE_DEV_SLUG)?.name).toBe('Iroda fejlesztése')
    expect(existsSync(join(dir, '.default-projects-seeded'))).toBe(true)
  })

  it('angol telepitesen angol nevek', () => {
    seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'en' })
    expect(getProject(SYSTEM_DEV_SLUG)?.name).toBe('Geza development')
    expect(getProject(OFFICE_DEV_SLUG)?.name).toBe('Office development')
  })

  it('csak egyszer fut: ha a user torolte oket, nem jonnek vissza', () => {
    seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'hu' })
    initDatabase(':memory:')
    const again = seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'hu' })
    expect(again.reason).toBe('already_seeded')
    expect(listActiveProjectIds()).toEqual([])
  })

  it('meglevo projektek mellett nem hoz letre semmit', () => {
    createProject({ name: 'Sajat' })
    const r = seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'hu' })
    expect(r.reason).toBe('has_projects')
    expect(listActiveProjectIds().length).toBe(1)
  })

  it('a friss telepites alap-projektjevel a kapu azonnal hasznalhato (slug is jo)', () => {
    seedDefaultProjects({ markerDir: dir, brand: 'Geza', lang: 'hu' })
    expect(createCardWithRules({ ...base, title: 'Nincs projekt' }).ok).toBe(false)
    const r = createCardWithRules({ ...base, title: 'Rendszer javitas', project: SYSTEM_DEV_SLUG })
    expect(r.ok).toBe(true)
    if (r.ok) expect(getKanbanCard(r.id)?.project).toBe(getProject(SYSTEM_DEV_SLUG)?.id)
  })
})
