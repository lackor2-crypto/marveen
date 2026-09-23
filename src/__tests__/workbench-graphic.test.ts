// AI Munkapad (kanban #336, 9. fazis): a STRUKTURALT rajz modellje.
//
// A spec 9 kikotese nem egy konyvtar neve, hanem ket dolog: az objektumoknak
// STABIL ID-juk legyen, es az agent STRUKTURALTAN modosithasson ("a cimet tedd
// 30%-kal nagyobbra es kozepre"). Ez a teszt pontosan ezt a ket dolgot meri --
// plusz azt, hogy a kimenet (SVG) fuggoseg NELKUL is elkeszul, mert egy frissen
// telepitett gepen sem CDN, sem kulso program nincs.
import { describe, it, expect } from 'vitest'
import {
  emptyCanvas, parseCanvas, applyCanvasOps, renderCanvasSvg, canvasSummary,
  isCanvasFile, canvasFileName, safeColor, slugCanvasId,
  CANVAS_MAX_OBJECTS, CANVAS_TEXT_MAX,
  type CanvasDoc, type CanvasText,
} from '../workbench-graphic.js'

function docWithHeadline(): CanvasDoc {
  const p = parseCanvas({
    width: 1000, height: 800, background: '#ffffff',
    objects: [{ id: 'headline', type: 'text', x: 100, y: 100, width: 800, height: 120, fontSize: 72, text: 'Ride for less' }],
  })
  if (!p.ok) throw new Error(p.detail)
  return p.doc
}

function textObj(doc: CanvasDoc, id: string): CanvasText {
  const o = doc.objects.find((x) => x.id === id)
  if (!o || o.type !== 'text') throw new Error(`nincs "${id}" szoveg-elem`)
  return o
}

describe('a vaszon modellje', () => {
  it('ures vaszon a kezdoallapot -- nem hiba', () => {
    const c = emptyCanvas()
    expect(c.objects).toEqual([])
    expect(c.width).toBeGreaterThan(0)
    expect(c.height).toBeGreaterThan(0)
    expect(canvasSummary(c)).toMatch(/empty/i)
  })

  it('a spec 9 peldaja valtozatlanul beolvashato, es a MEGADOTT id megmarad', () => {
    const doc = docWithHeadline()
    expect(doc.objects).toHaveLength(1)
    expect(doc.objects[0]!.id).toBe('headline')
    expect(textObj(doc, 'headline').fontSize).toBe(72)
    expect(textObj(doc, 'headline').text).toBe('Ride for less')
  })

  it('id NELKULI elem beszelo nevet kap a sajat szovegebol', () => {
    const p = parseCanvas({ objects: [{ type: 'text', text: 'Nyári akció' }] })
    if (!p.ok) throw new Error(p.detail)
    // Ekezet nelkul, hogy hivatkozni es kimondani is lehessen.
    expect(p.doc.objects[0]!.id).toBe('nyari-akcio')
  })

  it('ket azonos id nem letezhet: a masodik kap ujat (kulonben a hivatkozas ketertelmu)', () => {
    const p = parseCanvas({ objects: [{ id: 'cim', type: 'text', text: 'egy' }, { id: 'cim', type: 'text', text: 'ketto' }] })
    if (!p.ok) throw new Error(p.detail)
    const ids = p.doc.objects.map((o) => o.id)
    expect(ids[0]).toBe('cim')
    expect(new Set(ids).size).toBe(2)
  })

  it('romlott JSON: a RENDSZER sajat hibauzenete megy tovabb, nem talalgatunk', () => {
    const p = parseCanvas('{ ez nem json')
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('canvas_bad_json')
    expect(p.detail.length).toBeGreaterThan(5)
  })

  it('ures szoveg = ures vaszon (friss munkadarab), nem hiba', () => {
    const p = parseCanvas('')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.doc.objects).toEqual([])
  })

  it('ismeretlen elem-fajta: a hiba MEGNEVEZI, mi a baj es mi az engedett', () => {
    const p = parseCanvas({ objects: [{ type: 'hologram' }] })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('canvas_bad_object')
    expect(p.detail).toMatch(/hologram/)
    expect(p.detail).toMatch(/text/)
  })

  it('kep forras nelkul nem elem: megmondja, hogy fajl kell hozza', () => {
    const p = parseCanvas({ objects: [{ type: 'image' }] })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.detail).toMatch(/src/)
  })

  it('tul hosszu szoveg: a hatar es a MERT hossz is szerepel a valaszban', () => {
    const p = parseCanvas({ objects: [{ type: 'text', text: 'x'.repeat(CANVAS_TEXT_MAX + 1) }] })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('canvas_text_too_long')
    expect(p.detail).toMatch(String(CANVAS_TEXT_MAX))
  })

  it('tul sok elem: nem probaljuk meg kirajzolni', () => {
    const objects = Array.from({ length: CANVAS_MAX_OBJECTS + 1 }, (_, i) => ({ type: 'rect', id: `r${i}` }))
    const p = parseCanvas({ objects })
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.code).toBe('canvas_too_many')
  })

  it('a szin CSAK hexa lehet: egy beszurt CSS-darab nem jut at', () => {
    expect(safeColor('#ff0000', '#000000')).toBe('#ff0000')
    expect(safeColor('#F00', '#000000')).toBe('#f00')
    expect(safeColor('url(javascript:alert(1))', '#000000')).toBe('#000000')
    expect(safeColor('red; background:url(x)', '#000000')).toBe('#000000')
    expect(safeColor('none', '#000000')).toBe('none')
  })

  it('a slug sosem utkozik: a masodik ugyanolyan nev szamot kap', () => {
    const taken = new Set<string>()
    expect(slugCanvasId('Cím', 'text', taken)).toBe('cim')
    expect(slugCanvasId('Cím', 'text', taken)).toBe('cim-2')
  })
})

describe('strukturalt modositasok (ez az, amit az agent hiv)', () => {
  it('"tedd 30%-kal nagyobbra es kozepre" -- ket muvelet, EGY azonositora', () => {
    const doc = docWithHeadline()
    const r = applyCanvasOps(doc, [
      { op: 'scale', id: 'headline', factor: 1.3 },
      { op: 'center', id: 'headline', axis: 'both' },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const h = textObj(r.doc, 'headline')
    expect(h.fontSize).toBeCloseTo(93.6, 1)
    // Kozepre: a doboz kozepe a vaszon kozepere kerul.
    expect(h.x + h.width / 2).toBeCloseTo(r.doc.width / 2, 1)
    expect(h.y + h.height / 2).toBeCloseTo(r.doc.height / 2, 1)
    expect(r.applied).toHaveLength(2)
  })

  it('a meretezes a KOZEPPONT korul tortenik: nem csuszik el, amit nem kertek', () => {
    const doc = docWithHeadline()
    const before = textObj(doc, 'headline')
    const cx = before.x + before.width / 2
    const r = applyCanvasOps(doc, [{ op: 'scale', id: 'headline', factor: 2 }])
    if (!r.ok) throw new Error(r.detail)
    const after = textObj(r.doc, 'headline')
    expect(after.x + after.width / 2).toBeCloseTo(cx, 1)
  })

  it('az EREDETI vaszon valtozatlan marad (a hivo dont a mentesrol)', () => {
    const doc = docWithHeadline()
    applyCanvasOps(doc, [{ op: 'remove', id: 'headline' }])
    expect(doc.objects).toHaveLength(1)
  })

  it('nem letezo elem: a hiba FELSOROLJA, mi van a vaszonon', () => {
    const r = applyCanvasOps(docWithHeadline(), [{ op: 'scale', id: 'cim', factor: 1.3 }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('canvas_object_not_found')
    expect(r.detail).toMatch(/headline/)
  })

  it('ures vaszonnal is megmondja, hogy ures -- nem csak annyit, hogy "nincs"', () => {
    const r = applyCanvasOps(emptyCanvas(), [{ op: 'remove', id: 'barmi' }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toMatch(/empty/i)
  })

  it('EGY rossz lepes az EGESZ koteget visszadobja (nincs felig vegrehajtott utasitas)', () => {
    const doc = docWithHeadline()
    const r = applyCanvasOps(doc, [
      { op: 'update', id: 'headline', patch: { text: 'Uj cim' } },
      { op: 'scale', id: 'nincs-ilyen', factor: 2 },
    ])
    expect(r.ok).toBe(false)
    expect(textObj(doc, 'headline').text).toBe('Ride for less')
  })

  it('ismeretlen muvelet: felsorolja, mi hasznalhato', () => {
    const r = applyCanvasOps(docWithHeadline(), [{ op: 'varazsolj' }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toMatch(/varazsolj/)
    expect(r.detail).toMatch(/center/)
  })

  it('ures muvelet-lista: megmondja, hogy nincs mit tenni', () => {
    const r = applyCanvasOps(docWithHeadline(), [])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('canvas_bad_ops')
  })

  it('a javitas NEM irhatja at az azonositot es a fajtat (az a hivatkozast tenne tonkre)', () => {
    const r = applyCanvasOps(docWithHeadline(), [{ op: 'update', id: 'headline', patch: { id: 'mas', type: 'rect', fontSize: 40 } }])
    if (!r.ok) throw new Error(r.detail)
    expect(r.doc.objects[0]!.id).toBe('headline')
    expect(r.doc.objects[0]!.type).toBe('text')
    expect(textObj(r.doc, 'headline').fontSize).toBe(40)
  })

  it('uj elem hozzaadasa, mozgatas es sorrend', () => {
    const r = applyCanvasOps(docWithHeadline(), [
      { op: 'add', object: { type: 'rect', id: 'hatter', x: 0, y: 0, width: 1000, height: 800, fill: '#eeeeee' } },
      { op: 'order', id: 'hatter', to: 'back' },
      { op: 'move', id: 'headline', dx: 10, dy: -20 },
    ])
    if (!r.ok) throw new Error(r.detail)
    expect(r.doc.objects[0]!.id).toBe('hatter')
    expect(textObj(r.doc, 'headline').x).toBe(110)
    expect(textObj(r.doc, 'headline').y).toBe(80)
  })

  it('a vaszon merete is allithato', () => {
    const r = applyCanvasOps(docWithHeadline(), [{ op: 'canvas', width: 1920, height: 1080, background: '#000000' }])
    if (!r.ok) throw new Error(r.detail)
    expect(r.doc.width).toBe(1920)
    expect(r.doc.background).toBe('#000000')
  })

  it('a meretezes faktora csak pozitiv szam lehet, es ezt KI IS MONDJA', () => {
    const r = applyCanvasOps(docWithHeadline(), [{ op: 'scale', id: 'headline', factor: 0 }])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toMatch(/positive/i)
  })
})

describe('kep keszitese (SVG) -- fuggoseg nelkul', () => {
  it('a szoveg BELEKERUL a kepbe, es a vaszon merete a kep merete', () => {
    const svg = renderCanvasSvg(docWithHeadline())
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('width="1000"')
    expect(svg).toContain('Ride for less')
    expect(svg.trim().endsWith('</svg>')).toBe(true)
  })

  it('a szoveg nem torhet ki a kepbol: a < es a " escape-elve megy ki', () => {
    const p = parseCanvas({ objects: [{ type: 'text', text: '<script>alert("x")</script>' }] })
    if (!p.ok) throw new Error(p.detail)
    const svg = renderCanvasSvg(p.doc)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('hosszu szoveg tobb sorba tordelodik (nem log ki a vaszonrol)', () => {
    const p = parseCanvas({ objects: [{ type: 'text', width: 200, fontSize: 20, text: 'egy ket harom negy ot hat het nyolc kilenc tiz' }] })
    if (!p.ok) throw new Error(p.detail)
    const svg = renderCanvasSvg(p.doc)
    expect((svg.match(/<text /g) || []).length).toBeGreaterThan(1)
  })

  it('a kep BEAGYAZVA megy ki, hogy a letoltott fajl mashol is mukodjon', () => {
    const p = parseCanvas({ objects: [{ type: 'image', src: 'Projektek/teszt/kep.png' }] })
    if (!p.ok) throw new Error(p.detail)
    const svg = renderCanvasSvg(p.doc, { resolveImage: () => ({ ok: true, dataUri: 'data:image/png;base64,AAA' }) })
    expect(svg).toContain('data:image/png;base64,AAA')
  })

  it('a HIANYZO kep nem tunik el csendben: lathato tabla mondja meg, mi a baj', () => {
    const p = parseCanvas({ objects: [{ type: 'image', src: 'Projektek/teszt/nincs.png' }] })
    if (!p.ok) throw new Error(p.detail)
    const svg = renderCanvasSvg(p.doc, { resolveImage: () => ({ ok: false, note: 'the picture was not found in the Depot' }) })
    expect(svg).toContain('nincs.png')
    expect(svg).toContain('not found')
  })

  it('a kep-feloldo NELKUL sem omlik ossze: megmondja, hogy nincs beagyazva', () => {
    const p = parseCanvas({ objects: [{ type: 'image', src: 'kep.png' }] })
    if (!p.ok) throw new Error(p.detail)
    expect(renderCanvasSvg(p.doc)).toContain('kep.png')
  })
})

describe('fajlnevek', () => {
  it('felismeri a vaszon-fajlt', () => {
    expect(isCanvasFile('plakat.canvas.json')).toBe(true)
    expect(isCanvasFile('plakat.json')).toBe(false)
    expect(isCanvasFile(null)).toBe(false)
  })

  it('a cimbol ekezet nelkuli fajlnev lesz', () => {
    expect(canvasFileName('Nyári plakát')).toBe('nyari-plakat.canvas.json')
    // Cim nelkul sem lehet nevtelen a fajl.
    expect(canvasFileName('')).toBe('rajz.canvas.json')
  })
})

describe('fajlnev-felismeres: az atnevezett mentes is rajz', () => {
  it('a `(2)` valtozatot is rajznak latja (a fajl-iro sose ir felul)', () => {
    expect(isCanvasFile('nyari-plakat.canvas.json')).toBe(true)
    expect(isCanvasFile('nyari-plakat.canvas (2).json')).toBe(true)
    expect(isCanvasFile('nyari-plakat.canvas (17).json')).toBe(true)
    expect(isCanvasFile('NYARI-PLAKAT.CANVAS (3).JSON')).toBe(true)
  })

  it('a hasonlo, de MAS nevekre nem ugrik ra', () => {
    expect(isCanvasFile('adat.json')).toBe(false)
    expect(isCanvasFile('rajz.canvas.json.bak')).toBe(false)
    expect(isCanvasFile('rajz.canvas (masolat).json')).toBe(false)
    expect(isCanvasFile('canvas.png')).toBe(false)
  })
})

describe('az `add`/`update` KET alakja -- a koteg ne bukjon el formai okbol', () => {
  it('beagyazva (`object`) es lapitva is ugyanaz az eredmeny', () => {
    const a = applyCanvasOps(emptyCanvas(), [{ op: 'add', object: { type: 'text', id: 'cim', text: 'Szia' } }])
    const b = applyCanvasOps(emptyCanvas(), [{ op: 'add', type: 'text', id: 'cim', text: 'Szia' }])
    if (!a.ok || !b.ok) throw new Error('mindkettonek sikerulnie kell')
    expect(a.doc.objects[0]).toEqual(b.doc.objects[0])
  })

  it('`update`: a `patch` es a lapitott mezok ugyanoda visznek', () => {
    const base = applyCanvasOps(emptyCanvas(), [{ op: 'add', type: 'text', id: 'cim', text: 'Szia', fontSize: 40 }])
    if (!base.ok) throw new Error('alap')
    const a = applyCanvasOps(base.doc, [{ op: 'update', id: 'cim', patch: { fontSize: 60 } }])
    const b = applyCanvasOps(base.doc, [{ op: 'update', id: 'cim', fontSize: 60 }])
    if (!a.ok || !b.ok) throw new Error('mindkettonek sikerulnie kell')
    expect(a.doc.objects[0].fontSize).toBe(60)
    expect(b.doc.objects[0].fontSize).toBe(60)
  })

  it('ha az `object` OTT VAN, de nem objektum: megmondja, mit var', () => {
    const r = applyCanvasOps(emptyCanvas(), [{ op: 'add', object: 'szoveg' }])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.code).toBe('canvas_bad_ops')
    expect(r.detail).toContain('object')
  })

  it('`update` valtoztatando mezo nelkul: nem csendes siker, hanem mondat', () => {
    const base = applyCanvasOps(emptyCanvas(), [{ op: 'add', type: 'rect', id: 'keret' }])
    if (!base.ok) throw new Error('alap')
    const r = applyCanvasOps(base.doc, [{ op: 'update', id: 'keret' }])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('nem szabadna sikerulnie')
    expect(r.detail).toContain('patch')
  })
})
