// Phase 5, presentation: the deck model, its operations and the undo patches (pure).
import { describe, it, expect } from 'vitest'
import { emptyDeck, applyDeckOps, parseDeck, deckKind, isDeckFile, DECK_MAX_SLIDES, DECK_PIXELS, renderSlideSvg, deckSummary, type DeckDoc } from '../workbench-deck.js'

function ok(doc: DeckDoc, ops: unknown[]): DeckDoc {
  const r = applyDeckOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}

describe('deck operations', () => {
  it('addSlide with a layout makes a slide that is a canvas with text boxes at the deck size', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Közgyűlés', body: '2026' }])
    expect(d.slides).toHaveLength(1)
    const c = d.slides[0].canvas
    expect(c.width).toBe(1920)
    expect(c.height).toBe(1080)
    expect(c.objects.map((o) => o.id)).toEqual(['title', 'subtitle'])
    expect((c.objects[0] as { text: string }).text).toBe('Közgyűlés')
  })

  it('slides get stable ids, move, duplicate and remove', () => {
    let d = ok(emptyDeck(), [{ op: 'addSlide' }, { op: 'addSlide' }, { op: 'addSlide', layout: 'blank' }])
    expect(d.slides.map((s) => s.id)).toEqual(['d1', 'd2', 'd3'])
    d = ok(d, [{ op: 'moveSlide', id: 'd3', to: 1 }])
    expect(d.slides.map((s) => s.id)).toEqual(['d3', 'd1', 'd2'])
    d = ok(d, [{ op: 'duplicateSlide', id: 'd1' }])
    expect(d.slides.map((s) => s.id)).toEqual(['d3', 'd1', 'd4', 'd2'])
    d = ok(d, [{ op: 'removeSlide', id: 'd1' }])
    expect(d.slides.map((s) => s.id)).toEqual(['d3', 'd4', 'd2'])
    // a removed id is not handed out again while it could clash
    d = ok(d, [{ op: 'addSlide' }])
    expect(new Set(d.slides.map((s) => s.id)).size).toBe(4)
  })

  it('the slide operation runs canvas operations on that slide only', () => {
    const d0 = ok(emptyDeck(), [{ op: 'addSlide', layout: 'blank' }, { op: 'addSlide', layout: 'blank' }])
    const d = ok(d0, [{ op: 'slide', id: 'd2', ops: [{ op: 'add', type: 'rect', id: 'box', x: 10, y: 10, width: 100, height: 50, fill: '#ff0000' }] }])
    expect(d.slides[0].canvas.objects).toHaveLength(0)
    expect(d.slides[1].canvas.objects.map((o) => o.id)).toEqual(['box'])
  })

  it('refuses a canvas resize inside a slide (the size follows the deck)', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide', layout: 'blank' }])
    const r = applyDeckOps(d, [{ op: 'slide', id: 'd1', ops: [{ op: 'canvas', width: 500 }] }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('deck_bad_op')
  })

  it('setSize changes every slide to the new size', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide', layout: 'content', title: 'A', body: 'b' }, { op: 'setSize', size: '4:3' }])
    expect(d.size).toBe('4:3')
    expect(d.slides[0].canvas.width).toBe(DECK_PIXELS['4:3'].width)
    expect(d.slides[0].canvas.height).toBe(1080)
  })

  it('errors name the problem: unknown slide, bad layout, unknown op, too many slides', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide' }])
    const code = (ops: unknown) => { const r = applyDeckOps(d, ops); return r.ok ? 'ok' : r.code }
    expect(code([{ op: 'removeSlide', id: 'nincs' }])).toBe('deck_slide_not_found')
    expect(code([{ op: 'addSlide', layout: 'cirkusz' }])).toBe('deck_bad_layout')
    expect(code([{ op: 'rakéta' }])).toBe('deck_bad_op')
    expect(code([{ op: 'setSize', size: '1:1' }])).toBe('deck_bad_size')
    expect(code([])).toBe('deck_bad_op')
    const many = parseDeck({ slides: Array.from({ length: DECK_MAX_SLIDES + 1 }, () => ({ canvas: {} })) })
    expect(many.ok).toBe(false)
  })

  it('speaker notes are stored per slide', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide' }, { op: 'setNotes', id: 'd1', notes: 'Köszöntés' }])
    expect(d.slides[0].notes).toBe('Köszöntés')
  })

  it('parse repairs ids and keeps what is valid; garbage is an error with a code', () => {
    const p = parseDeck({ size: '4:3', slides: [{ id: 'x', canvas: {} }, { id: 'x', canvas: {} }] })
    expect(p.ok).toBe(true)
    if (p.ok) expect(new Set(p.doc.slides.map((s) => s.id)).size).toBe(2)
    expect(parseDeck('{nem json').ok).toBe(false)
    expect(parseDeck([]).ok).toBe(false)
  })

  it('a slide renders as SVG with its text', () => {
    const d = ok(emptyDeck(), [{ op: 'addSlide', layout: 'title', title: 'Szia' }])
    expect(renderSlideSvg(d.slides[0])).toContain('Szia')
    expect(deckSummary(d)).toContain('1 slides')
  })

  it('recognises the file name, also the free-name form', () => {
    expect(isDeckFile('a.deck.json')).toBe(true)
    expect(isDeckFile('a.deck (2).json')).toBe(true)
    expect(isDeckFile('a.canvas.json')).toBe(false)
  })
})

describe('deck undo patches', () => {
  const roundTrip = (before: DeckDoc, ops: unknown[]) => {
    const after = ok(before, ops)
    const patch = deckKind.diff(before, after)
    expect(patch).not.toBeNull()
    const undone = deckKind.apply(after, patch!, 'undo')
    expect(undone.ok && undone.doc).toEqual(before)
    const redone = deckKind.apply(undone.ok ? undone.doc : after, patch!, 'redo')
    expect(redone.ok && redone.doc).toEqual(after)
    return { after, patch: patch! }
  }

  it('undo and redo for an added slide, a moved slide, a removed slide, a slide edit, a size change', () => {
    const base = ok(emptyDeck(), [{ op: 'addSlide', layout: 'content', title: 'A', body: 'b' }, { op: 'addSlide', layout: 'blank' }, { op: 'addSlide', layout: 'blank' }])
    roundTrip(base, [{ op: 'addSlide', at: 2, layout: 'title', title: 'Új' }])
    roundTrip(base, [{ op: 'moveSlide', id: 'd3', to: 1 }])
    roundTrip(base, [{ op: 'removeSlide', id: 'd2' }])
    roundTrip(base, [{ op: 'slide', id: 'd1', ops: [{ op: 'update', id: 'title', text: 'Más' }] }])
    roundTrip(base, [{ op: 'setSize', size: '4:3' }])
  })

  it('the patch holds only the changed slides', () => {
    const base = ok(emptyDeck(), [{ op: 'addSlide' }, { op: 'addSlide' }, { op: 'addSlide' }])
    const { patch } = roundTrip(base, [{ op: 'setNotes', id: 'd2', notes: 'x' }])
    expect(Object.keys(patch.a)).toEqual(['d2'])
    expect(Object.keys(patch.b)).toEqual(['d2'])
  })

  it('no change, no patch; a deck changed in another way refuses the undo', () => {
    const base = ok(emptyDeck(), [{ op: 'addSlide' }])
    expect(deckKind.diff(base, base)).toBeNull()
    const after = ok(base, [{ op: 'setNotes', id: 'd1', notes: 'a' }])
    const patch = deckKind.diff(base, after)!
    const other = ok(after, [{ op: 'setNotes', id: 'd1', notes: 'más' }])
    const r = deckKind.apply(other, patch, 'undo')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('deck_undo_conflict')
  })
})
