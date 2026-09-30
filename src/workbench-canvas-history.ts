/**
 * A RAJZVASZON VISSZAVONASI NAPLOJA -- a tiszta resz (#441, v4 spec K-2.1).
 *
 * A spec: "Mivel minden muvelet mar kozos es nevesitett, mindegyikhez tartozhat
 * egy ellentetes muvelet." A szakma (Figma, tldraw, Excalidraw) ezt nem
 * muveletenkent kezzel megirt forditottakkal oldja meg, hanem VALTOZAS-
 * FOLTTAL: egy lepes = az erintett elemek allapota ELOTTE es UTANA. A folt
 * mindket iranyba lejatszhato, es barmelyik muvelet (a mostaniak es a
 * kesobbiek: forgatas, csoportositas, ...) ugyanigy visszavonhato -- nem kell
 * minden uj muvelethez kulon ellentetet irni, ami el tudna csuszni az
 * eredetitol.
 *
 * Ez a modul NEM nyul se a lemezhez, se az adatbazishoz: tisztan szamol, ezert
 * tesztelheto. A tarolas a `workbench-canvas-store.ts`-ben van.
 *
 * A visszavonas csak akkor fut le, ha a vaszon MOST pontosan abban az
 * allapotban van, amit a lepes utan hagyott. Ha kozben mas is valtoztatott
 * rajta, a folt NEM ir ra vakon: megmondja, MELYIK elem mas, mint vartuk.
 */
import type { CanvasDoc, CanvasObject } from './workbench-graphic.js'

/** A vaszon sajat tulajdonsagai (ami nem elem). */
export interface CanvasProps { width: number; height: number; background: string }

/** Egy lepes: minden erintett elem ELOTTE (`b`) es UTANA (`a`). A `null` azt
 *  jelenti, hogy az elem akkor nem letezett (hozzaadas / torles). A sorrend
 *  csak akkor all benne, ha valtozott. */
export interface CanvasPatch {
  props?: { b: CanvasProps; a: CanvasProps }
  objs: Record<string, { b: CanvasObject | null; a: CanvasObject | null }>
  order?: { b: string[]; a: string[] }
}

export type CanvasPatchApply =
  | { ok: true; doc: CanvasDoc }
  | { ok: false; code: 'canvas_undo_conflict'; detail: string }

/** Kulcs-sorrendtol fuggetlen osszehasonlitas: az adatbazisbol visszaolvasott
 *  elem kulcsai mas sorrendben allhatnak, mint a frissen epitette. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function same(x: unknown, y: unknown): boolean {
  return stableJson(x) === stableJson(y)
}

function propsOf(doc: CanvasDoc): CanvasProps {
  return { width: doc.width, height: doc.height, background: doc.background }
}

/** A ket allapot kozotti folt. `null`, ha nincs kulonbseg (nincs mit naplozni). */
export function canvasDiff(before: CanvasDoc, after: CanvasDoc): CanvasPatch | null {
  const patch: CanvasPatch = { objs: {} }
  const pb = propsOf(before)
  const pa = propsOf(after)
  if (!same(pb, pa)) patch.props = { b: pb, a: pa }
  const mapB = new Map(before.objects.map((o) => [o.id, o]))
  const mapA = new Map(after.objects.map((o) => [o.id, o]))
  for (const id of new Set([...mapB.keys(), ...mapA.keys()])) {
    const b = mapB.get(id) ?? null
    const a = mapA.get(id) ?? null
    if (!same(b, a)) patch.objs[id] = { b, a }
  }
  const ob = before.objects.map((o) => o.id)
  const oa = after.objects.map((o) => o.id)
  if (!same(ob, oa)) patch.order = { b: ob, a: oa }
  if (!patch.props && !patch.order && !Object.keys(patch.objs).length) return null
  return patch
}

/** A folt lejatszasa: `undo` = vissza az ELOTTE allapotba, `redo` = elore.
 *  Eloszor ellenorzi, hogy a vaszon a vart kiindulo allapotban van-e. */
export function applyCanvasPatch(doc: CanvasDoc, patch: CanvasPatch, dir: 'undo' | 'redo'): CanvasPatchApply {
  const from = dir === 'undo' ? 'a' : 'b'
  const to = dir === 'undo' ? 'b' : 'a'
  const byId = new Map(doc.objects.map((o) => [o.id, o]))
  const conflicts: string[] = []
  if (patch.props && !same(propsOf(doc), patch.props[from])) conflicts.push('the canvas size or background')
  for (const [id, pair] of Object.entries(patch.objs)) {
    if (!same(byId.get(id) ?? null, pair[from])) conflicts.push(`"${id}"`)
  }
  if (patch.order && !same(doc.objects.map((o) => o.id), patch.order[from])) conflicts.push('the order of the elements')
  if (conflicts.length) {
    return {
      ok: false, code: 'canvas_undo_conflict',
      detail: `changed since this step: ${conflicts.join(', ')}`,
    }
  }
  for (const [id, pair] of Object.entries(patch.objs)) {
    const target = pair[to]
    if (target) byId.set(id, JSON.parse(JSON.stringify(target)) as CanvasObject)
    else byId.delete(id)
  }
  // A sorrend: ha a folt tartalmazza, AZ a mervado; kulonben a regi sorrend
  // marad (ilyenkor elem nem jott es nem ment, csak valtozott).
  const ids = patch.order ? patch.order[to] : doc.objects.map((o) => o.id)
  const objects: CanvasObject[] = []
  for (const id of ids) {
    const o = byId.get(id)
    if (o) objects.push(o)
  }
  const props = patch.props ? patch.props[to] : propsOf(doc)
  return { ok: true, doc: { ...doc, ...props, objects } }
}

/** Ennyi erintett elem alatt egy valtozas sosem "nagy". */
export const CANVAS_BIG_MIN = 3

/**
 * "Nagy" valtozas-e (v4 spec K-2.3: verzio a NAGY agent-muvelet ELOTT). Nagy,
 * ha a vaszon merete vagy hattere valtozik, ha elem tunik el, vagy ha az
 * elemek legalabb fele (de legalabb `CANVAS_BIG_MIN`) erintett. Egy cim
 * atszinezese nem nagy; az egesz plakat atrendezese az.
 */
export function canvasChangeIsBig(before: CanvasDoc, after: CanvasDoc): boolean {
  const p = canvasDiff(before, after)
  if (!p) return false
  if (p.props) return true
  const touched = Object.values(p.objs)
  if (touched.some((x) => x.b && !x.a)) return true
  return touched.length >= Math.max(CANVAS_BIG_MIN, Math.ceil(before.objects.length / 2))
}

/** Az erintett elemek szama -- a felulet "3 elem" jellegu cimkejehez. */
export function patchSize(patch: CanvasPatch): number {
  return Object.keys(patch.objs).length + (patch.props ? 1 : 0)
}
