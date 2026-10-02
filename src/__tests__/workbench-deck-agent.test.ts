// The Workbench agent's presentation tools: same operations, store and undo as the owner's editor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { runTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'

describe('presentation deck: the Workbench agent', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')
  const ctx = () => ({ projectId: pid, workItemId: itemId, lang: 'en' as const })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-dka-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/teszt' })
    const w = createWorkItem({ project_id: pid, title: 'Közgyűlés', type: 'presentation' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the tools exist: read is free, edit and export are file writes', () => {
    expect(getTool('deck.get')?.autonomyCategory).toBeNull()
    expect(getTool('deck.edit')?.autonomyCategory).toBe('workbench_file_write')
    expect(getTool('deck.export')?.autonomyCategory).toBe('workbench_file_write')
  })

  it('get on a fresh item says there is no deck yet; one request is ONE undo step for the owner', async () => {
    const g: any = await runTool('deck.get', {}, ctx())
    expect(g.ok).toBe(true)
    expect(g.data.exists).toBe(false)
    expect(g.data.note).toMatch(/no slide deck yet/)
    const e: any = await runTool('deck.edit', { ops: [
      { op: 'addSlide', layout: 'title', title: 'Hello', body: 'World' },
      { op: 'addSlide', layout: 'content', title: 'Agenda', body: 'One' },
      { op: 'setNotes', id: 'd2', notes: 'say hi' },
    ] }, { ...ctx(), turnId: 't1' })
    expect(e.ok).toBe(true)
    expect(e.data.summary).toContain('2 slides')
    const g2: any = await runTool('deck.get', {}, ctx())
    expect(g2.data.slides.map((s: any) => s.id)).toEqual(['d1', 'd2'])
    expect(g2.data.slides[1].notes).toBe('say hi')
    const u = await callWorkbench(`/api/workbench/items/${itemId}/deck/undo`, 'POST')
    expect(u.status).toBe(200)
    expect(u.body.deck.slides).toHaveLength(0)
  })

  it('edits one slide with canvas operations by the layout ids', async () => {
    await runTool('deck.edit', { ops: [{ op: 'addSlide', layout: 'title', title: 'Old' }] }, ctx())
    const e: any = await runTool('deck.edit', { ops: [{ op: 'slide', id: 'd1', ops: [{ op: 'update', id: 'title', patch: { text: 'New' } }] }] }, ctx())
    expect(e.ok).toBe(true)
    const g: any = await runTool('deck.get', {}, ctx())
    expect(g.data.slides[0].canvas.objects.find((o: any) => o.id === 'title').text).toBe('New')
  })

  it('a bad operation is a code and a reason; a non-presentation item is refused', async () => {
    expect(await runTool('deck.edit', { ops: [{ op: 'removeSlide', id: 'zz' }] }, ctx())).toMatchObject({ ok: false, code: 'deck_slide_not_found' })
    const w = createWorkItem({ project_id: pid, title: 'Levél', type: 'document' })
    if (!w.ok) throw new Error('item')
    expect(await runTool('deck.get', { id: w.item.id }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
  })

  it('export: an empty deck is a plain failure; a pptx is a NEW file', async () => {
    expect(await runTool('deck.export', {}, ctx())).toMatchObject({ ok: false, code: 'deck_export_empty' })
    await runTool('deck.edit', { ops: [{ op: 'addSlide', layout: 'title', title: 'Hello' }] }, ctx())
    const x: any = await runTool('deck.export', { format: 'pptx' }, ctx())
    expect(x.ok).toBe(true)
    expect(existsSync(join(depot, x.data.path))).toBe(true)
    expect(await runTool('deck.export', { format: 'odp' }, ctx())).toMatchObject({ ok: false, code: 'bad_input' })
  })
})
