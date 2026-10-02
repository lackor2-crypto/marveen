/**
 * PRESENTATION DECK (v4 spec phase 5, presentation part): the document model and
 * the edit operations. Pure: no disk, no database. Saving (working copy, undo,
 * versions) is the shared draft store; the exports are `workbench-deck-export.ts`.
 *
 * A deck is a list of slides, and EVERY SLIDE IS A CANVAS: the same objects
 * (text, rectangle, picture, ellipse, line) and the same canvas operations as a
 * drawing (spec: "minden dia egy vaszon, ugyanazokkal a muveletekkel"). The slide
 * operation `slide` hands a list of canvas operations to one slide, so the owner
 * and the Workbench agent edit a slide exactly as they edit a drawing.
 */
import {
  applyCanvasOps, emptyCanvas, parseCanvas, canvasSummary, relayoutCanvas, renderCanvasSvg,
  type CanvasDoc, type CanvasOpNote, type RenderOptions,
} from './workbench-graphic.js'
import { isDeckFile } from './workbench-preview.js'
import { createDraftStore, type DraftKind, type DraftStore } from './workbench-draft-store.js'

export const DECK_EXT = '.deck.json'
export const DECK_MAX_SLIDES = 100
export const DECK_NOTES_MAX = 4000
export const DECK_FILE_MAX_BYTES = 8 * 1024 * 1024

export const DECK_SIZES = ['16:9', '4:3', 'card-eu', 'card-us', 'card-90'] as const
export type DeckSize = (typeof DECK_SIZES)[number]
export const DECK_PIXELS: Record<DeckSize, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '4:3': { width: 1440, height: 1080 },
  // Business cards (Boss, 2026-10-02): the size in pixels at 300 dpi, so the PPTX / PDF come out at the real
  // paper size (EU 85 x 55 mm, US 3.5 x 2 in, 90 x 50 mm). Data, dated: printers' own spec wins.
  'card-eu': { width: 1004, height: 650 },
  'card-us': { width: 1050, height: 600 },
  'card-90': { width: 1063, height: 591 },
}

/** A business-card deck: its pixels are 300 dpi (real paper size), and it has a front and a back. */
export const isCardSize = (size: string): boolean => size.startsWith('card-')
export const DECK_LAYOUTS = ['title', 'content', 'blank'] as const
export type DeckLayout = (typeof DECK_LAYOUTS)[number]

export interface DeckSlide { id: string; notes: string; canvas: CanvasDoc }
export interface DeckDoc { version: 1; size: DeckSize; slides: DeckSlide[] }

export type DeckFail = { ok: false; code: string; detail: string }
export type DeckOpsResult = { ok: true; doc: DeckDoc; applied: (CanvasOpNote | { op: string; id: string | null; note: string })[] } | DeckFail

export { isDeckFile }

export function emptyDeck(): DeckDoc {
  return { version: 1, size: '16:9', slides: [] }
}

const fail = (code: string, detail: string): DeckFail => ({ ok: false, code, detail })

function nextId(taken: string[]): string {
  const used = new Set(taken)
  let n = taken.length + 1
  while (used.has(`d${n}`)) n += 1
  return `d${n}`
}

/** Text boxes of a starting layout, in slide pixels (so they scale with the deck size). */
function layoutOps(layout: DeckLayout, w: number, h: number, title: string, body: string): Record<string, unknown>[] {
  if (layout === 'blank') return []
  const pad = Math.round(w * 0.06)
  const inner = w - 2 * pad
  if (layout === 'title') {
    return [
      { op: 'add', type: 'text', id: 'title', text: title, x: pad, y: Math.round(h * 0.32), width: inner, height: Math.round(h * 0.2), fontSize: Math.round(h * 0.085), bold: true, align: 'center', color: '#111111' },
      { op: 'add', type: 'text', id: 'subtitle', text: body, x: pad, y: Math.round(h * 0.56), width: inner, height: Math.round(h * 0.12), fontSize: Math.round(h * 0.04), align: 'center', color: '#555555' },
    ]
  }
  return [
    { op: 'add', type: 'text', id: 'title', text: title, x: pad, y: Math.round(h * 0.07), width: inner, height: Math.round(h * 0.14), fontSize: Math.round(h * 0.06), bold: true, color: '#111111' },
    { op: 'add', type: 'text', id: 'body', text: body, x: pad, y: Math.round(h * 0.26), width: inner, height: Math.round(h * 0.6), fontSize: Math.round(h * 0.038), color: '#222222' },
  ]
}

function newSlide(size: DeckSize, id: string, layout: DeckLayout, title: string, body: string): DeckSlide | DeckFail {
  const px = DECK_PIXELS[size]
  const base = emptyCanvas(px.width, px.height)
  const ops = layoutOps(layout, px.width, px.height, title, body)
  if (!ops.length) return { id, notes: '', canvas: base }
  const r = applyCanvasOps(base, ops)
  if (!r.ok) return fail(r.code, r.detail)
  return { id, notes: '', canvas: r.doc }
}

const isFail = (v: unknown): v is DeckFail => !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false

export function parseDeck(raw: unknown): { ok: true; doc: DeckDoc } | DeckFail {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: true, doc: emptyDeck() }
    try { value = JSON.parse(raw) } catch { return fail('deck_bad_shape', 'the deck file is not valid JSON') }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('deck_bad_shape', 'the deck must be an object with a size and slides')
  const v = value as Record<string, unknown>
  const size: DeckSize = (DECK_SIZES as readonly unknown[]).includes(v['size']) ? (v['size'] as DeckSize) : '16:9'
  const list = v['slides']
  if (list !== undefined && !Array.isArray(list)) return fail('deck_bad_shape', 'slides must be a list')
  const raws = Array.isArray(list) ? list : []
  if (raws.length > DECK_MAX_SLIDES) return fail('deck_too_many', `the deck holds ${raws.length} slides, the limit is ${DECK_MAX_SLIDES}`)
  const slides: DeckSlide[] = []
  const taken: string[] = []
  for (let i = 0; i < raws.length; i += 1) {
    const s = raws[i] as Record<string, unknown> | null
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail('deck_bad_shape', `slides[${i}] is not an object`)
    const c = parseCanvas(s['canvas'] ?? {})
    if (!c.ok) return fail(c.code, `slides[${i}]: ${c.detail}`)
    const rawId = typeof s['id'] === 'string' ? s['id'].trim() : ''
    const id = rawId && !taken.includes(rawId) ? rawId : nextId(taken)
    taken.push(id)
    slides.push({ id, notes: String(s['notes'] ?? '').slice(0, DECK_NOTES_MAX), canvas: c.doc })
  }
  return { ok: true, doc: { version: 1, size, slides } }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function applyDeckOps(input: DeckDoc, rawOps: unknown): DeckOpsResult {
  if (!Array.isArray(rawOps)) return fail('deck_bad_op', 'ops must be a list')
  if (!rawOps.length) return fail('deck_bad_op', 'ops is empty: there is nothing to do')
  if (rawOps.length > 100) return fail('deck_bad_op', 'at most 100 operations at once')
  const doc: DeckDoc = JSON.parse(JSON.stringify(input))
  const applied: { op: string; id: string | null; note: string }[] = []
  const find = (id: unknown): DeckSlide | DeckFail => doc.slides.find((s) => s.id === id) ?? fail('deck_slide_not_found', `no slide with id ${String(id)}`)

  for (const raw of rawOps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('deck_bad_op', 'every operation must be an object')
    const op = raw as Record<string, unknown>
    const name = String(op['op'] ?? '')
    switch (name) {
      case 'addSlide': {
        if (doc.slides.length >= DECK_MAX_SLIDES) return fail('deck_too_many', `at most ${DECK_MAX_SLIDES} slides`)
        const layout = (op['layout'] === undefined ? 'content' : op['layout']) as DeckLayout
        if (!(DECK_LAYOUTS as readonly unknown[]).includes(layout)) return fail('deck_bad_layout', `layout must be one of ${DECK_LAYOUTS.join(', ')}`)
        const id = nextId(doc.slides.map((s) => s.id))
        const s = newSlide(doc.size, id, layout, String(op['title'] ?? ''), String(op['body'] ?? ''))
        if (isFail(s)) return s
        const at = op['at'] === undefined ? doc.slides.length : Math.min(doc.slides.length, Math.max(0, Math.round(num(op['at']) ?? doc.slides.length) - 1))
        doc.slides.splice(at, 0, s)
        applied.push({ op: name, id, note: `slide added at position ${at + 1}` })
        break
      }
      case 'duplicateSlide': {
        const s = find(op['id'])
        if (isFail(s)) return s
        if (doc.slides.length >= DECK_MAX_SLIDES) return fail('deck_too_many', `at most ${DECK_MAX_SLIDES} slides`)
        const id = nextId(doc.slides.map((x) => x.id))
        const idx = doc.slides.indexOf(s)
        doc.slides.splice(idx + 1, 0, { ...JSON.parse(JSON.stringify(s)), id })
        applied.push({ op: name, id, note: `copy of ${s.id}` })
        break
      }
      case 'removeSlide': {
        const idx = doc.slides.findIndex((s) => s.id === op['id'])
        if (idx < 0) return fail('deck_slide_not_found', `no slide with id ${String(op['id'])}`)
        doc.slides.splice(idx, 1)
        applied.push({ op: name, id: String(op['id']), note: 'removed' })
        break
      }
      case 'moveSlide': {
        const idx = doc.slides.findIndex((s) => s.id === op['id'])
        if (idx < 0) return fail('deck_slide_not_found', `no slide with id ${String(op['id'])}`)
        const to = num(op['to'])
        if (to === null) return fail('deck_bad_value', 'to must be a position (1 = first)')
        const dest = Math.min(doc.slides.length - 1, Math.max(0, Math.round(to) - 1))
        const [s] = doc.slides.splice(idx, 1)
        doc.slides.splice(dest, 0, s)
        applied.push({ op: name, id: s.id, note: `now position ${dest + 1}` })
        break
      }
      case 'setNotes': {
        const s = find(op['id'])
        if (isFail(s)) return s
        const notes = String(op['notes'] ?? '')
        if (notes.length > DECK_NOTES_MAX) return fail('deck_notes_too_long', `the notes are ${notes.length} characters, the limit is ${DECK_NOTES_MAX}`)
        s.notes = notes
        applied.push({ op: name, id: s.id, note: 'speaker notes set' })
        break
      }
      case 'setSize': {
        if (!(DECK_SIZES as readonly unknown[]).includes(op['size'])) return fail('deck_bad_size', `size must be one of ${DECK_SIZES.join(', ')}`)
        doc.size = op['size'] as DeckSize
        const px = DECK_PIXELS[doc.size]
        for (const s of doc.slides) if (s.canvas.width !== px.width || s.canvas.height !== px.height) relayoutCanvas(s.canvas, px.width, px.height, null)
        applied.push({ op: name, id: null, note: `deck is now ${doc.size}, the slides rearranged` })
        break
      }
      case 'slide': {
        const s = find(op['id'])
        if (isFail(s)) return s
        const inner = op['ops']
        if (Array.isArray(inner) && inner.some((o) => o && typeof o === 'object' && ['canvas', 'resize'].includes(String((o as Record<string, unknown>)['op'] ?? '').toLowerCase()))) {
          return fail('deck_bad_op', 'the slide size follows the deck: use setSize, not canvas or resize')
        }
        const r = applyCanvasOps(s.canvas, inner)
        if (!r.ok) return fail(r.code, `slide ${s.id}: ${r.detail}`)
        s.canvas = r.doc
        for (const a of r.applied) applied.push({ op: `slide.${a.op}`, id: a.id, note: `${s.id}: ${a.note}` })
        break
      }
      default:
        return fail('deck_bad_op', `unknown operation "${name}" (allowed: addSlide, duplicateSlide, removeSlide, moveSlide, setNotes, setSize, slide)`)
    }
  }
  return { ok: true, doc, applied }
}

export function deckSummary(doc: DeckDoc): string {
  if (!doc.slides.length) return `empty deck, ${doc.size}`
  const lines = doc.slides.map((s, i) => `${i + 1}. ${s.id}: ${canvasSummary(s.canvas).slice(0, 160)}`)
  return `${doc.slides.length} slides, ${doc.size}\n${lines.join('\n')}`
}

/** The picture of one slide (SVG); the same renderer as a drawing. */
export function renderSlideSvg(slide: DeckSlide, opts: RenderOptions = {}): string {
  return renderCanvasSvg(slide.canvas, opts)
}

// ---- undo patches and the shared draft store ---------------------------------------

/** A step keeps only the slides that changed (a deck is large; most steps touch one slide), plus the order and size. */
export interface DeckPatch {
  bo: string[]; ao: string[]
  bs: DeckSize; as: DeckSize
  b: Record<string, DeckSlide>; a: Record<string, DeckSlide>
}

const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y)

export const deckKind: DraftKind<DeckDoc, DeckPatch> = {
  key: 'deck',
  ext: DECK_EXT,
  maxBytes: DECK_FILE_MAX_BYTES,
  empty: emptyDeck,
  parse: (raw) => {
    const p = parseDeck(raw)
    return p.ok ? { ok: true, doc: p.doc } : { ok: false, code: p.code, detail: p.detail }
  },
  isFile: (name) => isDeckFile(name),
  fileName: (title) => {
    const base = String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60)
    return `${base || 'prezentacio'}${DECK_EXT}`
  },
  baseName: (name) => String(name ?? '').replace(/ \(\d+\)(?=\.[^.]+$|$)/, ''),
  diff: (before, after) => {
    const bm = new Map(before.slides.map((s) => [s.id, s]))
    const am = new Map(after.slides.map((s) => [s.id, s]))
    const b: Record<string, DeckSlide> = {}
    const a: Record<string, DeckSlide> = {}
    for (const [id, s] of bm) if (!am.has(id) || !same(s, am.get(id))) b[id] = s
    for (const [id, s] of am) if (!bm.has(id) || !same(s, bm.get(id))) a[id] = s
    const bo = before.slides.map((s) => s.id)
    const ao = after.slides.map((s) => s.id)
    if (!Object.keys(b).length && !Object.keys(a).length && same(bo, ao) && before.size === after.size) return null
    return { bo, ao, bs: before.size, as: after.size, b, a }
  },
  apply: (doc, patch, dir) => {
    const undo = dir === 'undo'
    const expectOrder = undo ? patch.ao : patch.bo
    const expectSize = undo ? patch.as : patch.bs
    const expectSlides = undo ? patch.a : patch.b
    const targetOrder = undo ? patch.bo : patch.ao
    const targetSize = undo ? patch.bs : patch.as
    const targetSlides = undo ? patch.b : patch.a
    const conflict = { ok: false as const, code: 'deck_undo_conflict', detail: 'the deck was changed in another way since this step, so it cannot be undone safely' }
    if (!same(doc.slides.map((s) => s.id), expectOrder) || doc.size !== expectSize) return conflict
    const cur = new Map(doc.slides.map((s) => [s.id, s]))
    for (const [id, s] of Object.entries(expectSlides)) if (!same(cur.get(id), s)) return conflict
    for (const id of Object.keys(expectSlides)) cur.delete(id)
    for (const [id, s] of Object.entries(targetSlides)) cur.set(id, s)
    const slides: DeckSlide[] = []
    for (const id of targetOrder) {
      const s = cur.get(id)
      if (!s) return conflict
      slides.push(s)
    }
    return { ok: true, doc: { version: 1, size: targetSize, slides } }
  },
  // Big = slides removed in bulk, or a different deck size.
  isBig: (before, after) => {
    const ids = new Set(after.slides.map((s) => s.id))
    return before.slides.filter((s) => !ids.has(s.id)).length >= 2 || before.size !== after.size
  },
  count: (doc) => doc.slides.reduce((n, s) => n + s.canvas.objects.length, 0) + doc.slides.length,
}

let store: DraftStore<DeckDoc> | null = null
/** The one store of the presentation deck (created on first use). */
export function deckStore(): DraftStore<DeckDoc> {
  if (!store) store = createDraftStore(deckKind)
  return store
}
