// #530 (Boss TG 8535): the Documents panel's "no limits (reading)" switch -- off by default, one switch per project,
// the per-document ticks go grey (keeping their value) while it is on. The real web/workbench.js runs.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const DOC = { id: 'd1', role: 'source', note: '', name: 'jegyzet.txt', life_rel: 'Család/jegyzet.txt', exists: true, created_at: 1, ai: false }

function docsBody(mode: string) {
  return { docs: [DOC], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], relatable: [], places: [], ai_access: mode, ai_access_modes: ['normal', 'read_all'] }
}

async function open(view = 'manual') {
  const h = workbenchHarness({ storage: { 'marveen.workbench.view': view } })
  let mode = 'normal'
  h.respond((url, init) => {
    if (url.includes('/api/workbench/project-ai-access')) {
      mode = JSON.parse(String(init?.body)).mode
      return { status: 200, body: { ok: true, ...docsBody(mode) } }
    }
    if (url.includes('/api/workbench/project-docs')) return { status: 200, body: docsBody(mode) }
    return { status: 200, body: itemsBody([]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Iroda')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
  h.click({ 'data-wb-act': 'pd-open' })
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-pd-access="1"'))
  return h
}

const change = (h: Awaited<ReturnType<typeof open>>, attr: string, checked: boolean) =>
  h.fire('change', { target: { checked, value: '', getAttribute: (k: string) => (k === attr ? '1' : null) } })

describe('Documents panel: "no limits (reading)"', () => {
  it('is off by default, with a one-sentence explanation; the per-document tick is live', async () => {
    const h = await open()
    const html = h.html()
    expect(html).toMatch(/<input type="checkbox" data-wb-pd-access="1">/)
    expect(html).toContain('⟦workbench.pd.access⟧')
    expect(html).toContain('⟦workbench.pd.access_explain⟧')
    expect(html).toMatch(/data-wb-pd-ai="d1"><\/?|data-wb-pd-ai="d1"> /)
    expect(html).not.toMatch(/data-wb-pd-ai="d1"[^>]*disabled/)
  })

  it('on: ONE patch with the mode value; the per-document ticks go grey but keep their (unticked) value', async () => {
    const h = await open()
    change(h, 'data-wb-pd-access', true)
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/project-ai-access') && c.init?.method === 'PATCH')).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/project-ai-access'))!
    expect(JSON.parse(String(call.init?.body))).toEqual({ project: 'p1', mode: 'read_all' })
    await vi.waitFor(() => expect(h.html()).toMatch(/data-wb-pd-access="1" checked/))
    const html = h.html()
    expect(html).toMatch(/data-wb-pd-ai="d1" disabled/)
    expect(html).not.toMatch(/data-wb-pd-ai="d1" checked/)
    expect(html).toContain('⟦workbench.pd.ai_overridden⟧')
    // Off again: the tick is live and unchanged.
    change(h, 'data-wb-pd-access', false)
    await vi.waitFor(() => expect(h.html()).not.toMatch(/data-wb-pd-access="1" checked/))
    expect(h.html()).not.toMatch(/data-wb-pd-ai="d1"[^>]*disabled/)
  })
})

// #530 (Boss TG 8541): the panel must be one labelled click away in BOTH views, not only in the Manual header.
describe('Documents panel reachable in both views', () => {
  for (const view of ['manual', 'simple']) {
    it(view + ' view: a visible labelled button opens the panel with the same content', async () => {
      const h = await open(view)
      const html = h.html()
      expect(html).toContain('data-wb-pd-access="1"')
      expect(html).toContain('data-wb-pd-ai="d1"')
      expect(html).toContain('⟦workbench.pd.role.source⟧')
      // Exactly one panel is drawn (not a second one in the technical details).
      expect(html.split('data-wb-pd-access="1"').length - 1).toBe(1)
    })
  }

  it('simple view: the button is in the top bar of an opened work item too', async () => {
    const h = workbenchHarness({ storage: { 'marveen.workbench.view': 'simple' } })
    const ITEM = { id: 'w1', project_id: 'p1', type: 'document', title: 'Beadvány', status: 'draft', created_at: 1, updated_at: 2 }
    h.respond((url) => {
      if (url.includes('/api/workbench/project-docs')) return { status: 200, body: docsBody('normal') }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [] } }
      return { status: 200, body: itemsBody([ITEM as never], { id: 'p1', name: 'Iroda', archived: false } as never) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-item'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-fr-top'))
    expect(h.html()).toMatch(/wb-fr-docs[^>]*data-wb-act="pd-open"/)
    expect(h.html()).toContain('⟦workbench.pd.open⟧')
    h.click({ 'data-wb-act': 'pd-open' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-fr-pop-docs'))
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-pd-access="1"'))
  })
})
