// #758 (Boss TG 4421: 1A, 2A, 3A): the assistant's Work mode sheet (built-in default, the owner edits it, the
// assistant only proposes and the owner's click adds the rule), the context block, and the machine placement check
// after an upload / finalisation / Life-tree move that says so in the chat and moves nothing.
// PROJECT_ROOT and the agent dirs are redirected into an mkdtemp root, so nothing touches a live checkout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'wb-workmode-758-'))
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
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem } = await import('../workbench.js')
const { ensureWorkItemFolder } = await import('../workbench-assets.js')
const { executeTool } = await import('../workbench-agent/execute.js')
const { getTool } = await import('../workbench-agent/tools.js')
const { buildContext } = await import('../workbench-agent/context.js')
const { openSessionForWorkItem, listAgentMessages: listMessages } = await import('../workbench-agent/sessions.js')
const W = await import('../workbench-workmode.js')
const P = await import('../workbench-placement-check.js')

let depot = ''
let pid = ''
const projDir = () => join(depot, 'Projektek', 'Iroda')

beforeEach(() => {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'wb-workmode-depot-'))
  mkdirSync(projDir(), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
})
afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('the Work mode sheet', () => {
  it('a fresh install has the built-in default in the UI language, with the seven points', () => {
    const hu = W.getWorkmode('hu')
    expect(hu.custom).toBe(false)
    expect(hu.text).toBe(W.DEFAULT_WORKMODE.hu)
    expect(W.getWorkmode('en').text).toBe(W.DEFAULT_WORKMODE.en)
    for (const lang of ['hu', 'en'] as const) {
      expect(W.DEFAULT_WORKMODE[lang].length).toBeLessThanOrEqual(W.WORKMODE_IN_CONTEXT)
      for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(W.DEFAULT_WORKMODE[lang]).toMatch(new RegExp(`(^|\\n)${n}\\.`))
    }
  })
  it('the owner saves, and reset brings the default back', () => {
    expect(W.setWorkmode('  ', 'tulaj')).toEqual({ ok: false, code: 'workmode_text_required' })
    expect(W.setWorkmode('x'.repeat(W.WORKMODE_MAX_CHARS + 1), 'tulaj')).toEqual({ ok: false, code: 'workmode_text_too_long' })
    const r = W.setWorkmode('Saját szabály\r\n- egy', 'tulaj')
    expect(r.ok && r.state).toMatchObject({ text: 'Saját szabály\n- egy', custom: true, updated_by: 'tulaj' })
    expect(W.getWorkmode('en').text).toBe('Saját szabály\n- egy')
    expect(W.resetWorkmode('hu')).toMatchObject({ custom: false, text: W.DEFAULT_WORKMODE.hu })
  })
  it('a proposal is not on the sheet until accepted; accept appends exactly the preview, reject changes nothing', () => {
    const a = W.proposeWorkmodeRule({ rule: 'Az Agent mappát ne listázd újra', reason: 'kétszer kerestem', projectId: pid })
    if (!a.ok) throw new Error(a.code)
    expect(W.proposeWorkmodeRule({ rule: 'az agent mappát ne listázd újra' })).toEqual({ ok: false, code: 'workmode_duplicate' })
    expect(W.proposeWorkmodeRule({ rule: '' })).toEqual({ ok: false, code: 'workmode_rule_required' })
    expect(W.getWorkmode('hu').text).toBe(W.DEFAULT_WORKMODE.hu)
    const preview = W.sheetWithRule(W.getWorkmode('hu').text, a.proposal.rule)
    const d = W.decideWorkmodeProposal(a.proposal.id, true, 'tulaj', 'hu')
    if (!d.ok) throw new Error(d.code)
    expect(d.state.text).toBe(preview)
    expect(d.state.text.endsWith('\n- Az Agent mappát ne listázd újra')).toBe(true)
    expect(W.decideWorkmodeProposal(a.proposal.id, true, 'tulaj', 'hu')).toEqual({ ok: false, code: 'workmode_already_decided' })
    const b = W.proposeWorkmodeRule({ rule: 'Másik' })
    if (!b.ok) throw new Error(b.code)
    const before = W.getWorkmode('hu').text
    expect(W.decideWorkmodeProposal(b.proposal.id, false, 'tulaj', 'hu').ok).toBe(true)
    expect(W.getWorkmode('hu').text).toBe(before)
    expect(W.listWorkmodeProposals('pending')).toEqual([])
    expect(W.decideWorkmodeProposal('nincs', true, null, 'hu')).toEqual({ ok: false, code: 'workmode_not_found' })
  })
  it('the open proposals are capped', () => {
    for (let i = 0; i < W.WORKMODE_MAX_PENDING; i++) expect(W.proposeWorkmodeRule({ rule: `szabály ${i}` }).ok).toBe(true)
    expect(W.proposeWorkmodeRule({ rule: 'egy több' })).toEqual({ ok: false, code: 'workmode_too_many_pending' })
  })
})

describe('the assistant reads the sheet and only proposes', () => {
  it('workmode.propose is a self-dev, non-destructive tool that only leaves a pending proposal', () => {
    const t = getTool('workmode.propose')
    expect(t?.autonomyCategory).toBe('marveen_selfdev')
    expect(t?.destructive).toBeFalsy()
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld', type: 'document' })
    if (!w.ok) throw new Error('item')
    const r = executeTool('workmode.propose', { rule: 'Kutatás előtt nézd meg a mentett kutatásokat', reason: 'újrakerestem' },
      { projectId: pid, workItemId: w.item.id, lang: 'hu' }) as any
    expect(r.ok).toBe(true)
    expect(W.listWorkmodeProposals('pending')).toMatchObject([{ rule: 'Kutatás előtt nézd meg a mentett kutatásokat', work_item_id: w.item.id }])
    expect(W.getWorkmode('hu').custom).toBe(false)
    expect(executeTool('workmode.propose', { rule: '' }, { projectId: pid, workItemId: null, lang: 'hu' })).toMatchObject({ ok: false })
  })
  it('the context carries the sheet in every turn, and the open proposals so they are not proposed again', async () => {
    W.setWorkmode('EGYEDI-LAP-758', 'tulaj')
    W.proposeWorkmodeRule({ rule: 'NYITOTT-JAVASLAT' })
    const c = await buildContext(getProject(pid)!, null, 'hu')
    expect(c.parts.map((p) => p.key)).toContain('workmode')
    expect(c.contextText).toContain('EGYEDI-LAP-758')
    expect(c.contextText).toContain('NYITOTT-JAVASLAT')
    expect(c.system).toContain('workmode.propose')
  })
})

describe('the machine placement check (3A)', () => {
  it('reports the hard verdicts of the item\'s own folder in its chat, once, and moves nothing', () => {
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const base = join(projDir(), f.folder)
    const put = (rel: string, name: string) => { mkdirSync(join(base, rel), { recursive: true }); const p = join(base, rel, name); writeFileSync(p, 'x'); return p }
    const files = [put('Elkészített anyagok', 'K7_Mietvertrag.pdf'), put('Elkészített anyagok', 'Kérelem.pdf'), put('Agent', 'minta.png')]
    const item = { ...w.item, folder: f.folder }
    const r = P.checkPlacementAfter(item, 'upload', 'hu')
    expect(r.issues).toBe(1)
    expect(r.note).toContain('K7_Mietvertrag.pdf')
    expect(r.note).not.toContain('minta.png')
    expect(r.note).toContain('Nem mozdítottam el semmit')
    const s = openSessionForWorkItem(pid, w.item.id, 'hu')
    const count = () => listMessages(s.id).filter((m: any) => m.role === 'assistant' && String(m.content).includes('K7_Mietvertrag.pdf')).length
    expect(count()).toBe(1)
    P.checkPlacementAfter(item, 'upload', 'hu')
    expect(count()).toBe(1)
    for (const x of files) expect(existsSync(x)).toBe(true)
  })
  it('a clean item says nothing; an item without a folder is not an error', () => {
    const w = createWorkItem({ project_id: pid, title: 'Tiszta', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    expect(P.checkPlacementAfter({ ...w.item, folder: f.folder }, 'finalize', 'en')).toMatchObject({ issues: 0, note: null })
    expect(P.checkPlacementAfter({ ...w.item, project_id: 'nincs' }, 'finalize', 'en').issues).toBe(-1)
  })
  it('a Life-tree move of an attachment into the Finished materials is flagged by the target folder', () => {
    const got = P.lifeMoveIssues([
      { newRel: 'Lakás/Wohngeld/Elkészített anyagok/K13_Bescheid.pdf' },
      { newRel: 'Lakás/Wohngeld/Elkészített anyagok/Kérelem.pdf' },
      { newRel: 'Lakás/Wohngeld/Mellékletek/K13_Bescheid.pdf' },
      { newRel: 'egy.pdf' },
    ])
    expect(got).toEqual([{ folder: 'Lakás/Wohngeld/Elkészített anyagok', name: 'K13_Bescheid.pdf', code: 'attachment_in_finished' }])
    const note = P.placementNote(got, 'life_move', 'en')
    expect(note).toContain('the move into the Life tree')
    expect(note).toContain('I did not move anything')
  })
  it('a long list is cut in the note, with the rest counted', () => {
    const many = Array.from({ length: P.PLACEMENT_NOTE_MAX + 3 }, (_, i) => ({ folder: 'a', name: `K${i}.pdf`, code: 'attachment_in_finished' as const }))
    const note = P.placementNote(many, 'upload', 'hu')
    expect(note.split('\n').filter((l) => l.startsWith('- ')).length).toBe(P.PLACEMENT_NOTE_MAX)
    expect(note).toContain('és még 3')
  })
})
