// AI Munkapad (kanban #336, 1. fazis): a tarolasi reteg szerzodese.
//
// Amit ORIZ:
//   1. a migracio FRISS telepitesen (ures, memoria-beli db) magatol lefut, es
//      idempotens -- ketszer hivva sem borul;
//   2. uj munkadarab MELLE mindig szuletik egy v1 verzio, es a munkadarab arra
//      mutat (verzio nelkuli munkadarab nem letezhet);
//   3. a lista projektre szur -- masik projekt munkadarabja nem szivarog at;
//   4. a validacio hibat AD, nem nemán javit.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  ensureWorkbenchTables, createWorkItem, getWorkItem, listWorkItems, listWorkItemVersions,
  countWorkItems, EDITOR_BY_TYPE, TITLE_MAX,
} from '../workbench.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function mustCreate(input: Parameters<typeof createWorkItem>[0]) {
  const r = createWorkItem(input)
  if (!r.ok) throw new Error('create failed: ' + r.code)
  return r
}

describe('migracio', () => {
  it('ures adatbazison magatol letrehozza a ket tablat', () => {
    ensureWorkbenchTables()
    const names = (getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('work_items','work_item_versions')")
      .all() as { name: string }[]).map((r) => r.name).sort()
    expect(names).toEqual(['work_item_versions', 'work_items'])
  })

  it('idempotens: tobbszor hivva sem borul, es nem veszit adatot', () => {
    const { item } = mustCreate({ project_id: 'p1', title: 'Ajánlat' })
    ensureWorkbenchTables()
    ensureWorkbenchTables()
    expect(getWorkItem(item.id)?.title).toBe('Ajánlat')
  })

  it('a tablak egy UJ adatbazis-peldanyon is ujra letrejonnek', () => {
    mustCreate({ project_id: 'p1', title: 'Első' })
    initDatabase(':memory:')
    expect(listWorkItems('p1')).toEqual([])
    const { item } = mustCreate({ project_id: 'p1', title: 'Második' })
    expect(getWorkItem(item.id)?.title).toBe('Második')
  })
})

describe('letrehozas', () => {
  it('a munkadarab melle szuletik egy v1, es a munkadarab arra mutat', () => {
    const { item, version } = mustCreate({ project_id: 'p1', title: 'Ajánlat', type: 'document' })
    expect(version.version_no).toBe(1)
    expect(version.parent_version_id).toBeNull()
    expect(version.work_item_id).toBe(item.id)
    expect(item.current_version_id).toBe(version.id)
    expect(listWorkItemVersions(item.id).map((v) => v.version_no)).toEqual([1])
  })

  it('alapertelmezesek: jegyzet-fajta, piszkozat allapot, a fajtahoz tartozo szerkeszto', () => {
    const { item } = mustCreate({ project_id: 'p1', title: 'Gondolat' })
    expect(item.type).toBe('note')
    expect(item.status).toBe('draft')
    expect(item.editor_type).toBe(EDITOR_BY_TYPE.note)
    expect(item.source_path).toBeNull()
  })

  it('minden fajta a sajat szerkesztojet kapja', () => {
    for (const type of ['document', 'image', 'graphic', 'video', 'note'] as const) {
      const { item } = mustCreate({ project_id: 'p1', title: 'X ' + type, type })
      expect(item.editor_type).toBe(EDITOR_BY_TYPE[type])
    }
  })

  it('a keres (prompt) a v1 verziohoz kerul, nem a munkadarabra', () => {
    const { version } = mustCreate({ project_id: 'p1', title: 'Plakát', type: 'graphic', prompt: '  kék háttér  ' })
    expect(version.prompt).toBe('kék háttér')
  })

  it('a letrehozo neve rakerul mindkét sorra', () => {
    const { item, version } = mustCreate({ project_id: 'p1', title: 'X', created_by: 'boss' })
    expect(item.created_by).toBe('boss')
    expect(version.created_by).toBe('boss')
  })
})

describe('validacio -- hibat ad, nem nemán javit', () => {
  it('a cim kotelezo', () => {
    expect(createWorkItem({ project_id: 'p1', title: '   ' })).toEqual({ ok: false, code: 'title_required' })
    expect(createWorkItem({ project_id: 'p1' })).toEqual({ ok: false, code: 'title_required' })
  })

  it('a cim nem lehet vegtelen hosszu', () => {
    expect(createWorkItem({ project_id: 'p1', title: 'x'.repeat(TITLE_MAX + 1) })).toEqual({ ok: false, code: 'title_too_long' })
    expect(createWorkItem({ project_id: 'p1', title: 'x'.repeat(TITLE_MAX) }).ok).toBe(true)
  })

  it('ismeretlen fajta es allapot elutasitva', () => {
    expect(createWorkItem({ project_id: 'p1', title: 'X', type: 'hologram' })).toEqual({ ok: false, code: 'bad_type' })
    expect(createWorkItem({ project_id: 'p1', title: 'X', status: 'valami' })).toEqual({ ok: false, code: 'bad_status' })
  })

  it('elutasitas eseten semmi nem marad a tablakban', () => {
    createWorkItem({ project_id: 'p1', title: 'X', type: 'hologram' })
    expect(listWorkItems('p1')).toEqual([])
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM work_item_versions').get() as { n: number }).n).toBe(0)
  })
})

describe('lista -- projektre szurve', () => {
  it('ures projekt: ures lista, nem hiba', () => {
    expect(listWorkItems('p1')).toEqual([])
    expect(countWorkItems('p1')).toBe(0)
    expect(listWorkItems('')).toEqual([])
  })

  it('masik projekt munkadarabja nem szivarog at', () => {
    mustCreate({ project_id: 'p1', title: 'Első' })
    mustCreate({ project_id: 'p2', title: 'Másik' })
    expect(listWorkItems('p1').map((i) => i.title)).toEqual(['Első'])
    expect(listWorkItems('p2').map((i) => i.title)).toEqual(['Másik'])
    expect(countWorkItems('p1')).toBe(1)
  })

  it('ismeretlen munkadarab: undefined, nem dobas', () => {
    expect(getWorkItem('nincsilyen')).toBeUndefined()
    expect(getWorkItem('')).toBeUndefined()
    expect(listWorkItemVersions('nincsilyen')).toEqual([])
  })
})
