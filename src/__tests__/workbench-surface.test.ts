// #441, K-3.2 + K-3.3 -- a munkadarab a munkatipus szerinti felulettel nyilik:
// rajznal a vaszon all elol, dokumentumnal a vazlat es az elonezet. A belso
// tartalomreszek, az allapot es a tobbi technikai adat a "⋮ Technikai
// reszletek" ala kerul -- torolve semmi nincs, kinyitva ugyanaz latszik.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const PROJECT = { id: 'p1', name: 'Kovács weboldal' }
const TEXT_PART = { id: 'pt1', kind: 'text', text: 'Belső szövegrész', position: 0 }

async function openItem(item: Record<string, unknown>, opts: { preview: Record<string, unknown>; parts?: unknown[]; canvas?: Record<string, unknown> }) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.indexOf('/preview') > 0) return { status: 200, body: opts.preview }
    if (/\/canvas(\?|$)/.test(url)) return { status: 200, body: opts.canvas || { exists: false } }
    if (url.indexOf('/api/workbench/items/') === 0) {
      return { status: 200, body: { item, versions: [], parts: opts.parts || [], part_kinds: ['text', 'image'], project: PROJECT } }
    }
    return { status: 200, body: itemsBody([item]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('wb-panel-editor'))
  return h
}

const PDF = {
  available: true, kind: 'pdf', mime: 'application/pdf', name: 'ajanlat.pdf',
  rel: 'Projektek/teszt/ajanlat.pdf', reason: null, message: null,
  url: '/api/life/file?rel=Projektek%2Fteszt%2Fajanlat.pdf&lang=hu',
}

describe('munkatipus szerinti felulet (K-3.3) es technikai reszletek (K-3.2)', () => {
  it('dokumentum fajl-elonezettel: a belso reszek osszecsukva, kinyitva ugyanazok', async () => {
    const h = await openItem({ id: 'w1', title: 'Ajánlat', type: 'document', status: 'draft' }, { preview: PDF, parts: [TEXT_PART] })
    await vi.waitFor(() => expect(h.html()).toContain('wb-pdf-slot'))
    const closed = h.html()
    expect(closed).toContain('data-wb-act="parts-tech-toggle"')
    expect(closed).not.toContain('Belső szövegrész')
    h.click({ 'data-wb-act': 'parts-tech-toggle' })
    expect(h.html()).toContain('Belső szövegrész')
    expect(h.html()).toContain('workbench.tech.parts_hint')
  })

  it('jegyzet (nincs mas felulet): a reszlista maga a tartalom, nem rejtjuk el', async () => {
    const h = await openItem({ id: 'w1', title: 'Jegyzet', type: 'note', status: 'draft' }, {
      preview: { available: true, kind: 'parts', reason: null, message: null }, parts: [TEXT_PART],
    })
    await vi.waitFor(() => expect(h.html()).toContain('Belső szövegrész'))
    expect(h.html()).not.toContain('data-wb-act="parts-tech-toggle"')
  })

  it('az allapot nem a fejlecben all, hanem a Technikai reszletekben', async () => {
    const h = await openItem({ id: 'w1', title: 'Ajánlat', type: 'document', status: 'draft', source_path: 'Munkadarabok/Ajanlat/ajanlat.pdf' }, { preview: PDF })
    await vi.waitFor(() => expect(h.html()).toContain('wb-pdf-slot'))
    const head = h.html().split('wb-editor-head')[1]!.split('</div>')[0]!
    expect(head).toContain('wb-pill')
    expect(head).not.toContain('workbench.status.draft')
    h.click({ 'data-wb-act': 'tech-toggle' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-tech-meta'))
    const meta = h.html().split('wb-tech-meta')[1]!.split('</ul>')[0]!
    expect(meta).toContain('workbench.status.draft')
    expect(meta).toContain('Munkadarabok/Ajanlat/ajanlat.pdf')
    expect(meta).toContain('w1')
  })

  it('rajz: a vaszon all az elonezet elott', async () => {
    const h = await openItem({ id: 'w1', title: 'Poszt', type: 'graphic', status: 'draft' }, {
      preview: { available: true, kind: 'image', mime: 'image/png', name: 'poszt.png', rel: 'x/poszt.png', url: '/api/life/file?rel=x%2Fposzt.png', reason: null, message: null },
    })
    await vi.waitFor(() => expect(h.html()).toContain('wb-preview-head'))
    const html = h.html()
    expect(html.indexOf('class="wb-can"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="wb-can"')).toBeLessThan(html.indexOf('wb-preview-head'))
  })
})
