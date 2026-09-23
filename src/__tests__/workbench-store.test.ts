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
  addWorkItemPart, listWorkItemParts, updateWorkItemPart, moveWorkItemPart, removeWorkItemPart, countWorkItemParts,
  createWorkItemVersion, restoreWorkItemVersion, listWorkItemVersionsView,
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

// --- VEGYES (kompozit) munkadarab: reszek (3. fazis) -------------------------
//
// Boss, 2026-09-21: "egy munkadarabban lehet egyszerre kep ES szoveg (pl.
// Facebook-poszt: foto + iras)". Amit ez a blokk oriz: a ketto TENYLEG egy
// munkadarabban all, sorrendben, es a resz kivetele nem tunteti el a kep
// fajljat.
describe('vegyes munkadarab: reszek', () => {
  function ujDarab(): string {
    const r = createWorkItem({ project_id: 'p-vegyes', title: 'Facebook-poszt', type: 'composite' })
    if (!r.ok) throw new Error('a munkadarab nem jott letre: ' + r.code)
    return r.item.id
  }

  it('a `composite` fajta letezik, es vegyes tartalomnak indul', () => {
    const r = createWorkItem({ project_id: 'p-vegyes', title: 'Poszt', type: 'composite' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item.type).toBe('composite')
  })

  it('egy munkadarabban egyszerre all a KEP es a SZOVEG, sorrendben', () => {
    const id = ujDarab()
    const a = addWorkItemPart({ work_item_id: id, kind: 'image', asset_path: 'Projektek/Poszt/foto.jpg', caption: 'A bejárat' })
    const b = addWorkItemPart({ work_item_id: id, kind: 'text', text: 'Elkészült a felújítás.' })
    expect(a.ok && b.ok).toBe(true)
    const parts = listWorkItemParts(id)
    expect(parts.map((p) => p.kind)).toEqual(['image', 'text'])
    expect(parts.map((p) => p.position)).toEqual([1, 2])
    expect(countWorkItemParts(id)).toBe(2)
  })

  it('a szoveg-blokk nem lehet ures, a kep-resz nem lehet ut nelkul', () => {
    const id = ujDarab()
    expect(addWorkItemPart({ work_item_id: id, kind: 'text', text: '   ' })).toEqual({ ok: false, code: 'text_required' })
    expect(addWorkItemPart({ work_item_id: id, kind: 'image' })).toEqual({ ok: false, code: 'asset_required' })
    expect(addWorkItemPart({ work_item_id: id, kind: 'hang' })).toEqual({ ok: false, code: 'bad_kind' })
  })

  it('a resz javitasa: ami nincs a bemenetben, az valtozatlan marad', () => {
    const id = ujDarab()
    const a = addWorkItemPart({ work_item_id: id, kind: 'image', asset_path: 'x/foto.jpg', caption: 'Elso felirat' })
    if (!a.ok) throw new Error('nem jott letre')
    const r = updateWorkItemPart(a.part.id, { caption: 'Masodik felirat' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.part.caption).toBe('Masodik felirat')
      // A kep utja NEM veszett el attol, hogy csak a feliratot irtuk at.
      expect(r.part.asset_path).toBe('x/foto.jpg')
    }
  })

  it('a mozgatas sorszamai 1..n-ig folytonosak maradnak', () => {
    const id = ujDarab()
    const a = addWorkItemPart({ work_item_id: id, kind: 'text', text: 'egy' })
    addWorkItemPart({ work_item_id: id, kind: 'text', text: 'ketto' })
    addWorkItemPart({ work_item_id: id, kind: 'text', text: 'harom' })
    if (!a.ok) throw new Error('nem jott letre')
    const r = moveWorkItemPart(a.part.id, 'down')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.parts.map((p) => p.text)).toEqual(['ketto', 'egy', 'harom'])
      expect(r.parts.map((p) => p.position)).toEqual([1, 2, 3])
    }
  })

  it('a legfelso reszt nem lehet meg feljebb tolni -- es ettol nem lesz hiba', () => {
    const id = ujDarab()
    const a = addWorkItemPart({ work_item_id: id, kind: 'text', text: 'egy' })
    addWorkItemPart({ work_item_id: id, kind: 'text', text: 'ketto' })
    if (!a.ok) throw new Error('nem jott letre')
    const r = moveWorkItemPart(a.part.id, 'up')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.parts.map((p) => p.text)).toEqual(['egy', 'ketto'])
  })

  it('a resz kivetele UTAN is folytonos a sorrend, es ismeretlen resz 404-es kodot ad', () => {
    const id = ujDarab()
    const a = addWorkItemPart({ work_item_id: id, kind: 'text', text: 'egy' })
    addWorkItemPart({ work_item_id: id, kind: 'text', text: 'ketto' })
    addWorkItemPart({ work_item_id: id, kind: 'text', text: 'harom' })
    if (!a.ok) throw new Error('nem jott letre')
    const r = removeWorkItemPart(a.part.id)
    expect(r.ok).toBe(true)
    expect(listWorkItemParts(id).map((p) => p.position)).toEqual([1, 2])
    expect(removeWorkItemPart('nincs-ilyen')).toEqual({ ok: false, code: 'part_not_found' })
  })

  it('ismeretlen munkadarabra ures a reszlista -- a hivo dolga eldonteni, letezik-e', () => {
    expect(listWorkItemParts('nincs-ilyen')).toEqual([])
    expect(countWorkItemParts('')).toBe(0)
  })
})

// --- 5. fazis: VERZIOZAS + VISSZAALLITAS (spec 12) ---------------------------

describe('verziozas', () => {
  function withParts() {
    const w = mustCreate({ project_id: 'p1', title: 'Poszt', type: 'composite', source_path: 'v1.txt' })
    const a = addWorkItemPart({ work_item_id: w.item.id, kind: 'text', text: 'elso' })
    if (!a.ok) throw new Error('resz: ' + a.code)
    return w
  }

  it('uj verzio: a szam no, a szulo a korabbi, es a munkadarab arra mutat', () => {
    const w = withParts()
    const r = createWorkItemVersion(w.item.id, { prompt: 'atirtam' })
    if (!r.ok) throw new Error('verzio: ' + r.code)
    expect(r.version.version_no).toBe(2)
    expect(r.version.parent_version_id).toBe(w.version.id)
    expect(r.item.current_version_id).toBe(r.version.id)
    expect(listWorkItemVersions(w.item.id).length).toBe(2)
  })

  it('a REGI verzio valtozatlan marad: sajat resz-sorai vannak', () => {
    const w = withParts()
    const v2 = createWorkItemVersion(w.item.id)
    if (!v2.ok) throw new Error('verzio')
    // Az uj verzioban modositunk: a v1 pillanatkepe NEM valtozhat tole.
    const live = listWorkItemParts(w.item.id)
    expect(live.length).toBe(1)
    const up = updateWorkItemPart(live[0]!.id, { text: 'masodik' })
    expect(up.ok).toBe(true)
    expect(listWorkItemParts(w.item.id)[0]!.text).toBe('masodik')
    expect(listWorkItemParts(w.item.id, w.version.id)[0]!.text).toBe('elso')
  })

  it('visszaallitas: UJ verzio lesz belole, a kozbensok MEGMARADNAK', () => {
    const w = withParts()
    const v2 = createWorkItemVersion(w.item.id)
    if (!v2.ok) throw new Error('v2')
    const live = listWorkItemParts(w.item.id)
    updateWorkItemPart(live[0]!.id, { text: 'masodik' })

    const r = restoreWorkItemVersion(w.version.id)
    if (!r.ok) throw new Error('restore: ' + r.code)
    // v3 keletkezett, nem tunt el se a v1, se a v2.
    expect(r.version.version_no).toBe(3)
    expect(listWorkItemVersions(w.item.id).map((v) => v.version_no)).toEqual([3, 2, 1])
    // es a tartalom a v1-e.
    expect(listWorkItemParts(w.item.id)[0]!.text).toBe('elso')
    expect(r.item.current_version_id).toBe(r.version.id)
  })

  it('a visszaallitas a FORRASFAJLT is visszahozza', () => {
    const w = mustCreate({ project_id: 'p1', title: 'Ajanlat', type: 'document', source_path: 'ajanlat-v1.pdf' })
    const v2 = createWorkItemVersion(w.item.id, { source_path: 'ajanlat-v2.pdf' })
    if (!v2.ok) throw new Error('v2')
    expect(v2.item.source_path).toBe('ajanlat-v2.pdf')
    const r = restoreWorkItemVersion(w.version.id)
    if (!r.ok) throw new Error('restore')
    expect(r.item.source_path).toBe('ajanlat-v1.pdf')
  })

  it('a felulet szamot lat arrol, MIBOL allt vissza -- nem nyers JSON-t', () => {
    const w = withParts()
    const r = restoreWorkItemVersion(w.version.id)
    if (!r.ok) throw new Error('restore')
    const view = listWorkItemVersionsView(w.item.id)
    expect(view[0]!.restored_from_no).toBe(1)
    expect(view[0]!.restored_from).toBe(w.version.id)
    // A tobbi verzional ez nem "nulla", hanem NINCS ilyen adat.
    expect(view[1]!.restored_from_no).toBe(null)
  })

  it('ismeretlen verzio/munkadarab: HIBAKOD jon, nem csendes semmittevés', () => {
    expect(createWorkItemVersion('nincs-ilyen')).toEqual({ ok: false, code: 'item_not_found' })
    expect(restoreWorkItemVersion('nincs-ilyen')).toEqual({ ok: false, code: 'version_not_found' })
    const a = mustCreate({ project_id: 'p1', title: 'A' })
    const b = mustCreate({ project_id: 'p1', title: 'B' })
    // Masik munkadarab verzioja: ez OSSZEKEVERES, nem "nem talalom".
    expect(restoreWorkItemVersion(a.version.id, { work_item_id: b.item.id }))
      .toEqual({ ok: false, code: 'version_mismatch' })
  })

  it('a szamlalo csak az ELO reszeket szamolja, a pillanatkepeket nem', () => {
    const w = withParts()
    createWorkItemVersion(w.item.id)
    createWorkItemVersion(w.item.id)
    expect(countWorkItemParts(w.item.id)).toBe(1)
  })
})
