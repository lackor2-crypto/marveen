// Projektek (kanban #321): a tarolasi reteg szerzodese.
//
// A harom dolog, amit a terv kulon kikot, es ami itt MEGBUKTATJA a munkat, ha
// elcsuszik:
//   1. egy objektum -- tobb nezet: a kartya ugyanaz marad, csak a `project`
//      mezoje mutat a projekt id-jere;
//   2. a projekt torlese CSAK a kapcsolatot bontja, adatot nem torol;
//   3. ismeretlen szoveg a `project` mezoben nem veszhet el.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, getDb, createIdea, createLabel } from '../db.js'
import {
  createProject, updateProject, getProject, listProjects, deleteProject, projectDeletePreview,
  resolveProjectRef, slugify, uniqueSlug, linkObject, unlinkObject, projectForObject,
  setProjectArchived, listActiveProjectIds, projectIdeaIds, projectNameMap, cleanFolderRel,
} from '../projects.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function mustCreate(input: Parameters<typeof createProject>[0]) {
  const r = createProject(input)
  if (!r.ok) throw new Error('create failed: ' + r.code)
  return r.project
}

describe('slug', () => {
  it('ekezet nelkul, kisbetus, kotojeles', () => {
    expect(slugify('Kovács weboldal')).toBe('kovacs-weboldal')
    expect(slugify('  Árvíztűrő  Tükörfúrógép! ')).toBe('arvizturo-tukorfurogep')
    expect(slugify('***')).toBe('project')
  })

  it('foglalt slug eseten utotagot kap', () => {
    mustCreate({ name: 'Weboldal' })
    expect(uniqueSlug('Weboldal')).toBe('weboldal-2')
    // Mas nev, ugyanaz a rovid nev (az ekezet es a kisbetu kiesik).
    const b = mustCreate({ name: 'WEBOLDAL!' })
    expect(b.slug).toBe('weboldal-2')
  })

  it('azonos nevu projekt nem lehet ket -- ekezetes nagybetuvel sem', () => {
    const a = mustCreate({ name: 'Árvíztűrő' })
    expect(createProject({ name: ' árvíztűrő ' })).toEqual({ ok: false, code: 'name_taken' })
    const b = mustCreate({ name: 'Más' })
    expect(updateProject(b.id, { name: 'ÁRVÍZTŰRŐ' })).toEqual({ ok: false, code: 'name_taken' })
    // A sajat nevet megtarthatja.
    expect(updateProject(a.id, { name: 'Árvíztűrő' }).ok).toBe(true)
    // A kanban a nevet a projektre oldja fel, kis-/nagybetutol fuggetlenul.
    expect(resolveProjectRef('ÁRVÍZTŰRŐ')).toBe(a.id)
  })
})

describe('letrehozas es szerkesztes', () => {
  it('a nev kotelezo, az allapot csak ismert lehet', () => {
    expect(createProject({ name: '   ' })).toEqual({ ok: false, code: 'name_required' })
    expect(createProject({ name: 'X', status: 'vege' })).toEqual({ ok: false, code: 'bad_status' })
  })

  it('8 karakteres id, alapertelmezett allapot: active; a kinek-keszul mezo szabad szoveg', () => {
    const p = mustCreate({ name: 'Freeber', description: 'Ride-sharing app', client: 'Egy ismerős' })
    expect(p.id).toMatch(/^[0-9a-f]{8}$/)
    expect(p.status).toBe('active')
    expect(p.client).toBe('Egy ismerős')
    expect(getProject(p.slug)?.id).toBe(p.id)
  })

  it('a nem letezo cimke hibat ad, a letezo atmegy', () => {
    expect(createProject({ name: 'X', default_label_id: 'nincs-ilyen' })).toEqual({ ok: false, code: 'bad_label' })
    createLabel({ id: 'lbl1', name: 'fejlesztes', color: '#3b82f6' })
    expect(mustCreate({ name: 'Y', default_label_id: 'lbl1' }).default_label_id).toBe('lbl1')
  })

  it('a mappa-ut nem vezethet ki (..), es per-jelre normalizalodik', () => {
    expect(cleanFolderRel('a/../b')).toBeNull()
    expect(cleanFolderRel('\\Nev\\Projektek\\X\\')).toBe('Nev/Projektek/X')
    expect(createProject({ name: 'X', folder_path: '../kivul' })).toEqual({ ok: false, code: 'bad_folder' })
  })

  it('szerkesztes: csak a kuldott mezok valtoznak', () => {
    const p = mustCreate({ name: 'Régi név', description: 'leírás' })
    const u = updateProject(p.id, { name: 'Új név' })
    expect(u.ok && u.project.name).toBe('Új név')
    expect(u.ok && u.project.description).toBe('leírás')
    expect(updateProject('nincs', { name: 'x' })).toEqual({ ok: false, code: 'not_found' })
  })
})

describe('egy objektum -- tobb nezet', () => {
  it('a kartya a projekt id-jere mutat, es a lista szamolja', () => {
    const p = mustCreate({ name: 'Freeber' })
    createKanbanCard({ id: 'c1', title: 'Login', project: p.id, status: 'in_progress' })
    createKanbanCard({ id: 'c2', title: 'Kész', project: p.id, status: 'done' })
    createKanbanCard({ id: 'c3', title: 'Globális', status: 'planned' })
    const [row] = listProjects()
    expect(row.open_cards).toBe(1)
    expect(row.live_cards).toBe(2)
    expect(getKanbanCard('c3')?.project).toBeNull()
  })

  it('resolveProjectRef: id, slug es pontos nev projektre oldodik; ismeretlen szoveg valtozatlan', () => {
    const p = mustCreate({ name: 'Marvin fejlesztés', slug: 'marveen' })
    expect(resolveProjectRef(p.id)).toBe(p.id)
    expect(resolveProjectRef('marveen')).toBe(p.id)
    expect(resolveProjectRef('MARVEEN')).toBe(p.id)
    expect(resolveProjectRef('marvin fejlesztés')).toBe(p.id)
    expect(resolveProjectRef('valami más')).toBe('valami más')
    expect(resolveProjectRef('')).toBeNull()
    expect(resolveProjectRef(null)).toBeNull()
    expect(resolveProjectRef(undefined)).toBeUndefined()
  })

  it('az archivalt projekt nincs a listaban es a szuro-id-k kozott, de a nev-terkepben igen', () => {
    const p = mustCreate({ name: 'Archív' })
    setProjectArchived(p.id, true)
    expect(listProjects()).toHaveLength(0)
    expect(listProjects({ includeArchived: true })).toHaveLength(1)
    expect(listActiveProjectIds()).toEqual([])
    expect(projectNameMap()[p.id]).toEqual({ name: 'Archív', archived: true })
  })
})

describe('torles = kapcsolat bontasa', () => {
  it('az elonezet megmondja, mit erint, a torles utan minden adat megmarad', () => {
    const p = mustCreate({ name: 'Freeber', folder_path: 'Nev/Projektek/Freeber' })
    createKanbanCard({ id: 'c1', title: 'Egy', project: p.id })
    createKanbanCard({ id: 'c2', title: 'Kettő', project: p.id, status: 'done' })
    createIdea({ id: 'i1', title: 'Ötlet', description: null, category: 'Egyéb', status: 'new', source: 'manual', kanban_id: null, impact: null, effort: null })
    linkObject(p.id, 'idea', 'i1')
    linkObject(p.id, 'code_alias', 'freeber-app')

    const pre = projectDeletePreview(p.id)!
    expect(pre.cards).toBe(2)
    expect(pre.openCards).toBe(1)
    expect(pre.ideas).toBe(1)
    expect(pre.codeAliases).toEqual(['freeber-app'])
    expect(pre.folderPath).toBe('Nev/Projektek/Freeber')

    const out = deleteProject(p.id)
    expect(out).toEqual({ ok: true, unlinkedCards: 2, removedLinks: 2 })
    expect(getProject(p.id)).toBeUndefined()
    // A kartyak es az otlet megvannak, csak projekt nelkul.
    expect(getKanbanCard('c1')?.project).toBeNull()
    expect(getKanbanCard('c2')?.title).toBe('Kettő')
    expect(getDb().prepare('SELECT COUNT(*) n FROM idea_box').get()).toEqual({ n: 1 })
    expect(projectForObject('code_alias', 'freeber-app')).toBeNull()
  })

  it('nem letezo projekt torlese nem csinal semmit', () => {
    expect(deleteProject('nincs')).toEqual({ ok: false, unlinkedCards: 0, removedLinks: 0 })
  })
})

describe('project_links', () => {
  it('egy objektum egyszerre egy projekt: az uj kotes atviszi', () => {
    const a = mustCreate({ name: 'A' })
    const b = mustCreate({ name: 'B' })
    linkObject(a.id, 'debate', 's1')
    linkObject(b.id, 'debate', 's1')
    expect(projectForObject('debate', 's1')).toBe(b.id)
    expect(unlinkObject('debate', 's1')).toBe(true)
    expect(projectForObject('debate', 's1')).toBeNull()
  })

  it('az otlet a kartyajan at is a projekthez tartozik (levezetett), de a kifejezett kotes nyer', () => {
    const a = mustCreate({ name: 'A' })
    const b = mustCreate({ name: 'B' })
    createKanbanCard({ id: 'c1', title: 'Kártya', project: a.id })
    for (const id of ['i1', 'i2']) {
      createIdea({ id, title: id, description: null, category: 'Egyéb', status: 'kanban', source: 'manual', kanban_id: 'c1', impact: null, effort: null })
    }
    linkObject(b.id, 'idea', 'i2')
    expect(projectIdeaIds(a.id)).toEqual(['i1'])
    expect(projectIdeaIds(b.id)).toEqual(['i2'])
  })
})
