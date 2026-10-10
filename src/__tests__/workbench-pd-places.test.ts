// #530 (Boss TG 8544): the "Az ugy helye" list of the Documents panel shows what the system found,
// marks what was added by hand, offers "remove" only for those, and says "not reachable" for a detached tree.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const BASE = { docs: [], attachments: [], searching: 0, roles: ['source', 'reference', 'related'], close: { items: [], ready: true }, related: [], relatable: [], ai_access: 'normal', ai_access_modes: ['normal', 'read_all'] }

async function open(places: unknown[]) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/api/workbench/project-docs')) return { status: 200, body: { ...BASE, places } }
    return { status: 200, body: itemsBody([]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Iroda')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="pd-open"'))
  h.click({ 'data-wb-act': 'pd-open' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.pd.places_title'))
  return h
}

describe('Az ugy helye', () => {
  it('empty: says there is no document yet (not "no place given"); the add button is the secondary one', async () => {
    const h = await open([])
    const html = h.html()
    expect(html).toContain('⟦workbench.pd.places_none⟧')
    expect(html).toMatch(/class="btn-secondary" data-wb-act="pd-place-add"/)
    expect(html).toContain('⟦workbench.pd.places_add_hint⟧')
  })

  it('found places: count, reasons, "found automatically", and NO remove; a hand-added one has remove and its own mark', async () => {
    const h = await open([
      { rel: 'Család/Hatóság', exists: true, reachable: true, manual: false, auto: true, count: 2, reasons: [{ kind: 'source', name: 'a.pdf' }, { kind: 'attachment', name: 'b.pdf' }], more: 0 },
      { rel: 'Család/Kézi', exists: true, reachable: true, manual: true, auto: false, count: 0, reasons: [], more: 0 },
    ])
    const html = h.html()
    expect(html).toContain('⟦workbench.pd.places_auto⟧')
    expect(html).toContain('⟦workbench.pd.places_manual⟧')
    expect(html).toContain('⟦workbench.pd.place_reason.source⟧: a.pdf')
    expect(html.split('data-wb-act="pd-place-remove"').length - 1).toBe(1)
    expect(html).toContain('data-wb-act="pd-place-remove" data-wb-rel="Család/Kézi"')
    expect(html).toContain('(2)')
  })

  it('a detached Life tree: the row stays with "not reachable now", no open button', async () => {
    const h = await open([{ rel: 'Család/Hatóság', exists: false, reachable: false, manual: false, auto: true, count: 1, reasons: [{ kind: 'source', name: 'a.pdf' }], more: 0 }])
    const html = h.html()
    expect(html).toContain('⟦workbench.pd.places_unreachable⟧')
    expect(html).not.toContain('⟦workbench.pd.places_missing⟧')
    expect(html).not.toContain('data-wb-act="pd-place-open"')
  })
})
