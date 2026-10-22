// #757: the work item's research -- links, the three groups (this item / same
// folder / rest of the project), the assistant's research.list / research.read,
// research.save linking to the open work item, and the context block.
// PROJECT_ROOT and the agent dirs are redirected into an mkdtemp root (same
// sandbox as research-routes.test.ts), so nothing touches a live checkout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'wb-research-757-'))
const AGENTS_TMP = join(tmpRoot, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return {
    ...actual,
    AGENTS_BASE_DIR: AGENTS_TMP,
    agentDir: (name: string) => join(AGENTS_TMP, name),
    agentConfigRoot: (name: string) => (name === MAIN_AGENT_ID ? tmpRoot : join(AGENTS_TMP, name)),
    listAgentNames: () =>
      existsSync(AGENTS_TMP) ? readdirSync(AGENTS_TMP).filter((f) => statSync(join(AGENTS_TMP, f)).isDirectory()) : [],
  }
})

const { initDatabase } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { createWorkItem } = await import('../workbench.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { executeTool } = await import('../workbench-agent/execute.js')
const { getTool } = await import('../workbench-agent/tools.js')
const R = await import('../workbench-research.js')

const RDIR = join(tmpRoot, 'research')
let pid = ''
let otherPid = ''

function seed(name: string, title: string, project: string, body = 'tartalom'): string {
  writeFileSync(join(RDIR, name), `# ${title}\n\nproject: ${project}\n\n${body}\n`)
  return `${MAIN_AGENT_ID}/${name}`
}
function item(title: string, container: string) {
  const r = createWorkItem({ project_id: pid, title, container_folder: container })
  if (!r.ok) throw new Error(r.code)
  return r.item
}
const ctx = (workItemId: string | null) => ({ projectId: pid, workItemId, lang: 'hu' as const })

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(RDIR, { recursive: true, force: true })
  mkdirSync(RDIR, { recursive: true })
  const p = createProject({ name: 'Kovács-ház' })
  const o = createProject({ name: 'Idegen' })
  if (!p.ok || !o.ok) throw new Error('projekt')
  pid = p.project.id
  otherPid = o.project.id
})
afterEach(() => { rmSync(RDIR, { recursive: true, force: true }) })

describe('eszkozok', () => {
  it('research.list es research.read olvaso eszkoz (nincs jovahagyas)', () => {
    expect(getTool('research.list')?.autonomyCategory).toBeNull()
    expect(getTool('research.read')?.autonomyCategory).toBeNull()
  })
})

describe('kotes es csoportok', () => {
  it('harom csoport: ehhez kotott, azonos mappaban kotott, a projekt tobbi', () => {
    const a = item('Terv A', 'Kert')
    const b = item('Terv B', 'Kert')
    const c = item('Terv C', 'Haz')
    const r1 = seed('egy.md', 'Egy', pid)
    const r2 = seed('ketto.md', 'Kettő', pid)
    const r3 = seed('harom.md', 'Három', pid)
    seed('idegen.md', 'Idegen', otherPid)
    expect(R.linkResearch(a, r1, 'tulaj')).toEqual({ ok: true })
    expect(R.linkResearch(b, r2, 'tulaj')).toEqual({ ok: true })
    expect(R.linkResearch(c, r3, 'tulaj')).toEqual({ ok: true })
    const g = R.researchForItem(pid, a)
    expect(g.item.map((d) => d.id)).toEqual([r1])
    expect(g.folder.map((d) => d.id)).toEqual([r2])
    expect(g.others.map((d) => d.id)).toEqual([r3])
    // a masik projekt kutatasa sehol
    expect([...g.item, ...g.folder, ...g.others].some((d) => d.name === 'idegen.md')).toBe(false)
  })

  it('masik projekt kutatasa nem kotheto, nem letezo sem; a kotes idempotens, a bontas a fajlt nem torli', () => {
    const a = item('Terv A', 'Kert')
    const foreign = seed('idegen.md', 'Idegen', otherPid)
    expect(R.linkResearch(a, foreign, null)).toEqual({ ok: false, code: 'other_project' })
    expect(R.linkResearch(a, `${MAIN_AGENT_ID}/nincs.md`, null)).toEqual({ ok: false, code: 'not_found' })
    expect(R.linkResearch(a, '../x.md', null)).toEqual({ ok: false, code: 'not_found' })
    const own = seed('sajat.md', 'Saját', pid)
    expect(R.linkResearch(a, own, null).ok).toBe(true)
    expect(R.linkResearch(a, own, null).ok).toBe(true)
    expect(R.researchForItem(pid, a).item).toHaveLength(1)
    expect(R.unlinkResearch(a.id, own)).toBe(true)
    expect(R.unlinkResearch(a.id, own)).toBe(false)
    expect(existsSync(join(RDIR, 'sajat.md'))).toBe(true)
    expect(R.researchForItem(pid, a).others.map((d) => d.id)).toEqual([own])
  })
})

describe('olvasas', () => {
  it('szeletben olvas, a masik projektet nem adja ki', () => {
    const long = 'x'.repeat(R.RESEARCH_READ_MAX_CHARS + 50)
    const id = seed('hosszu.md', 'Hosszú', pid, long)
    const first = R.readProjectResearch(pid, id)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.doc.title).toBe('Hosszú')
    expect(first.doc.text).toHaveLength(R.RESEARCH_READ_MAX_CHARS)
    expect(first.doc.more).toBe(true)
    const second = R.readProjectResearch(pid, id, first.doc.text.length)
    expect(second.ok && second.doc.more).toBe(false)
    expect(R.readProjectResearch(otherPid, id)).toEqual({ ok: false, code: 'other_project' })
  })

  it('research.read eszkoz: next offset, rossz id hiba', () => {
    const id = seed('rovid.md', 'Rövid', pid, 'Ár: 1 Ft')
    const r = executeTool('research.read', { id }, ctx(null)) as any
    expect(r.ok).toBe(true)
    expect(r.data.text).toContain('Ár: 1 Ft')
    expect(r.data.next).toBeNull()
    expect(executeTool('research.read', {}, ctx(null))).toMatchObject({ ok: false, code: 'bad_input' })
    expect(executeTool('research.read', { id: `${MAIN_AGENT_ID}/nincs.md` }, ctx(null))).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('asszisztens', () => {
  it('research.list a megnyitott munkadarabbol nez; ures projektnel kimondja, hogy olvasta es ures', () => {
    const a = item('Terv A', 'Kert')
    const empty = executeTool('research.list', {}, ctx(a.id)) as any
    expect(empty).toMatchObject({ ok: true, data: { count: 0 } })
    expect(empty.data.note).toMatch(/no document yet/)
    const id = seed('egy.md', 'Egy', pid)
    R.linkResearch(a, id, null)
    const l = executeTool('research.list', {}, ctx(a.id)) as any
    expect(l.data.linkedToThisItem.map((d: any) => d.id)).toEqual([id])
    expect(executeTool('research.list', { id: 'nincs-ilyen' }, ctx(null))).toMatchObject({ ok: false, code: 'work_item_not_found' })
  })

  it('research.save a megnyitott munkadarabhoz koti az uj kutatast', () => {
    const a = item('Terv A', 'Kert')
    const r = executeTool('research.save', { title: 'Hőszivattyú árak', text: '- A: 1 Ft' }, ctx(a.id)) as any
    expect(r.ok).toBe(true)
    expect(r.data.linkedToWorkItem).toBe(a.id)
    expect(R.researchForItem(pid, a).item.map((d) => d.id)).toEqual([r.data.id])
    const noItem = executeTool('research.save', { title: 'Másik', text: 'y' }, ctx(null)) as any
    expect(noItem.data.linkedToWorkItem).toBeNull()
  })

  it('a kontextus-blokk felsorolja a kotott kutatast, es a webes kereses elott olvastat', () => {
    const a = item('Terv A', 'Kert')
    expect(R.researchForContext(pid, a)).toMatch(/none yet/)
    const id = seed('egy.md', 'Egy', pid)
    R.linkResearch(a, id, null)
    seed('ketto.md', 'Kettő', pid)
    const t = R.researchForContext(pid, a)
    expect(t).toContain(`- ${id} "Egy"`)
    expect(t).toMatch(/research\.read BEFORE you search the web/)
    expect(t).toContain('1 more in the project')
  })
})

describe('mappa', () => {
  it('a munkadarab mappaja: a sajat mappa szuloje, kulonben a container_folder', () => {
    expect(R.itemContainer({ folder: 'Kert/Terv A', container_folder: null })).toBe('Kert')
    expect(R.itemContainer({ folder: 'Terv A', container_folder: null })).toBeNull()
    expect(R.itemContainer({ folder: null, container_folder: 'Haz' })).toBe('Haz')
  })
})
