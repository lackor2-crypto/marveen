// PPTX import (#501): export a deck, read it back, and the slides, text, shapes and pictures survive.
import { describe, it, expect } from 'vitest'
import { applyDeckOps, emptyDeck, type DeckDoc } from '../workbench-deck.js'
import { buildDeckPptx } from '../workbench-deck-pptx.js'
import { importPptx } from '../workbench-deck-import.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function sample(): DeckDoc {
  const r = applyDeckOps(emptyDeck(), [
    { op: 'addSlide', layout: 'title', title: 'Közgyűlés', body: '2026' },
    { op: 'addSlide', layout: 'blank' },
  ])
  if (!r.ok) throw new Error(r.detail)
  const s = applyDeckOps(r.doc, [{ op: 'slide', id: 'd2', ops: [
    { op: 'add', type: 'rect', id: 'box', x: 100, y: 100, width: 400, height: 200, fill: '#ff0000' },
    { op: 'add', type: 'image', id: 'pic', x: 600, y: 100, width: 300, height: 300, src: 'p/a.png' },
  ] }])
  if (!s.ok) throw new Error(s.detail)
  return s.doc
}

describe('importPptx', () => {
  it('reads slides, text, shapes and pictures back from an exported file', () => {
    const { bytes } = buildDeckPptx(sample(), () => ({ bytes: PNG, mime: 'image/png' }))
    const saved: string[] = []
    const r = importPptx(bytes, (name) => { saved.push(name); return `Proj/${name}` })
    if (!r.ok) throw new Error(r.detail)
    expect(r.deck.slides).toHaveLength(2)
    const first = r.deck.slides[0].canvas.objects.filter((o) => o.type === 'text') as { text: string }[]
    expect(first.map((o) => o.text)).toContain('Közgyűlés')
    const second = r.deck.slides[1].canvas.objects
    expect(second.some((o) => o.type === 'rect' && (o as { fill: string }).fill === '#ff0000')).toBe(true)
    expect(second.some((o) => o.type === 'image' && (o as { src: string }).src.startsWith('Proj/'))).toBe(true)
    expect(saved).toHaveLength(1)
  })

  it('says so for a file that is not a pptx', () => {
    const r = importPptx(Buffer.from('nope'), () => null)
    expect(r.ok).toBe(false)
  })
})
