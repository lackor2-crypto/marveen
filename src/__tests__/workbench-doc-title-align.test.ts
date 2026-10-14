// #604 (Boss TG 3357): a chapter title takes an alignment of its own (it used to be text only), saved with the page.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { documentOutline, listSections } from '../workbench-docmodel.js'
import { toRenderOutline, outlineHash } from '../workbench-docrender.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('dokumentum-lap: a fejezetcim igazitasa (#604)', () => {
  let depot = ''
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-tt-'))
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the page save keeps a title alignment and the outline returns it', async () => {
    const s = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections`, 'POST', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    const r = await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', align: 'c', blocks: [] }], known: [sec] })
    expect(r.status).toBe(200)
    expect(listSections(itemId)[0].align).toBe('c')
    expect(documentOutline(itemId).sections[0].align).toBe('c')
    // an empty value takes it off again
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', align: '', blocks: [] }], known: [sec] })
    expect(documentOutline(itemId).sections[0].align).toBeNull()
  })

  it('the render outline and its hash follow the title alignment', () => {
    const base = { sections: [{ title: 'A', status: 'draft' as const, blocks: [] }] }
    const centred = { sections: [{ title: 'A', status: 'draft' as const, align: 'c', blocks: [] }] }
    expect(toRenderOutline(centred as never).sections[0].align).toBe('c')
    expect(outlineHash(toRenderOutline(base as never), 'x')).not.toBe(outlineHash(toRenderOutline(centred as never), 'x'))
  })

  it('the page draws the title with its alignment and the toolbar aligns a title', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("dpEditHtml('wb-dp-title' + dpAlignAttrs(sec.align).cls")
    expect(js).toContain("align: el ? (el.getAttribute('data-wb-align') || '') : ''")
    expect(js).toContain('dpTitleTarget()')
  })
})
