// AI Munkapad (kanban #336, 2. fazis): a TOOL REGISTRY, a vegrehajtas es a
// KONTEXTUS-EPITES.
//
// Amit oriz:
//   1. minden eszkoz viseli a spec 0.3 metaadatait, es a kepzes a MEGLEVO
//      autonomy-kategoriakra megy (nem uj jogosultsagi rendszer);
//   2. a `file.read` NEM lat ki a projektmappabol;
//   3. minden eredmeny megkulonbozteti a "nincs semmi"-t a "nem latok oda"-tol;
//   4. a kontextus meretkorlatos, es kimondja, ahol nincs adata.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getKanbanCard, createLabel } from '../db.js'
import { createProject, updateProject, type ProjectRow, getProject } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems } from '../workbench.js'
import { TOOLS, getTool, decideTool, toolsForPrompt, setAutonomyLoaderForTest } from '../workbench-agent/tools.js'
import { executeTool, FILE_READ_MAX_CHARS } from '../workbench-agent/execute.js'
import { buildContext, historyMessages, MAX_CONTEXT_CHARS, MAX_HISTORY_TURNS } from '../workbench-agent/context.js'
import type { AgentMessageRow } from '../workbench-agent/sessions.js'

let projectId = ''
let workItemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Teszt projekt', description: 'Egy leírás' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Ajánlat', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  workItemId = w.item.id
})

afterEach(() => { setAutonomyLoaderForTest(null) })

const ctx = () => ({ projectId, workItemId, lang: 'hu' as const })

describe('tool registry', () => {
  it('minden eszkoz viseli a spec 0.3 metaadatait', () => {
    expect(TOOLS.length).toBeGreaterThan(0)
    for (const t of TOOLS) {
      expect(typeof t.destructive).toBe('boolean')
      expect(typeof t.reversible).toBe('boolean')
      expect(typeof t.external_effect).toBe('boolean')
      expect(t.description.length).toBeGreaterThan(10)
    }
  })

  it('EGYETLEN eszkoznek sincs kulso hatasa', () => {
    // A Munkapad nem kuld semmit kifele: se email, se publikalas, se uzenet.
    expect(TOOLS.filter((t) => t.external_effect).map((t) => t.name)).toEqual([])
  })

  it('ami destruktiv, az SOSE mehet magatol -- van autonomy-kategoriaja', () => {
    // A 6. fazis hozta be az elso destruktiv eszkozt (file.delete). A szabaly
    // nem az, hogy nincs ilyen, hanem hogy egyik sem csuszhat at kategoria
    // nelkul -- kategoria nelkul ugyanis a `decideTool` mindig engedne.
    const destructive = TOOLS.filter((t) => t.destructive)
    expect(destructive.length).toBeGreaterThan(0)
    for (const t of destructive) expect(t.autonomyCategory).toBeTruthy()
  })

  it('a fajl-iro eszkozok a sajat kategoriajukra kepzodnek, a torles a data_delete-re', () => {
    expect(getTool('file.write')!.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('file.copy')!.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('file.move')!.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('file.rename')!.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('file.delete')!.autonomyCategory).toBe('data_delete')
    // A torles a Kukaba visz, tehat visszafordithato -- ezt a regiszter is allitja.
    expect(getTool('file.delete')!.reversible).toBe(true)
    // Az olvasok maradnak kategoria nelkul.
    expect(getTool('file.read')!.autonomyCategory).toBeNull()
    expect(getTool('file.preview')!.autonomyCategory).toBeNull()
  })

  it('a kesobbi fazisok eszkozei (dokumentum/kep/video) MEG NINCSENEK benne', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names.some((n) => /docx|image|video|render|publish|email/i.test(n))).toBe(false)
  })

  it('ismeretlen eszkoz nincs', () => {
    expect(getTool('rakéta.indit')).toBeUndefined()
    expect(getTool('')).toBeUndefined()
    expect(getTool('project.get')?.name).toBe('project.get')
  })

  it('a rendszer-uzenetbe kerulo lista minden eszkozt es a jelzoit tartalmazza', () => {
    const txt = toolsForPrompt()
    for (const t of TOOLS) expect(txt).toContain(t.name)
    expect(txt).toContain('non-destructive')
  })
})

describe('autonomy-kepzes (a MEGLEVO rendszer, nem uj)', () => {
  const cfg = (level: number) => () => ({
    version: 1, updated_at: 0,
    categories: [{ key: 'marveen_selfdev', label: 't', level, locked: false, maxLevel: 3 }],
  })

  it('kategoria nelkuli (olvaso) eszkoz mindig szabad -- config nelkul is', () => {
    setAutonomyLoaderForTest(() => { throw new Error('nincs config') })
    expect(decideTool(getTool('project.get')!, 'barki')).toEqual({ kind: 'allow', level: 3 })
  })

  it('3-as szint: onalloan mehet', () => {
    setAutonomyLoaderForTest(cfg(3))
    expect(decideTool(getTool('workItem.create')!, 'barki').kind).toBe('allow')
  })

  it('2-es szint: jovahagyast ker', () => {
    setAutonomyLoaderForTest(cfg(2))
    expect(decideTool(getTool('workItem.create')!, 'barki')).toMatchObject({ kind: 'approval', category: 'marveen_selfdev' })
  })

  it('1-es szint: blokkolt (meg kerdezni sem lehet)', () => {
    setAutonomyLoaderForTest(cfg(1))
    expect(decideTool(getTool('workItem.create')!, 'barki').kind).toBe('blocked')
  })

  it('zarolt kategoria akkor sem enged, ha a szint 3', () => {
    setAutonomyLoaderForTest(() => ({
      version: 1, updated_at: 0,
      categories: [{ key: 'marveen_selfdev', label: 't', level: 3, locked: true, maxLevel: 3 }],
    }))
    expect(decideTool(getTool('workItem.create')!, 'barki').kind).toBe('blocked')
  })

  it('ismeretlen kategoria vagy olvashatatlan config NEM ad jogot', () => {
    setAutonomyLoaderForTest(() => ({ version: 1, updated_at: 0, categories: [] }))
    expect(decideTool(getTool('workItem.create')!, 'barki').kind).toBe('approval')
    setAutonomyLoaderForTest(() => { throw new Error('serult') })
    expect(decideTool(getTool('workItem.create')!, 'barki').kind).toBe('approval')
  })
})

describe('vegrehajtas -- olvaso eszkozok', () => {
  it('project.get a mert tenyeket adja', () => {
    const r = executeTool('project.get', {}, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ name: 'Teszt projekt', description: 'Egy leírás', hasFolder: false })
  })

  it('workItem.open csak a SAJAT projekt darabjat adja ki', () => {
    const other = createProject({ name: 'Másik' })
    if (!other.ok) throw new Error('projekt')
    const r = executeTool('workItem.open', { id: workItemId }, { projectId: other.project.id, workItemId: null, lang: 'hu' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_found')
  })

  it('workItem.listVersions: a darab v1-et adja', () => {
    const r = executeTool('workItem.listVersions', { id: workItemId }, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as any).count).toBe(1)
  })

  it('ismeretlen eszkoz: nem dob, hanem megnevezett hibat ad', () => {
    const r = executeTool('nincs.ilyen', {}, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('tool_unknown')
  })

  it('ismeretlen projekt: megnevezett hiba', () => {
    const r = executeTool('project.get', {}, { projectId: 'nincsilyen', workItemId: null, lang: 'hu' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('project_not_found')
  })
})

describe('vegrehajtas -- iro eszkozok', () => {
  it('workItem.create uj darabot es v1-et csinal', () => {
    const r = executeTool('workItem.create', { title: 'Új terv', type: 'note' }, ctx())
    expect(r.ok).toBe(true)
    expect(listWorkItems(projectId).map((i) => i.title)).toContain('Új terv')
  })

  it('workItem.create ertelmetlen bemenetre NEM talal ki cimet', () => {
    const r = executeTool('workItem.create', { title: '   ' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('title_required')
    expect(listWorkItems(projectId)).toHaveLength(1)
  })

  it('workItem.update cimet es allapotot allit', () => {
    const r = executeTool('workItem.update', { id: workItemId, status: 'review' }, ctx())
    expect(r.ok).toBe(true)
    expect(getWorkItem(workItemId)?.status).toBe('review')
    expect(getWorkItem(workItemId)?.title).toBe('Ajánlat')
  })

  it('workItem.update ismeretlen allapotot elutasit', () => {
    const r = executeTool('workItem.update', { id: workItemId, status: 'kesz-e-mar' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_status')
    expect(getWorkItem(workItemId)?.status).toBe('draft')
  })
})

describe('file.read -- a projektmappa hatara', () => {
  let depot = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-depot-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    writeFileSync(join(depot, 'Projektek', 'teszt', 'jegyzet.txt'), 'Ez a fájl tartalma.', 'utf-8')
    writeFileSync(join(depot, 'titok.txt'), 'EZ A MAPPÁN KÍVÜL VAN', 'utf-8')
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('a projektmappa beallitasa nem sikerult: ' + up.code)
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a projektmappaban levo fajlt elolvassa', () => {
    const r = executeTool('file.read', { path: 'jegyzet.txt' }, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.data as any).text).toBe('Ez a fájl tartalma.')
      expect((r.data as any).truncated).toBe(false)
    }
  })

  it('a hosszu fajl levagva jon, ES a valasz megmondja, hogy levagtuk', () => {
    // Jelzes nelkul a modell azt hinne, a fajl veget latta -- es arra
    // alapozva talalna ki a tobbit.
    writeFileSync(join(depot, 'Projektek', 'teszt', 'hosszu.txt'), 'á'.repeat(FILE_READ_MAX_CHARS + 500), 'utf-8')
    const r = executeTool('file.read', { path: 'hosszu.txt' }, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.data as any).truncated).toBe(true)
      expect((r.data as any).text.length).toBe(FILE_READ_MAX_CHARS)
    }
  })

  it('mappat nem olvas fajlkent', () => {
    mkdirSync(join(depot, 'Projektek', 'teszt', 'almappa'), { recursive: true })
    const r = executeTool('file.read', { path: 'almappa' }, ctx())
    expect(r.ok).toBe(false)
  })

  it('a mappan KIVULRE mutato ut nem olvashato', () => {
    for (const bad of ['../titok.txt', '../../titok.txt', '/etc/passwd']) {
      const r = executeTool('file.read', { path: bad }, ctx())
      expect(r.ok, `nem szabadott volna kiolvasni: ${bad}`).toBe(false)
      if (!r.ok) expect(JSON.stringify(r)).not.toContain('MAPPÁN KÍVÜL')
    }
  })

  it('ures utvonal: megnevezett hiba, nem ures valasz', () => {
    const r = executeTool('file.read', { path: '' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_input')
  })

  it('nem letezo fajl: a TENYLEGES hibauzenet megy vissza, nem talalgatas', () => {
    const r = executeTool('file.read', { path: 'nincs-ilyen.txt' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('not_found')
      expect(r.detail).toMatch(/ENOENT|no such file/i)
    }
  })
})

describe('kontextus-epites', () => {
  it('a mert tenyek bekerulnek, a kitalalas tiltva van', () => {
    const p = getProject(projectId) as ProjectRow
    const c = buildContext(p, getWorkItem(workItemId) ?? null, 'hu')
    expect(c.system).toContain('Never invent')
    expect(c.contextText).toContain('CONTEXT (measured facts')
    expect(c.contextText).toContain('Teszt projekt')
    expect(c.contextText).toContain('Ajánlat')
    expect(c.contextText.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 200)
  })

  it('ahol nincs adat, KIMONDJA -- es megkulonbozteti a ket esetet', () => {
    const other = createProject({ name: 'Üres projekt' })
    if (!other.ok) throw new Error('projekt')
    const c = buildContext(other.project, null, 'hu')
    // Nincs munkadarab: "none yet", nem elhallgatas.
    expect(c.contextText).toContain('none yet in this project')
    // Nincs mappa: kimondja, hogy ez NEM azt jelenti, hogy nincsenek fajlok.
    expect(c.contextText).toContain('does NOT mean there are no files')
  })

  it('a nyelv a kontextusban is megjelenik', () => {
    const p = getProject(projectId) as ProjectRow
    expect(buildContext(p, null, 'en').contextText).toContain('Answer language: English')
    expect(buildContext(p, null, 'hu').contextText).toContain('Answer language: Hungarian')
  })

  it('a beszelgetes-elozmeny korlatos, es a LEGUJABB fordulok maradnak', () => {
    const rows: AgentMessageRow[] = []
    for (let i = 0; i < MAX_HISTORY_TURNS + 8; i++) {
      rows.push({ id: String(i), session_id: 's', role: i % 2 ? 'assistant' : 'user', content: `uzenet-${i}`, created_at: i })
    }
    const out = historyMessages(rows)
    expect(out.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS)
    expect(out.at(-1)?.content).toBe(`uzenet-${rows.length - 1}`)
  })

  it('a rendszer-uzeneteket nem adja vissza a modellnek', () => {
    const rows: AgentMessageRow[] = [
      { id: '1', session_id: 's', role: 'user', content: 'kérdés', created_at: 1 },
      { id: '2', session_id: 's', role: 'system', content: 'belső közlés', created_at: 2 },
    ]
    expect(historyMessages(rows).map((m) => m.content)).toEqual(['kérdés'])
  })

  // Egy sikertelen fordulo (nincs szolgaltato / betelt keret) utan az
  // asszisztens valasza nem kerul a naploba, a rendszer-uzenetet pedig
  // kiszurjuk -- igy ket `user` uzenet allna egymas mellett.
  it('ket egymas utani user-uzenet egybe kerul (valtakozo szerepek)', () => {
    const rows: AgentMessageRow[] = [
      { id: '1', session_id: 's', role: 'user', content: 'elso kérdés', created_at: 1 },
      { id: '2', session_id: 's', role: 'system', content: 'betelt a keret', created_at: 2 },
      { id: '3', session_id: 's', role: 'user', content: 'masodik kérdés', created_at: 3 },
    ]
    const out = historyMessages(rows)
    expect(out.map((m) => m.role)).toEqual(['user'])
    expect(out[0].content).toContain('elso kérdés')
    expect(out[0].content).toContain('masodik kérdés')
  })

  it('a szerepek a valodi beszelgetesben valtakoznak', () => {
    const rows: AgentMessageRow[] = [
      { id: '1', session_id: 's', role: 'user', content: 'a', created_at: 1 },
      { id: '2', session_id: 's', role: 'assistant', content: 'b', created_at: 2 },
      { id: '3', session_id: 's', role: 'user', content: 'c', created_at: 3 },
    ]
    expect(historyMessages(rows).map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('egy tulsagosan hosszu uzenet sem viszi el a keretet', () => {
    const rows: AgentMessageRow[] = [{ id: '1', session_id: 's', role: 'user', content: 'x'.repeat(50_000), created_at: 1 }]
    const out = historyMessages(rows)
    expect(out[0].content.length).toBeLessThan(5000)
  })
})

// --- 3. fazis: vegyes munkadarab + kod-javitas = KANBAN KARTYA --------------

describe('workItem.addPart / listParts -- vegyes munkadarab', () => {
  let depot = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-parts-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    writeFileSync(join(depot, 'Projektek', 'teszt', 'foto.jpg'), 'KEP', 'utf-8')
    writeFileSync(join(depot, 'kintrol.jpg'), 'A MAPPÁN KÍVÜL', 'utf-8')
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('a projektmappa beallitasa nem sikerult: ' + up.code)
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('egy munkadarabba bekerul a KEP es a SZOVEG is -- ez a vegyes tartalom', () => {
    expect(executeTool('workItem.addPart', { kind: 'text', text: 'A poszt szövege' }, ctx()).ok).toBe(true)
    expect(executeTool('workItem.addPart', { kind: 'image', path: 'foto.jpg' }, ctx()).ok).toBe(true)
    const r = executeTool('workItem.listParts', {}, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.data as any).count).toBe(2)
      expect((r.data as any).parts.map((p: any) => p.kind)).toEqual(['text', 'image'])
    }
  })

  it('a kep NEM johet a projektmappan kivulrol', () => {
    for (const bad of ['../kintrol.jpg', '/etc/passwd']) {
      const r = executeTool('workItem.addPart', { kind: 'image', path: bad }, ctx())
      expect(r.ok, `nem szabadott volna felvenni: ${bad}`).toBe(false)
      if (!r.ok) expect(JSON.stringify(r)).not.toContain('MAPPÁN KÍVÜL')
    }
  })

  it('nem letezo kepre a TENYLEGES hibauzenet megy vissza, nem talalgatas', () => {
    const r = executeTool('workItem.addPart', { kind: 'image', path: 'nincs-ilyen.jpg' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/ENOENT|no such file/i)
  })

  it('ures reszlista NEM nema: kimondja, hogy a munkadarab letezik es ures', () => {
    const r = executeTool('workItem.listParts', {}, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.data as any).count).toBe(0)
      expect((r.data as any).note).toMatch(/no parts yet/i)
    }
  })
})

describe('kanban.create -- a kod-javitas kartya, es MINDIG ehhez a projekthez kotodik', () => {
  it('a kartya a JELENLEGI projekthez kotodik, akkor is, ha a modell mast ir', () => {
    const other = createProject({ name: 'Idegen projekt' })
    if (!other.ok) throw new Error('projekt')
    const r = executeTool(
      'kanban.create',
      { title: 'A Munkapad gombja nem reagál', project: other.project.id, related: [] },
      ctx(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.data as any).project).toBe(projectId)
      const card = getKanbanCard((r.data as any).id)
      expect(card?.project).toBe(projectId)
    }
  })

  it('cim nelkul nem szuletik kartya', () => {
    const r = executeTool('kanban.create', { title: '  ' }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('bad_input')
  })

  it('ha vannak cimkek, cimke nelkul NEM jon letre kartya (a meglevo szabaly)', () => {
    createLabel({ id: 'lab1', name: 'marveen_fejlesztese', color: '#fff' })
    const r = executeTool('kanban.create', { title: 'Egy teljesen új dolog', related: [] }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/[Cc]ímke/)
  })

  it('a projekt alapertelmezett cimkeje magatol rakerul', () => {
    createLabel({ id: 'lab1', name: 'iroda_fejlesztese', color: '#fff' })
    const up = updateProject(projectId, { default_label_id: 'lab1' })
    if (!up.ok) throw new Error('cimke')
    const r = executeTool('kanban.create', { title: 'Egy teljesen új dolog', related: [] }, ctx())
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as any).labels).toEqual(['lab1'])
  })
})

// --- 6. fazis: FAJLMUVELETEK -----------------------------------------------
//
// Amit oriz:
//   1. egyik iro muvelet sem lat ki a projektmappabol;
//   2. SEMMI nem irodik felul csendben -- foglalt nevnel uj nev szuletik, es
//      a valasz KIMONDJA;
//   3. a torles nem torles: a Raktar Kukajaba visz, tehat visszaforditható;
//   4. minden eredmeny megkulonbozteti a "nincs semmi"-t a "nem latok oda"-tol.
describe('fajlmuveletek -- a projektmappa hatarain belul (6. fazis)', () => {
  let depot = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-fs-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'teszt', 'alkonyvtar'), { recursive: true })
    writeFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.txt'), 'Első változat.', 'utf-8')
    writeFileSync(join(depot, 'titok.txt'), 'EZ A MAPPÁN KÍVÜL VAN', 'utf-8')
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('a projektmappa beallitasa nem sikerult: ' + up.code)
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const data = (r: ReturnType<typeof executeTool>) => {
    if (!r.ok) throw new Error(`a muvelet elbukott: ${r.code} -- ${r.detail}`)
    return r.data as Record<string, unknown>
  }

  it('file.write uj fajlt ir a projektmappaba', () => {
    const d = data(executeTool('file.write', { path: 'uj.md', text: '# Cím' }, ctx()))
    expect(d.path).toBe('Projektek/teszt/uj.md')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'uj.md'), 'utf-8')).toBe('# Cím')
    expect(d.renamed).toBe(false)
  })

  it('file.write SOSE ir felul: foglalt nevnel uj nevet ad, es KIMONDJA', () => {
    const d = data(executeTool('file.write', { path: 'ajanlat.txt', text: 'Második változat.' }, ctx()))
    expect(d.renamed).toBe(true)
    expect(String(d.note)).toContain('ajanlat (2).txt')
    // Az eredeti erintetlen maradt -- ez a lenyeg.
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.txt'), 'utf-8')).toBe('Első változat.')
  })

  it('file.write a mappan KIVULRE nem ir', () => {
    const r = executeTool('file.write', { path: '../../titok.txt', text: 'x' }, ctx())
    expect(r.ok).toBe(false)
    expect(readFileSync(join(depot, 'titok.txt'), 'utf-8')).toBe('EZ A MAPPÁN KÍVÜL VAN')
  })

  it('file.copy masolatot keszit, az eredetit nem bantja', () => {
    const d = data(executeTool('file.copy', { path: 'ajanlat.txt', to: 'alkonyvtar/masolat.txt' }, ctx()))
    expect(d.path).toBe('Projektek/teszt/alkonyvtar/masolat.txt')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'alkonyvtar', 'masolat.txt'), 'utf-8')).toBe('Első változat.')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.txt'), 'utf-8')).toBe('Első változat.')
  })

  it('file.copy nem letezo forrasnal a TENYLEGES hibauzenetet adja vissza', () => {
    const r = executeTool('file.copy', { path: 'nincs-ilyen.txt', to: 'masolat.txt' }, ctx())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.code).toBe('not_found')
    // Nem talalgatott ok, hanem az eredeti uzenet.
    expect(r.detail).toContain('nincs-ilyen.txt')
  })

  it('file.move athelyez a projektmappan belul', () => {
    const d = data(executeTool('file.move', { path: 'ajanlat.txt', to: 'alkonyvtar' }, ctx()))
    expect(d.path).toBe('Projektek/teszt/alkonyvtar/ajanlat.txt')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'alkonyvtar', 'ajanlat.txt'), 'utf-8')).toBe('Első változat.')
  })

  it('file.rename atnevez, a mappa marad', () => {
    const d = data(executeTool('file.rename', { path: 'ajanlat.txt', name: 'ajanlat-vegleges.txt' }, ctx()))
    expect(d.path).toBe('Projektek/teszt/ajanlat-vegleges.txt')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat-vegleges.txt'), 'utf-8')).toBe('Első változat.')
  })

  it('file.delete NEM torol: a Kukaba visz, es ezt ki is mondja', () => {
    const d = data(executeTool('file.delete', { path: 'ajanlat.txt' }, ctx()))
    expect(d.trashed).toBe(true)
    expect(String(d.note)).toContain('Trash')
    // A fajl nincs mar a projektmappaban, de a lemezrol nem tunt el: az uj
    // utvonal a valaszban all, es oda tenyleg odakerult.
    expect(() => readFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.txt'), 'utf-8')).toThrow()
    expect(String(d.path).length).toBeGreaterThan(0)
  })

  it('file.preview megmondja, MIT tud megmutatni a bongeszo -- es mit nem, MIERT', () => {
    writeFileSync(join(depot, 'Projektek', 'teszt', 'terv.docx'), 'x', 'utf-8')
    const jo = data(executeTool('file.preview', { path: 'ajanlat.txt' }, ctx()))
    expect(jo.previewable).toBe(true)
    expect(jo.kind).toBe('text')
    const nem = data(executeTool('file.preview', { path: 'terv.docx' }, ctx()))
    expect(nem.previewable).toBe(false)
    expect(nem.kind).toBeNull()
    // A "nem" nem ures mezo: megmondja az okot.
    expect(String(nem.note).length).toBeGreaterThan(10)
  })
})

describe('projekt- es verzio-eszkozok (6. fazis)', () => {
  const data = (r: ReturnType<typeof executeTool>) => {
    if (!r.ok) throw new Error(`a muvelet elbukott: ${r.code} -- ${r.detail}`)
    return r.data as Record<string, unknown>
  }

  it('project.listWorkItems: az ures lista NEM hiba, ki is mondja', () => {
    const d = data(executeTool('project.listWorkItems', {}, ctx()))
    expect(d.count).toBe(1)
    expect(d.note).toBe('')
    const masik = createProject({ name: 'Ures projekt' })
    if (!masik.ok) throw new Error('projekt')
    const ures = data(executeTool('project.listWorkItems', { ...ctx(), projectId: masik.project.id }, { projectId: masik.project.id, workItemId: null, lang: 'hu' }))
    expect(ures.count).toBe(0)
    expect(String(ures.note)).toContain('no work items yet')
  })

  it('project.listKanban: nulla kartyanal kimondja, hogy nincs -- nem hallgat', () => {
    const d = data(executeTool('project.listKanban', {}, ctx()))
    expect(d.count).toBe(0)
    expect(String(d.note)).toContain('no open kanban card')
  })

  it('workItem.createVersion uj verziot ment', () => {
    const d = data(executeTool('workItem.createVersion', { id: workItemId }, ctx()))
    expect((d.version as { version_no: number }).version_no).toBe(2)
    expect(d.versions).toBe(2)
  })

  it('workItem.restoreVersion UJ verziot ir, es ezt kimondja', () => {
    const v1 = getWorkItem(workItemId)!.current_version_id as string
    executeTool('workItem.createVersion', { id: workItemId }, ctx())
    const d = data(executeTool('workItem.restoreVersion', { id: workItemId, version: v1 }, ctx()))
    expect((d.version as { version_no: number }).version_no).toBe(3)
    expect(String(d.note)).toContain('NEW version')
    // A regi verzio megmaradt: harom verzio van, nem egy felulirt.
    const lista = data(executeTool('workItem.listVersions', { id: workItemId }, ctx()))
    expect(lista.count).toBe(3)
  })

  it('workItem.restoreVersion IDEGEN verziot nem allit vissza', () => {
    const masik = createWorkItem({ project_id: projectId, title: 'Másik', type: 'note' })
    if (!masik.ok) throw new Error('munkadarab')
    const r = executeTool('workItem.restoreVersion', { id: workItemId, version: masik.version.id }, ctx())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.code).toBe('version_mismatch')
  })

  it('workItem.compareVersions: azonos verzioknal KIMONDJA, hogy nincs kulonbseg', () => {
    const v1 = getWorkItem(workItemId)!.current_version_id as string
    const v2 = data(executeTool('workItem.createVersion', { id: workItemId }, ctx())).version as { id: string }
    const d = data(executeTool('workItem.compareVersions', { id: workItemId, from: v1, to: v2.id }, ctx()))
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(String(d.note)).toContain('exactly the same')
  })

  it('workItem.compareVersions: ismeretlen verzional MEGMONDJA, MELYIK hianyzik', () => {
    const v1 = getWorkItem(workItemId)!.current_version_id as string
    const r = executeTool('workItem.compareVersions', { id: workItemId, from: v1, to: 'nincs-ilyen' }, ctx())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.code).toBe('version_not_found')
    expect(r.detail).toContain('nincs-ilyen')
  })
})

// ============================================================================
// 9. FAZIS -- A RAJZ AZ AGENS KEZEBEN
//
// A spec 9. pontja azt keri, hogy az agens STRUKTURALTAN tudjon szerkeszteni:
// "a cimet tedd 30%-kal nagyobbra es kozepre" -- ehhez az elemeknek allando
// NEVE (azonositoja) kell. Amit itt merunk: ugyanaz az ut, amit a felulet
// gombjai hasznalnak, es minden mentes UJ verzio.
// ============================================================================
describe('rajzvaszon-eszkozok (9. fazis)', () => {
  let depot = ''
  let rajzId = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-canvas-tool-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('a projektmappa beallitasa nem sikerult: ' + up.code)
    const w = createWorkItem({ project_id: projectId, title: 'Nyári plakát', type: 'graphic' })
    if (!w.ok) throw new Error('munkadarab')
    rajzId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const data = (r: ReturnType<typeof executeTool>) => {
    if (!r.ok) throw new Error(`a muvelet elbukott: ${r.code} -- ${r.detail}`)
    return r.data as Record<string, unknown>
  }
  const c = () => ({ projectId, workItemId: rajzId, lang: 'hu' as const })

  it('a ket eszkoz be van jegyezve, es a MEGLEVO autonomy-kategoriara kepez', () => {
    expect(getTool('canvas.get')!.autonomyCategory).toBeNull()
    expect(getTool('canvas.edit')!.autonomyCategory).toBe('workbench_file_write')
    // A rajzolas nem kuld semmit kifele, es a mentes visszafordithato (uj verzio).
    expect(getTool('canvas.edit')!.external_effect).toBe(false)
    expect(getTool('canvas.edit')!.reversible).toBe(true)
    expect(getTool('canvas.edit')!.destructive).toBe(false)
  })

  it('canvas.get meg nincs rajznal: URES vaszon + KIMONDJA, hogy meg nincs (nem hiba)', () => {
    const d = data(executeTool('canvas.get', { id: rajzId }, c()))
    expect(d.exists).toBe(false)
    expect((d.canvas as { objects: unknown[] }).objects).toEqual([])
    expect(String(d.note)).toMatch(/no drawing yet/i)
  })

  it('"a cimet tedd 30%-kal nagyobbra es kozepre": EGY hivas, es a rajz UJ verzio lesz', () => {
    data(executeTool('canvas.edit', {
      id: rajzId,
      ops: [{ op: 'canvas', width: 1000, height: 800 },
        { op: 'add', type: 'text', id: 'headline', text: 'Ride for less', x: 0, y: 0, width: 800, height: 120, fontSize: 72 }],
    }, c()))
    const d = data(executeTool('canvas.edit', {
      id: rajzId,
      ops: [{ op: 'scale', id: 'headline', factor: 1.3 }, { op: 'center', id: 'headline', axis: 'both' }],
    }, c()))
    const obj = (d.canvas as { objects: { id: string; fontSize: number; x: number }[] }).objects[0]
    expect(obj.id).toBe('headline')
    expect(obj.fontSize).toBeCloseTo(93.6, 1)
    // Uj verzio keletkezett, tehat a korabbi allapot megvan.
    expect(Number(d.version)).toBeGreaterThan(1)
  })

  it('nem letezo elemnel MEGMONDJA, mi van a vaszonon -- nem talalgat', () => {
    data(executeTool('canvas.edit', { id: rajzId, ops: [{ op: 'add', type: 'text', id: 'headline', text: 'x' }] }, c()))
    const r = executeTool('canvas.edit', { id: rajzId, ops: [{ op: 'center', id: 'cim' }] }, c())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.code).toBe('canvas_object_not_found')
    expect(r.detail).toContain('headline')
  })

  it('egy rossz muvelet az EGESZ koteget visszagorgeti -- nincs fel-elvegzett rajz', () => {
    data(executeTool('canvas.edit', { id: rajzId, ops: [{ op: 'add', type: 'text', id: 'a', text: 'elso' }] }, c()))
    const r = executeTool('canvas.edit', {
      id: rajzId,
      ops: [{ op: 'update', id: 'a', text: 'masodik' }, { op: 'center', id: 'nincs-ilyen' }],
    }, c())
    expect(r.ok).toBe(false)
    const d = data(executeTool('canvas.get', { id: rajzId }, c()))
    expect((d.canvas as { objects: { text: string }[] }).objects[0].text).toBe('elso')
  })

  it('a rajz a PROJEKT mappajaban all, es a felulet ugyanezt a fajlt latja', () => {
    const d = data(executeTool('canvas.edit', { id: rajzId, ops: [{ op: 'add', type: 'rect', id: 'keret' }] }, c()))
    expect(String(d.path)).toContain('Projektek/teszt/')
    expect(readFileSync(join(depot, String(d.path)), 'utf-8')).toContain('keret')
  })

  it('ismeretlen muvelet-nev: megmondja, MI hasznalhato helyette', () => {
    const r = executeTool('canvas.edit', { id: rajzId, ops: [{ op: 'forgatás', id: 'a' }] }, c())
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.detail).toContain('add')
    expect(r.detail).toContain('center')
  })

  it('IDEGEN projekt munkadarabjahoz nem nyul', () => {
    const masik = createProject({ name: 'Másik projekt' })
    if (!masik.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: masik.project.id, title: 'Idegen', type: 'graphic' })
    if (!w.ok) throw new Error('munkadarab')
    const r = executeTool('canvas.edit', { id: w.item.id, ops: [{ op: 'add', type: 'rect' }] }, c())
    expect(r.ok).toBe(false)
  })
})
