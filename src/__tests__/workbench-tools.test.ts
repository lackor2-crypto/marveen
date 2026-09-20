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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
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

  it('a 2. fazisban EGYETLEN eszkoznek sincs kulso hatasa es egyik sem destruktiv', () => {
    // Ez a fazis kimondott igerete: csak olvasas es sajat, projekten beluli adat.
    expect(TOOLS.filter((t) => t.external_effect)).toEqual([])
    expect(TOOLS.filter((t) => t.destructive)).toEqual([])
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

  it('egy tulsagosan hosszu uzenet sem viszi el a keretet', () => {
    const rows: AgentMessageRow[] = [{ id: '1', session_id: 's', role: 'user', content: 'x'.repeat(50_000), created_at: 1 }]
    const out = historyMessages(rows)
    expect(out[0].content.length).toBeLessThan(5000)
  })
})
