// Phase 5, presentation: the slide editor on a presentation work item. The real
// web/workbench.js runs; we check what it shows and what it sends. The slide's
// canvas goes through the SAME canvas editor (operations are wrapped as {op:"slide"}).
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

const PRES = { id: 'w1', title: 'Közgyűlés', type: 'presentation', status: 'draft', current_version_id: 'v1' }
const canvas = (objects: unknown[]) => ({ version: 1, width: 1920, height: 1080, background: '#ffffff', objects })
const TITLE = { id: 'title', type: 'text', x: 100, y: 100, width: 800, height: 120, opacity: 1, text: 'Szia', fontSize: 64, font: 'sans', color: '#111111', align: 'left', bold: true, italic: false }
const DECK = {
  version: 1, size: '16:9',
  slides: [{ id: 'd1', notes: 'Jegyzet', canvas: canvas([TITLE]) }, { id: 'd2', notes: '', canvas: canvas([]) }],
}
const GET = {
  deck: DECK, exists: true, limits: { sizes: ['16:9', '4:3'] }, current: true, draft: null,
  history: { can_undo: true, can_redo: false }, orphans: [], rel: 'x/a.deck.json', name: 'a.deck.json', version_id: 'v1', version_no: 1,
}

async function open(extra: Record<string, unknown> = {}) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/deck/ops')) return { status: 200, body: { ok: true, deck: DECK, applied: [{ op: 'addSlide', id: 'd3' }], created: false, ...extra } }
    if (url.includes('/deck/export')) {
      return { status: 201, body: { ok: true, file: { name: 'a.pptx', rel: 'x/a.pptx', bytes: 1 }, format: 'pptx', slides: 2, warnings: ['figyelmeztetes egy'], url: '/api/life/file?rel=x', item: PRES, versions: [] } }
    }
    if (url.includes('/deck')) return { status: 200, body: GET }
    if (url.includes('/api/workbench/media')) return { status: 200, body: { files: [] } }
    if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'deck' } }
    if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: PRES, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT } }
    return { status: 200, body: itemsBody([PRES]) }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('wb-deck-strip'))
  return h
}
const opsCall = (h: Awaited<ReturnType<typeof open>>) => h.fetchCalls.filter((c) => c.url.includes('/deck/ops')).map((c) => JSON.parse(String(c.init!.body)))

describe('slide editor (phase 5, presentation)', () => {
  it('shows the slide strip, the picked slide in the canvas editor, notes and the export buttons; no raw Hungarian', async () => {
    const h = await open()
    const html = h.html()
    expect(html).toContain('/deck/slide/d1.svg')
    expect(html).toContain('/deck/slide/d2.svg')
    expect(html).toContain('data-wb-box="title"')
    expect(html).toContain('Jegyzet')
    expect(html).toContain('data-wb-act="deck-export" data-wb-v="pptx"')
    expect(html).toContain('data-wb-act="deck-export" data-wb-v="pdf"')
    // the slide's own canvas is the editor: no second, separate drawing editor is shown
    expect(html).not.toContain('canvas-start')
    expect(html).not.toContain('canvas-brand-check')
    expect(untranslatedHungarian(html, ['Közgyűlés', 'Szia', 'Jegyzet', 'Kovács weboldal', 'Kovács'])).toBe('')
  })

  it('no request goes to the canvas routes of a presentation', async () => {
    const h = await open()
    expect(h.fetchCalls.some((c) => /\/canvas(\?|\/|$)/.test(c.url))).toBe(false)
  })

  it('picking another slide shows its canvas', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'deck-pick', 'data-wb-id': 'd2' })
    expect(h.html()).not.toContain('data-wb-box="title"')
    expect(h.html()).toContain('workbench.canvas.empty')
  })

  it('a canvas edit on the slide is sent as a slide operation of the deck', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'canvas-op', 'data-wb-op': 'center', 'data-wb-obj': 'title' })
    await vi.waitFor(() => expect(opsCall(h)).toHaveLength(1))
    const body = opsCall(h)[0]
    expect(body.ops).toHaveLength(1)
    expect(body.ops[0]).toMatchObject({ op: 'slide', id: 'd1' })
    expect(Array.isArray(body.ops[0].ops)).toBe(true)
  })

  it('moving a slide, duplicating, resizing the deck send the deck operations', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'deck-down', 'data-wb-id': 'd1' })
    await vi.waitFor(() => expect(opsCall(h)).toHaveLength(1))
    expect(opsCall(h)[0].ops).toEqual([{ op: 'moveSlide', id: 'd1', to: 2 }])
    await vi.waitFor(() => expect(h.html()).not.toMatch(/data-wb-act="deck-size"[^>]*disabled/))
    h.click({ 'data-wb-act': 'deck-size', 'data-wb-v': '4:3' })
    await vi.waitFor(() => expect(opsCall(h)).toHaveLength(2))
    expect(opsCall(h)[1].ops).toEqual([{ op: 'setSize', size: '4:3' }])
  })

  it('adding a slide sends the picked layout after the current slide', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'deck-add' })
    await vi.waitFor(() => expect(opsCall(h)).toHaveLength(1))
    expect(opsCall(h)[0].ops[0]).toMatchObject({ op: 'addSlide', layout: 'content', at: 2 })
  })

  it('notes are saved as setNotes on the picked slide', async () => {
    const h = await open()
    h.inputs['wbDeckNotes'] = { value: 'Új jegyzet', focus() {} } as never
    h.click({ 'data-wb-act': 'deck-notes' })
    await vi.waitFor(() => expect(opsCall(h)).toHaveLength(1))
    expect(opsCall(h)[0].ops).toEqual([{ op: 'setNotes', id: 'd1', notes: 'Új jegyzet' }])
  })

  it('export posts the format, then shows the file and the warnings', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'deck-export', 'data-wb-v': 'pptx' })
    await vi.waitFor(() => expect(h.html()).toContain('figyelmeztetes egy'))
    const call = h.fetchCalls.find((c) => c.url.includes('/deck/export'))!
    expect(JSON.parse(String(call.init!.body))).toEqual({ format: 'pptx' })
    expect(h.html()).toContain('workbench.deck.exported_file')
  })
})
