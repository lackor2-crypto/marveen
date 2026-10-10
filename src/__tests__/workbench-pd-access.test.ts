// #530 (Boss TG 8535): the Documents panel's "no limits (reading)" switch -- off by default, one switch per project,
// the per-document ticks go grey (keeping their value) while it is on. The real web/workbench.js runs.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const DOC = { id: 'd1', role: 'source', note: '', name: 'jegyzet.txt', life_rel: 'Család/jegyzet.txt', exists: true, created_at: 1, ai: false }

function docsBody(mode: string) {
  return { docs: [DOC], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], relatable: [], places: [], ai_access: mode, ai_access_modes: ['normal', 'read_all'] }
}

async function open() {
  const h = workbenchHarness()
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
