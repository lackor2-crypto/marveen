// A rajzvaszon visszavonasi foltja (#441, v4 spec K-2.1): tiszta szamolas,
// lemez es adatbazis nelkul.
import { describe, it, expect } from 'vitest'
import { applyCanvasOps, emptyCanvas, type CanvasDoc } from '../workbench-graphic.js'
import { canvasDiff, applyCanvasPatch, canvasChangeIsBig, stableJson } from '../workbench-canvas-history.js'

function ops(doc: CanvasDoc, list: unknown[]): CanvasDoc {
  const r = applyCanvasOps(doc, list)
  if (!r.ok) throw new Error(r.code + ': ' + r.detail)
  return r.doc
}

const BASE = ops(emptyCanvas(1000, 800), [
  { op: 'add', object: { id: 'cim', type: 'text', text: 'Nyár', x: 10, y: 10, width: 400, height: 100 } },
  { op: 'add', object: { id: 'doboz', type: 'rect', x: 0, y: 200, width: 300, height: 200, fill: '#dddddd' } },
  { op: 'add', object: { id: 'logo', type: 'rect', x: 600, y: 600, width: 100, height: 100, fill: '#000000' } },
])

describe('canvasDiff / applyCanvasPatch', () => {
  it('nincs valtozas = nincs lepes', () => {
    expect(canvasDiff(BASE, JSON.parse(JSON.stringify(BASE)))).toBeNull()
  })

  it('minden muvelet oda-vissza lejatszhato: undo az elotte, redo az utana allapot', () => {
    const cases: unknown[][] = [
      [{ op: 'move', id: 'cim', dx: 40, dy: 5 }, { op: 'scale', id: 'cim', factor: 1.3 }],
      [{ op: 'remove', id: 'doboz' }],
      [{ op: 'add', object: { id: 'uj', type: 'text', text: 'x', x: 1, y: 1, width: 10, height: 10 } }],
      [{ op: 'order', id: 'cim', to: 'front' }],
      [{ op: 'canvas', width: 1080, height: 1920, background: '#000000' }],
    ]
    for (const c of cases) {
      const after = ops(BASE, c)
      const patch = canvasDiff(BASE, after)!
      expect(patch).not.toBeNull()
      const back = applyCanvasPatch(after, patch, 'undo')
      expect(back.ok && stableJson(back.doc)).toBe(stableJson(BASE))
      const fwd = applyCanvasPatch(BASE, patch, 'redo')
      expect(fwd.ok && stableJson(fwd.doc)).toBe(stableJson(after))
    }
  })

  it('csak az erintett elemek kerulnek a foltba, a torolt elem a helyere jon vissza', () => {
    const after = ops(BASE, [{ op: 'remove', id: 'doboz' }])
    const patch = canvasDiff(BASE, after)!
    expect(Object.keys(patch.objs)).toEqual(['doboz'])
    const back = applyCanvasPatch(after, patch, 'undo')
    expect(back.ok && back.doc.objects.map((o) => o.id)).toEqual(['cim', 'doboz', 'logo'])
  })

  it('ha kozben mas is valtoztatott az erintett elemen, NEM ir ra vakon, es megmondja, melyik', () => {
    const after = ops(BASE, [{ op: 'move', id: 'cim', dx: 40, dy: 0 }])
    const patch = canvasDiff(BASE, after)!
    const meddled = ops(after, [{ op: 'update', id: 'cim', patch: { text: 'Ősz' } }])
    const r = applyCanvasPatch(meddled, patch, 'undo')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('canvas_undo_conflict')
      expect(r.detail).toContain('"cim"')
    }
  })

  it('mas, nem erintett elem valtozasa nem akadalyozza a visszavonast', () => {
    const after = ops(BASE, [{ op: 'move', id: 'cim', dx: 40, dy: 0 }])
    const patch = canvasDiff(BASE, after)!
    const other = ops(after, [{ op: 'move', id: 'logo', dx: -10, dy: 0 }])
    const r = applyCanvasPatch(other, patch, 'undo')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.doc.objects.find((o) => o.id === 'cim')!.x).toBe(10)
      expect(r.doc.objects.find((o) => o.id === 'logo')!.x).toBe(590)
    }
  })
})

describe('canvasChangeIsBig (K-2.3: verzio a nagy agent-muvelet elott)', () => {
  it('egy elem atszinezese nem nagy; torles, atmeretezes, a legtobb elem mozgatasa nagy', () => {
    expect(canvasChangeIsBig(BASE, ops(BASE, [{ op: 'update', id: 'cim', patch: { color: '#ff0000' } }]))).toBe(false)
    expect(canvasChangeIsBig(BASE, ops(BASE, [{ op: 'remove', id: 'logo' }]))).toBe(true)
    expect(canvasChangeIsBig(BASE, ops(BASE, [{ op: 'canvas', width: 1080, height: 1920 }]))).toBe(true)
    expect(canvasChangeIsBig(BASE, ops(BASE, [
      { op: 'move', id: 'cim', dx: 1, dy: 0 }, { op: 'move', id: 'doboz', dx: 1, dy: 0 }, { op: 'move', id: 'logo', dx: 1, dy: 0 },
    ]))).toBe(true)
  })
})
