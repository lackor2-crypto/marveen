/**
 * GRAFIKA / KEP: a STRUKTURALT rajzvaszon (kanban #336, 9. fazis, spec 9).
 *
 * A spec kikotese nem az, hogy melyik rajzolo konyvtar fusson a bongeszoben,
 * hanem hogy a kep STRUKTURALT legyen es az objektumoknak STABIL ID-juk
 * legyen -- mert csak igy tud az agent ertelmes utasitast vegrehajtani:
 *
 *     "A cimet tedd 30%-kal nagyobbra es kozepre."
 *
 * Ezert itt EGY adatmodell all (vaszon + objektumok), es ra ket dolog epul:
 *
 *   1. STRUKTURALT MUVELETEK (`applyCanvasOps`) -- ugyanazt a keszletet
 *      hasznalja a felulet gombja es az agent toolja. Nincs ket ut, ami
 *      szetcsuszhat.
 *   2. SZERVER OLDALI KEPKESZITES (`renderCanvasSvg`) -- fuggoseg nelkul.
 *      Igy az elonezet es a LETOLTES ugyanaz a kep, es egy FRISSEN TELEPITETT
 *      gepen is mukodik: nem kell hozza sem internet, sem CDN-rol toltodo
 *      rajzolo konyvtar, sem kulso program (LibreOffice/FFmpeg).
 *
 * A kivitt SVG ONALLO: a kepeket base64 adat-URI-kent viszi magaval, mert egy
 * `localhost` utakra mutato SVG a gepen kivul ures kepkockakat adna. Ami nem
 * fer bele vagy nem olvashato, az NEM tunik el csendben: a helyen egy lathato
 * tabla mondja meg, MI hianyzik (a nulla ket dolgot jelenthet).
 */

export const CANVAS_EXT = '.canvas.json'
export const CANVAS_MAX_OBJECTS = 200
export const CANVAS_TEXT_MAX = 2000
export const CANVAS_MIN_SIZE = 16
export const CANVAS_MAX_SIZE = 8000
export const CANVAS_DEFAULT_WIDTH = 1080
export const CANVAS_DEFAULT_HEIGHT = 1080
/** Ennel nagyobb kepet nem viszunk bele a kivitt SVG-be (a fajl hasznalhatatlanul
 *  nagy lenne). Ilyenkor a helyen tabla all, ami megmondja, melyik fajl az. */
export const CANVAS_EMBED_MAX_BYTES = 4 * 1024 * 1024
/** Az objektumok koordinatai kimehetnek a vaszonrol (az is ervenyes allapot),
 *  de ertelmes hataron belul -- a vegtelen szam nem rajz, hanem hiba. */
const COORD_LIMIT = 40_000

export type CanvasObjectType = 'text' | 'rect' | 'image' | 'ellipse' | 'line'
export const CANVAS_OBJECT_TYPES: readonly CanvasObjectType[] = ['text', 'rect', 'image', 'ellipse', 'line']
export type CanvasAlign = 'left' | 'center' | 'right'
export type CanvasFont = 'sans' | 'serif' | 'mono'
export type CanvasFit = 'contain' | 'cover'

export interface CanvasObjectCommon {
  id: string
  type: CanvasObjectType
  x: number
  y: number
  width: number
  height: number
  opacity: number
  /** Forgatas fokban a doboz kozeppontja korul (v4 spec K-2.5). Csak akkor
   *  all az adatban, ha nem 0 -- a regi rajzok valtozatlanok maradnak. */
  rotation?: number
  /** Csoport neve (K-2.5): az azonos nevu elemek egyutt mozognak, masolodnak,
   *  torlodnek. Csak akkor all az adatban, ha van. */
  group?: string
}

export interface CanvasText extends CanvasObjectCommon {
  type: 'text'
  text: string
  fontSize: number
  font: CanvasFont
  color: string
  align: CanvasAlign
  bold: boolean
  italic: boolean
}

export interface CanvasRect extends CanvasObjectCommon {
  type: 'rect'
  fill: string
  radius: number
}

export interface CanvasImage extends CanvasObjectCommon {
  type: 'image'
  /** A kep utja a Raktaron belul (ugyanaz a `rel`, amit az Intezo hasznal). */
  src: string
  fit: CanvasFit
  alt: string
}

/** Kor vagy ellipszis (K-2.6): a doboz kitoltott ovalisa. */
export interface CanvasEllipse extends CanvasObjectCommon {
  type: 'ellipse'
  fill: string
  stroke: string
  strokeWidth: number
}

/** Vonal (K-2.6): a doboz kozepvonala balrol jobbra, `width` hosszan. A ferde
 *  vonal a forgatassal all elo -- ugyanigy tarolja a Figma is (hossz + szog),
 *  igy a vonalra is ugyanaz a mozgatas, masolas, igazitas ervenyes. */
export interface CanvasLine extends CanvasObjectCommon {
  type: 'line'
  stroke: string
  strokeWidth: number
}

export type CanvasObject = CanvasText | CanvasRect | CanvasImage | CanvasEllipse | CanvasLine

export interface CanvasDoc {
  version: 1
  width: number
  height: number
  background: string
  objects: CanvasObject[]
}

export type CanvasParse =
  | { ok: true; doc: CanvasDoc }
  | { ok: false; code: string; detail: string }

const FONT_STACK: Record<CanvasFont, string> = {
  sans: 'DejaVu Sans, Arial, Helvetica, sans-serif',
  serif: 'DejaVu Serif, Georgia, Times New Roman, serif',
  mono: 'DejaVu Sans Mono, Consolas, Courier New, monospace',
}

/** Ures vaszon. FRISS TELEPITESEN ez a kiindulas -- nem hiba, hanem kezdoallapot. */
export function emptyCanvas(width = CANVAS_DEFAULT_WIDTH, height = CANVAS_DEFAULT_HEIGHT): CanvasDoc {
  return {
    version: 1,
    width: clampSize(width, CANVAS_DEFAULT_WIDTH),
    height: clampSize(height, CANVAS_DEFAULT_HEIGHT),
    background: '#ffffff',
    objects: [],
  }
}

function clampSize(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(CANVAS_MAX_SIZE, Math.max(CANVAS_MIN_SIZE, Math.round(n)))
}

function num(v: unknown, fallback: number, min = -COORD_LIMIT, max = COORD_LIMIT): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100))
}

/** Szin: csak `#rgb`/`#rrggbb` vagy nev-nelkuli atlatszo. Barmi mas -- pl. egy
 *  `url(...)` vagy egy sajat CSS-darab -- SOSE kerul a kimenetbe. */
export function safeColor(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s)) return s
  if (s === 'none' || s === 'transparent') return 'none'
  return fallback
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v ?? '').trim().toLowerCase()
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

/** Ekezet nelkuli, rovid azonosito a szovegbol -- hogy az agent (es az ember)
 *  BESZELNI tudjon rola: `headline`, nem `obj-7`. */
export function slugCanvasId(seed: string, type: CanvasObjectType, taken: Set<string>): string {
  let base = String(seed || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  if (!base) base = type
  let id = base
  let n = 2
  while (taken.has(id)) { id = `${base}-${n}`; n += 1 }
  taken.add(id)
  return id
}

/** Szog -180 .. 180 kozott, ket tizedesre. Ertelmetlen ertek = 0 (nincs forgatas). */
function normAngle(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  let a = n % 360
  if (a > 180) a -= 360
  if (a <= -180) a += 360
  return Math.round(a * 100) / 100 || 0
}

/** Csoportnev: rovid, olvashato szo. Ures vagy ertelmetlen = nincs csoport. */
function groupName(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().replace(/\s+/g, ' ').slice(0, 40)
}

function parseObject(raw: unknown, index: number, taken: Set<string>): { ok: true; obj: CanvasObject } | { ok: false; code: string; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'canvas_bad_object', detail: `objects[${index}] is not an object` }
  }
  const o = raw as Record<string, unknown>
  const type = String(o['type'] ?? '').trim().toLowerCase()
  if (!(CANVAS_OBJECT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: 'canvas_bad_object', detail: `objects[${index}]: unknown type "${type || '(missing)'}" (allowed: ${CANVAS_OBJECT_TYPES.join(', ')})` }
  }
  const rawId = String(o['id'] ?? '').trim()
  // A MEGLEVO id-t megtartjuk (ez a "stabil ID" lenyege). Csak akkor adunk
  // ujat, ha nincs, vagy ha ugyanaz ketszer szerepel.
  const id = rawId && !taken.has(rawId)
    ? (taken.add(rawId), rawId)
    : slugCanvasId(rawId || (type === 'text' ? String(o['text'] ?? '') : ''), type as CanvasObjectType, taken)

  const common: CanvasObjectCommon = {
    id, type: type as CanvasObjectType,
    x: num(o['x'], 0), y: num(o['y'], 0),
    width: num(o['width'], type === 'text' ? 600 : 300, 1, CANVAS_MAX_SIZE),
    height: num(o['height'], type === 'text' ? 120 : type === 'line' ? 20 : 300, 1, CANVAS_MAX_SIZE),
    opacity: Math.min(1, Math.max(0, Number.isFinite(Number(o['opacity'])) ? Number(o['opacity']) : 1)),
  }
  const rotation = normAngle(o['rotation'])
  if (rotation) common.rotation = rotation
  const group = groupName(o['group'])
  if (group) common.group = group

  if (type === 'ellipse') {
    return {
      ok: true,
      obj: {
        ...common, type: 'ellipse', fill: safeColor(o['fill'], '#dddddd'),
        stroke: safeColor(o['stroke'], 'none'), strokeWidth: num(o['strokeWidth'], 0, 0, 400),
      },
    }
  }
  if (type === 'line') {
    return {
      ok: true,
      obj: { ...common, type: 'line', stroke: safeColor(o['stroke'], '#111111'), strokeWidth: num(o['strokeWidth'], 4, 1, 400) },
    }
  }

  if (type === 'text') {
    const text = String(o['text'] ?? '')
    if (text.length > CANVAS_TEXT_MAX) {
      return { ok: false, code: 'canvas_text_too_long', detail: `objects[${index}] (${id}): the text is ${text.length} characters, the limit is ${CANVAS_TEXT_MAX}` }
    }
    return {
      ok: true,
      obj: {
        ...common, type: 'text', text,
        fontSize: num(o['fontSize'], 48, 4, 1200),
        font: pickEnum(o['font'], ['sans', 'serif', 'mono'] as const, 'sans'),
        color: safeColor(o['color'], '#111111'),
        align: pickEnum(o['align'], ['left', 'center', 'right'] as const, 'left'),
        bold: o['bold'] === true, italic: o['italic'] === true,
      },
    }
  }
  if (type === 'rect') {
    return {
      ok: true,
      obj: { ...common, type: 'rect', fill: safeColor(o['fill'], '#dddddd'), radius: num(o['radius'], 0, 0, CANVAS_MAX_SIZE) },
    }
  }
  const src = String(o['src'] ?? '').trim()
  if (!src) return { ok: false, code: 'canvas_bad_object', detail: `objects[${index}] (${id}): an image object needs a src (the file path inside the Depot)` }
  return {
    ok: true,
    obj: { ...common, type: 'image', src, fit: pickEnum(o['fit'], ['contain', 'cover'] as const, 'contain'), alt: String(o['alt'] ?? '').slice(0, 300) },
  }
}

/**
 * Nyers adatbol ERVENYES vaszon.
 *
 * Hianyzo mezot kiegeszitunk (ertelmes alapertekkel), ertelmetlen erteket
 * hatarok koze vagunk -- de amit NEM lehet ertelmezni (ismeretlen objektum-
 * fajta, tul hosszu szoveg, romlott JSON), arra HIBA jar, es a hibauzenet
 * MEGNEVEZI, melyik objektum melyik mezoje. Nem talalgatunk helyette.
 */
export function parseCanvas(raw: unknown): CanvasParse {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { ok: true, doc: emptyCanvas() }
    try { value = JSON.parse(trimmed) } catch (e) {
      return { ok: false, code: 'canvas_bad_json', detail: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'canvas_bad_shape', detail: 'the canvas must be an object with width, height and objects' }
  }
  const v = value as Record<string, unknown>
  const rawObjects = v['objects']
  if (rawObjects !== undefined && !Array.isArray(rawObjects)) {
    return { ok: false, code: 'canvas_bad_shape', detail: 'objects must be a list' }
  }
  const list = Array.isArray(rawObjects) ? rawObjects : []
  if (list.length > CANVAS_MAX_OBJECTS) {
    return { ok: false, code: 'canvas_too_many', detail: `the canvas holds ${list.length} objects, the limit is ${CANVAS_MAX_OBJECTS}` }
  }
  const taken = new Set<string>()
  const objects: CanvasObject[] = []
  for (let i = 0; i < list.length; i += 1) {
    const r = parseObject(list[i], i, taken)
    if (!r.ok) return r
    objects.push(r.obj)
  }
  return {
    ok: true,
    doc: {
      version: 1,
      width: clampSize(v['width'], CANVAS_DEFAULT_WIDTH),
      height: clampSize(v['height'], CANVAS_DEFAULT_HEIGHT),
      background: safeColor(v['background'], '#ffffff'),
      objects,
    },
  }
}

export interface CanvasOpNote { op: string; id: string | null; note: string }
export type CanvasOpsResult =
  | { ok: true; doc: CanvasDoc; applied: CanvasOpNote[] }
  | { ok: false; code: string; detail: string }

/** Azok a muveletek, amik EGY MEGLEVO elemre hatnak (tehat `id` kell hozzajuk). */
const OBJECT_OPS = ['remove', 'update', 'move', 'center', 'scale', 'order', 'rotate', 'duplicate']

/** Azok a muveletek, amik TOBB elemre hatnak (`ids` lista, v4 spec K-2.5). */
const MULTI_OPS = ['align', 'distribute', 'group', 'ungroup']

/** A vaszon atmeretezese az elemek atrendezesevel (v4 spec K-2.9). */
export interface SafeArea { top: number; bottom: number; left: number; right: number }
export interface CanvasOpsContext {
  /** Platform-azonositobol meret + biztonsagi zona (a `resize` muveletnek). */
  platform?: (id: string) => { width: number; height: number; safe: SafeArea | null } | null
}

/** Minden ismert muvelet -- a hibauzenet ezt sorolja fel. */
const ALL_OPS = ['add', 'update', 'remove', 'move', 'center', 'scale', 'order', 'rotate', 'duplicate', 'align', 'distribute', 'group', 'ungroup', 'canvas', 'resize']

function findIndex(doc: CanvasDoc, id: unknown): number {
  const want = String(id ?? '').trim()
  return doc.objects.findIndex((o) => o.id === want)
}

function centerOf(o: CanvasObject): { cx: number; cy: number } {
  return { cx: o.x + o.width / 2, cy: o.y + o.height / 2 }
}

interface Box { x: number; y: number; width: number; height: number }

/** Az elem LATHATO befoglalo doboza: forgatott elemnel a forgatott sarkok
 *  kore rajzolt teglalap. Igy az igazitas azt igazitja, amit a szem lat (a
 *  Figma es a Canva is igy csinalja). */
export function visualBox(o: CanvasObject): Box {
  const a = ((o.rotation || 0) * Math.PI) / 180
  if (!a) return { x: o.x, y: o.y, width: o.width, height: o.height }
  const { cx, cy } = centerOf(o)
  const w = Math.abs(o.width * Math.cos(a)) + Math.abs(o.height * Math.sin(a))
  const h = Math.abs(o.width * Math.sin(a)) + Math.abs(o.height * Math.cos(a))
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
}

function unionBox(list: CanvasObject[]): Box {
  const boxes = list.map(visualBox)
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.width))
  const btm = Math.max(...boxes.map((b) => b.y + b.height))
  return { x, y, width: r - x, height: btm - y }
}

/** Egy muvelet celpontjai: az `id` lehet egy elem, VAGY egy csoport neve --
 *  ilyenkor a csoport minden eleme (a vaszon sorrendjeben). */
function targetsOf(doc: CanvasDoc, id: unknown): CanvasObject[] {
  const want = String(id ?? '').trim()
  if (!want) return []
  const one = doc.objects.find((o) => o.id === want)
  if (one) return [one]
  return doc.objects.filter((o) => o.group === want)
}

function shiftBy(o: CanvasObject, dx: number, dy: number): void {
  o.x = num(o.x + dx, o.x)
  o.y = num(o.y + dy, o.y)
}

function notFound(doc: CanvasDoc, id: unknown): { ok: false; code: string; detail: string } {
  const have = doc.objects.map((o) => o.id).join(', ') || '(the canvas is empty)'
  const groups = [...new Set(doc.objects.map((o) => o.group).filter(Boolean))]
  return {
    ok: false, code: 'canvas_object_not_found',
    detail: `there is no object or group called "${String(id ?? '')}" on the canvas. Objects: ${have}`
      + (groups.length ? `. Groups: ${groups.join(', ')}` : ''),
  }
}

/**
 * STRUKTURALT MODOSITASOK -- ugyanaz a keszlet a feluletnek es az agentnek.
 *
 * Mindent MASOLATON vegzunk, es ha barmelyik lepes elbukik, az EGESZ koteg
 * elbukik: felig vegrehajtott utasitastol a felhasznalo nem tudna, mi allt be.
 */
/**
 * Az `add`/`update` adatai KET alakban jonnek, es mindketto ervenyes:
 *   {op:'add', object:{type:'text', text:'...'}}   -- a dokumentalt alak
 *   {op:'add', type:'text', text:'...'}            -- lapitva
 * A modell (es a kezzel irt hivas) hol igy, hol ugy kuldi; egy elutasitott
 * koteg itt tiszta veszteseg lenne, hiszen a szandek egyertelmu. A kulcs
 * (`object` / `patch`) ha ott van, AZ nyer -- talalgatas nelkul.
 */
function opPayload(r: Record<string, unknown>, key: 'object' | 'patch'): Record<string, unknown> | null {
  const nested = r[key]
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>
  if (nested !== undefined) return null
  const flat: Record<string, unknown> = {}
  for (const k of Object.keys(r)) {
    if (k === 'op' || k === 'object' || k === 'patch') continue
    flat[k] = r[k]
  }
  return flat
}

export function applyCanvasOps(doc: CanvasDoc, rawOps: unknown, ctx: CanvasOpsContext = {}): CanvasOpsResult {
  if (!Array.isArray(rawOps)) return { ok: false, code: 'canvas_bad_ops', detail: 'ops must be a list' }
  if (!rawOps.length) return { ok: false, code: 'canvas_bad_ops', detail: 'ops is empty: there is nothing to do' }
  if (rawOps.length > CANVAS_MAX_OBJECTS) {
    return { ok: false, code: 'canvas_bad_ops', detail: `too many operations at once (${rawOps.length}, the limit is ${CANVAS_MAX_OBJECTS})` }
  }
  const next: CanvasDoc = JSON.parse(JSON.stringify(doc))
  const applied: CanvasOpNote[] = []

  for (let i = 0; i < rawOps.length; i += 1) {
    const raw = rawOps[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] is not an object` }
    }
    const op = String((raw as Record<string, unknown>)['op'] ?? '').trim().toLowerCase()
    const r = raw as Record<string, unknown>

    if (op === 'canvas') {
      if (r['width'] !== undefined) next.width = clampSize(r['width'], next.width)
      if (r['height'] !== undefined) next.height = clampSize(r['height'], next.height)
      if (r['background'] !== undefined) next.background = safeColor(r['background'], next.background)
      applied.push({ op, id: null, note: `canvas is now ${next.width}x${next.height}` })
      continue
    }

    if (op === 'resize') {
      let width = Number(r['width'])
      let height = Number(r['height'])
      let safe: SafeArea | null = null
      if (r['platform'] !== undefined) {
        const pf = ctx.platform ? ctx.platform(String(r['platform'])) : null
        if (!pf) return { ok: false, code: 'canvas_unknown_platform', detail: `ops[${i}] (resize): there is no platform called "${String(r['platform'])}"` }
        width = pf.width
        height = pf.height
        safe = pf.safe
      }
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (resize): give "platform", or "width" and "height"` }
      }
      const from = `${next.width}x${next.height}`
      relayoutCanvas(next, clampSize(width, next.width), clampSize(height, next.height), safe)
      applied.push({ op, id: null, note: `canvas resized from ${from} to ${next.width}x${next.height}, the elements rearranged${safe ? ' inside the safe zone' : ''}` })
      continue
    }

    if (op === 'add') {
      if (next.objects.length >= CANVAS_MAX_OBJECTS) {
        return { ok: false, code: 'canvas_too_many', detail: `the canvas already holds ${next.objects.length} objects, the limit is ${CANVAS_MAX_OBJECTS}` }
      }
      const taken = new Set(next.objects.map((o) => o.id))
      const payload = opPayload(r, 'object')
      if (!payload) {
        return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (add): "object" must be an object -- or give the fields directly on the operation` }
      }
      const p = parseObject(payload, next.objects.length, taken)
      if (!p.ok) return { ok: false, code: p.code, detail: p.detail }
      next.objects.push(p.obj)
      applied.push({ op, id: p.obj.id, note: `${p.obj.type} added as "${p.obj.id}"` })
      continue
    }

    // AZ ISMERETLEN MUVELET ITT bukik meg, MIELOTT az azonositot keresnenk:
    // kulonben egy elgepelt muveletnev "nincs ilyen elem" hibat adna, ami mas
    // iranyba kuldene a hivot (ember es agent egyarant).
    if (!OBJECT_OPS.includes(op) && !MULTI_OPS.includes(op)) {
      return {
        ok: false,
        code: 'canvas_bad_ops',
        detail: `ops[${i}]: unknown operation "${op || '(missing)'}" (allowed: ${ALL_OPS.join(', ')})`,
      }
    }

    if (MULTI_OPS.includes(op)) {
      const m = multiOp(next, op, r, i)
      if (!m.ok) return m
      applied.push(m.note)
      continue
    }

    // CSOPORTRA is hathat (az `id` a csoport neve): mozgatas, kozepre, masolas,
    // torles, sorrend -- ugyanaz, amit a csoport egy elemenel a szem var.
    const group = findIndex(next, r['id']) < 0 ? targetsOf(next, r['id']) : []
    if (group.length) {
      const g = groupOp(next, op, r, i, group)
      if (!g.ok) return g
      applied.push(g.note)
      continue
    }

    const idx = findIndex(next, r['id'])
    if (idx < 0) {
      // A "nincs ilyen" SOSE csendes: megmondjuk, mi VAN a vaszonon, hogy a
      // hivo (ember vagy agent) ne talalgasson tovabb.
      return notFound(next, r['id'])
    }
    const target = next.objects[idx] as CanvasObject

    if (op === 'rotate') {
      const hasAngle = r['angle'] !== undefined
      const by = Number(hasAngle ? r['angle'] : r['by'])
      if (!Number.isFinite(by)) {
        return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (rotate): give "angle" (the new angle in degrees) or "by" (degrees to turn, + = clockwise)` }
      }
      const a = normAngle(hasAngle ? by : (target.rotation || 0) + by)
      if (a) target.rotation = a
      else delete target.rotation
      applied.push({ op, id: target.id, note: `"${target.id}" is now turned ${a} degrees` })
      continue
    }

    if (op === 'duplicate') {
      const d = duplicateObjects(next, [target], r, i)
      if (!d.ok) return d
      applied.push({ op, id: d.ids[0] ?? null, note: `"${target.id}" copied as "${d.ids[0]}"` })
      continue
    }

    if (op === 'remove') {
      next.objects.splice(idx, 1)
      applied.push({ op, id: target.id, note: `"${target.id}" removed` })
      continue
    }

    if (op === 'update') {
      const patch = opPayload(r, 'patch')
      if (!patch || !Object.keys(patch).filter((k) => k !== 'id').length) {
        return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (update): give the fields to change in "patch", or directly on the operation` }
      }
      // A fajta es az ID NEM irhato at egy javitassal: az elobbi mas objektum
      // lenne, az utobbi pont a stabil hivatkozast tenne tonkre.
      const merged = { ...(target as unknown as Record<string, unknown>), ...(patch as Record<string, unknown>), id: target.id, type: target.type }
      const taken = new Set(next.objects.filter((_, n) => n !== idx).map((o) => o.id))
      const p = parseObject(merged, idx, taken)
      if (!p.ok) return { ok: false, code: p.code, detail: p.detail }
      next.objects[idx] = p.obj
      applied.push({ op, id: p.obj.id, note: `"${p.obj.id}" changed` })
      continue
    }

    if (op === 'move') {
      target.x = num(target.x + num(r['dx'], 0), target.x)
      target.y = num(target.y + num(r['dy'], 0), target.y)
      applied.push({ op, id: target.id, note: `"${target.id}" moved to ${target.x},${target.y}` })
      continue
    }

    if (op === 'center') {
      const axis = pickEnum(r['axis'], ['x', 'y', 'both'] as const, 'both')
      if (axis === 'x' || axis === 'both') target.x = Math.round((next.width - target.width) / 2)
      if (axis === 'y' || axis === 'both') target.y = Math.round((next.height - target.height) / 2)
      applied.push({ op, id: target.id, note: `"${target.id}" centered (${axis})` })
      continue
    }

    if (op === 'scale') {
      const factor = Number(r['factor'])
      if (!Number.isFinite(factor) || factor <= 0) {
        return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (scale): factor must be a positive number (1.3 = 30% bigger)` }
      }
      const { cx, cy } = centerOf(target)
      if (target.type === 'text') target.fontSize = num(target.fontSize * factor, target.fontSize, 4, 1200)
      target.width = num(target.width * factor, target.width, 1, CANVAS_MAX_SIZE)
      target.height = num(target.height * factor, target.height, 1, CANVAS_MAX_SIZE)
      // A meretezes a KOZEPPONT korul tortenik: kulonben a "nagyobbra" egyben
      // el is csusztatna az objektumot, amit senki nem kert.
      target.x = num(cx - target.width / 2, target.x)
      target.y = num(cy - target.height / 2, target.y)
      applied.push({ op, id: target.id, note: `"${target.id}" scaled by ${factor}` })
      continue
    }

    if (op === 'order') {
      const to = pickEnum(r['to'], ['front', 'back', 'up', 'down'] as const, 'front')
      next.objects.splice(idx, 1)
      const at = to === 'front' ? next.objects.length
        : to === 'back' ? 0
          : to === 'up' ? Math.min(next.objects.length, idx + 1)
            : Math.max(0, idx - 1)
      next.objects.splice(at, 0, target)
      applied.push({ op, id: target.id, note: `"${target.id}" moved ${to}` })
      continue
    }

    // Ide nem lehet eljutni: a fenti ellenorzes minden ismeretlen muveletet
    // kiszurt, es minden ismertnek van aga. A sor csak azert all itt, hogy a
    // ciklus minden utja lezart legyen.
    return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}]: "${op}" was not carried out` }
  }
  return { ok: true, doc: next, applied }
}

type OpOk = { ok: true; note: CanvasOpNote }
type OpFail = { ok: false; code: string; detail: string }

/** A masolatok (K-2.5 "duplikalas"): uj azonositoval, kicsit eltolva, KOZVETLENUL
 *  az eredeti(ek) fole. Csoport masolasa uj csoportot ad. */
function duplicateObjects(doc: CanvasDoc, list: CanvasObject[], r: Record<string, unknown>, i: number): { ok: true; ids: string[] } | OpFail {
  if (doc.objects.length + list.length > CANVAS_MAX_OBJECTS) {
    return { ok: false, code: 'canvas_too_many', detail: `ops[${i}] (duplicate): the canvas would hold more than ${CANVAS_MAX_OBJECTS} objects` }
  }
  const dx = num(r['dx'], 20)
  const dy = num(r['dy'], 20)
  const taken = new Set(doc.objects.map((o) => o.id))
  const oldGroup = list[0]?.group
  const newGroup = oldGroup && list.every((o) => o.group === oldGroup)
    ? freeGroupName(doc, oldGroup)
    : ''
  const ids: string[] = []
  let at = Math.max(...list.map((o) => doc.objects.indexOf(o))) + 1
  for (const o of list) {
    const copy = JSON.parse(JSON.stringify(o)) as CanvasObject
    copy.id = slugCanvasId(o.id.replace(/-\d+$/, ''), o.type, taken)
    shiftBy(copy, dx, dy)
    if (newGroup) copy.group = newGroup
    else delete copy.group
    doc.objects.splice(at, 0, copy)
    at += 1
    ids.push(copy.id)
  }
  return { ok: true, ids }
}

function freeGroupName(doc: CanvasDoc, base: string): string {
  const have = new Set(doc.objects.map((o) => o.group).filter(Boolean))
  const root = base.replace(/ \d+$/, '') || 'group'
  let n = 2
  let name = `${root} ${n}`
  while (have.has(name)) { n += 1; name = `${root} ${n}` }
  return name
}

/** Muvelet egy egesz csoporton (az `id` a csoport neve). */
function groupOp(doc: CanvasDoc, op: string, r: Record<string, unknown>, i: number, list: CanvasObject[]): OpOk | OpFail {
  const name = String(r['id'])
  if (op === 'move') {
    const dx = num(r['dx'], 0)
    const dy = num(r['dy'], 0)
    for (const o of list) shiftBy(o, dx, dy)
    return { ok: true, note: { op, id: name, note: `group "${name}" moved` } }
  }
  if (op === 'center') {
    const axis = pickEnum(r['axis'], ['x', 'y', 'both'] as const, 'both')
    const b = unionBox(list)
    const dx = axis === 'y' ? 0 : Math.round((doc.width - b.width) / 2 - b.x)
    const dy = axis === 'x' ? 0 : Math.round((doc.height - b.height) / 2 - b.y)
    for (const o of list) shiftBy(o, dx, dy)
    return { ok: true, note: { op, id: name, note: `group "${name}" centered (${axis})` } }
  }
  if (op === 'remove') {
    doc.objects = doc.objects.filter((o) => !list.includes(o))
    return { ok: true, note: { op, id: name, note: `group "${name}" removed (${list.length} objects)` } }
  }
  if (op === 'duplicate') {
    const d = duplicateObjects(doc, list, r, i)
    if (!d.ok) return d
    const g = doc.objects.find((o) => o.id === d.ids[0])?.group ?? null
    return { ok: true, note: { op, id: g, note: `group "${name}" copied as "${g}"` } }
  }
  if (op === 'order') {
    const to = pickEnum(r['to'], ['front', 'back'] as const, 'front')
    const rest = doc.objects.filter((o) => !list.includes(o))
    doc.objects = to === 'front' ? [...rest, ...list] : [...list, ...rest]
    return { ok: true, note: { op, id: name, note: `group "${name}" moved ${to}` } }
  }
  return {
    ok: false, code: 'canvas_bad_ops',
    detail: `ops[${i}] (${op}): "${name}" is a group; ${op} works on one object at a time. A group can be moved, centered, copied (duplicate), removed or brought to front/back; or give the id of one of its objects: ${list.map((o) => o.id).join(', ')}`,
  }
}

/** Az `ids` lista feloldasa: elem-azonositok ES csoportnevek, ismetles nelkul,
 *  a vaszon sorrendjeben. */
function resolveIds(doc: CanvasDoc, raw: unknown, op: string, i: number): { ok: true; list: CanvasObject[] } | OpFail {
  if (!Array.isArray(raw) || !raw.length) {
    return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (${op}): "ids" must be a list of object ids (or group names)` }
  }
  const set = new Set<CanvasObject>()
  for (const id of raw) {
    const t = targetsOf(doc, id)
    if (!t.length) return notFound(doc, id)
    for (const o of t) set.add(o)
  }
  return { ok: true, list: doc.objects.filter((o) => set.has(o)) }
}

/**
 * Tobb elemre hato muveletek (v4 spec K-2.5):
 *   align      -- igazitas egymashoz (bal, kozep, jobb, fent, kozep, lent); EGY
 *                 elemnel a vaszonhoz (ahogy a Figma a keretehez igazit)
 *   distribute -- egyenletes elosztas (legalabb harom elem): a ket szelso
 *                 marad, a koztes hezagok egyformak lesznek
 *   group / ungroup -- csoportositas nevvel, es a csoport bontasa
 */
function multiOp(doc: CanvasDoc, op: string, r: Record<string, unknown>, i: number): OpOk | OpFail {
  if (op === 'ungroup') {
    const names = new Set<string>()
    if (r['group'] !== undefined) names.add(groupName(r['group']))
    if (Array.isArray(r['ids'])) {
      const res = resolveIds(doc, r['ids'], op, i)
      if (!res.ok) return res
      for (const o of res.list) if (o.group) names.add(o.group)
    }
    names.delete('')
    const hit = doc.objects.filter((o) => o.group && names.has(o.group))
    if (!hit.length) {
      const groups = [...new Set(doc.objects.map((o) => o.group).filter(Boolean))]
      return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (ungroup): there is no such group. Groups: ${groups.join(', ') || '(none)'}` }
    }
    for (const o of hit) delete o.group
    return { ok: true, note: { op, id: null, note: `group ${[...names].map((n) => `"${n}"`).join(', ')} split into ${hit.length} objects` } }
  }
  const res = resolveIds(doc, r['ids'], op, i)
  if (!res.ok) return res
  const list = res.list
  if (op === 'group') {
    if (list.length < 2) return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (group): a group needs at least two objects` }
    const wanted = groupName(r['name'])
    if (wanted && doc.objects.some((o) => o.id === wanted)) {
      return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (group): "${wanted}" is already the id of an object; pick another group name` }
    }
    const name = wanted || freeGroupName(doc, 'group')
    for (const o of list) o.group = name
    // A csoport elemei egymas mellett allnak a sorrendben (a legfelso helyen),
    // kulonben egy kozbeeso idegen elem "atlatszana" a csoporton.
    const top = Math.max(...list.map((o) => doc.objects.indexOf(o)))
    const before = doc.objects.slice(0, top + 1).filter((o) => !list.includes(o))
    const after = doc.objects.slice(top + 1)
    doc.objects = [...before, ...list, ...after]
    return { ok: true, note: { op, id: name, note: `${list.length} objects grouped as "${name}"` } }
  }
  if (op === 'align') {
    const to = pickEnum(r['to'], ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const, 'left')
    // Egy elem (vagy egy csoport) a vaszonhoz igazodik, tobb elem egymashoz.
    const single = new Set(list.map((o) => o.group || `#${o.id}`)).size === 1
    const frame: Box = single ? { x: 0, y: 0, width: doc.width, height: doc.height } : unionBox(list)
    // Csoportot egyben igazitunk: a belso elrendezese nem esik szet.
    const units = new Map<string, CanvasObject[]>()
    for (const o of list) {
      const k = o.group || `#${o.id}`
      units.set(k, [...(units.get(k) || []), o])
    }
    for (const members of units.values()) {
      const b = unionBox(members)
      let dx = 0
      let dy = 0
      if (to === 'left') dx = frame.x - b.x
      else if (to === 'right') dx = frame.x + frame.width - (b.x + b.width)
      else if (to === 'center') dx = frame.x + frame.width / 2 - (b.x + b.width / 2)
      else if (to === 'top') dy = frame.y - b.y
      else if (to === 'bottom') dy = frame.y + frame.height - (b.y + b.height)
      else dy = frame.y + frame.height / 2 - (b.y + b.height / 2)
      for (const o of members) shiftBy(o, Math.round(dx), Math.round(dy))
    }
    return { ok: true, note: { op, id: null, note: `${list.length} objects aligned ${to}${single ? ' to the canvas' : ''}` } }
  }
  // distribute
  const axis = pickEnum(r['axis'], ['x', 'y'] as const, 'x')
  const units = new Map<string, CanvasObject[]>()
  for (const o of list) {
    const k = o.group || `#${o.id}`
    units.set(k, [...(units.get(k) || []), o])
  }
  if (units.size < 3) {
    return { ok: false, code: 'canvas_bad_ops', detail: `ops[${i}] (distribute): even spacing needs at least three objects (or groups); got ${units.size}` }
  }
  const rows = [...units.values()].map((m) => ({ m, b: unionBox(m) }))
  rows.sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y))
  const first = rows[0]!.b
  const last = rows[rows.length - 1]!.b
  const span = axis === 'x' ? last.x + last.width - first.x : last.y + last.height - first.y
  const sizes = rows.reduce((acc, row) => acc + (axis === 'x' ? row.b.width : row.b.height), 0)
  const gap = (span - sizes) / (rows.length - 1)
  let pos = axis === 'x' ? first.x : first.y
  for (const row of rows) {
    const d = Math.round(pos - (axis === 'x' ? row.b.x : row.b.y))
    for (const o of row.m) shiftBy(o, axis === 'x' ? d : 0, axis === 'y' ? d : 0)
    pos += (axis === 'x' ? row.b.width : row.b.height) + gap
  }
  return { ok: true, note: { op, id: null, note: `${rows.length} objects spaced evenly (${axis === 'x' ? 'across' : 'down'})` } }
}

/**
 * Atrendezes uj meretre (K-2.9) -- ahogy a Canva "Magic Resize"-a: a hatter
 * (ami a vaszon legalabb 90%-at fedi) kitolti az uj vasznat; minden mas elem
 * (a csoport egyben) a helyet ARANYOSAN tartja, a meretet torzitas nelkul, a
 * rovidebb ol aranyaban kapja; betumeret, vonalvastagsag, lekerekites vele
 * nonek. Ha van biztonsagi zona, es az elem befer, oda kerul; kulonben a
 * vaszonra (ha befer). Az Agent utana finomithat rajta.
 */
export function relayoutCanvas(doc: CanvasDoc, width: number, height: number, safe: SafeArea | null): void {
  const sx = width / doc.width
  const sy = height / doc.height
  const s = Math.min(sx, sy)
  const units = new Map<string, CanvasObject[]>()
  for (const o of doc.objects) {
    const k = o.group ? `g:${o.group}` : `#${o.id}`
    units.set(k, [...(units.get(k) || []), o])
  }
  const grow = (o: CanvasObject, f: number): void => {
    if (o.type === 'text') o.fontSize = num(o.fontSize * f, o.fontSize, 4, 1200)
    if (o.type === 'rect') o.radius = num(o.radius * f, o.radius, 0, CANVAS_MAX_SIZE)
    if (o.type === 'ellipse' || o.type === 'line') o.strokeWidth = num(o.strokeWidth * f, o.strokeWidth, o.type === 'line' ? 1 : 0, 400)
  }
  const area: Box = safe
    ? { x: width * safe.left, y: height * safe.top, width: width * (1 - safe.left - safe.right), height: height * (1 - safe.top - safe.bottom) }
    : { x: 0, y: 0, width, height }
  for (const members of units.values()) {
    const b = unionBox(members)
    const background = b.width >= doc.width * 0.9 && b.height >= doc.height * 0.9
    if (background) {
      for (const o of members) {
        o.x = num(o.x * sx, 0)
        o.y = num(o.y * sy, 0)
        o.width = num(o.width * sx, o.width, 1, CANVAS_MAX_SIZE)
        o.height = num(o.height * sy, o.height, 1, CANVAS_MAX_SIZE)
        grow(o, s)
      }
      continue
    }
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const ncx = cx * sx
    const ncy = cy * sy
    for (const o of members) {
      const c = centerOf(o)
      const w = num(o.width * s, o.width, 1, CANVAS_MAX_SIZE)
      const h = num(o.height * s, o.height, 1, CANVAS_MAX_SIZE)
      o.x = num(ncx + (c.cx - cx) * s - w / 2, 0)
      o.y = num(ncy + (c.cy - cy) * s - h / 2, 0)
      o.width = w
      o.height = h
      grow(o, s)
    }
    // Beljebb tolas: elobb a biztonsagi zonaba, ha oda nem fer, a vaszonra.
    const nb = unionBox(members)
    for (const frame of [area, { x: 0, y: 0, width, height }]) {
      if (nb.width > frame.width || nb.height > frame.height) continue
      const dx = Math.max(frame.x - nb.x, Math.min(0, frame.x + frame.width - (nb.x + nb.width)))
      const dy = Math.max(frame.y - nb.y, Math.min(0, frame.y + frame.height - (nb.y + nb.height)))
      for (const o of members) shiftBy(o, Math.round(dx), Math.round(dy))
      break
    }
  }
  doc.width = width
  doc.height = height
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Sortores becslessel.
 *
 * Az SVG magatol NEM tordel. A pontos szelesseg csak a betukeszlet ismereteben
 * szamolhato; szerver oldalon nincs betukeszlet-meresunk, ezert egy ATLAGOS
 * karakterszelesseggel becsulunk. Ez kozelites, nem tipografia -- de lathatoan
 * jobb, mint a vaszonrol kilogo egysoros szoveg.
 */
function wrapText(text: string, width: number, fontSize: number, font: CanvasFont): string[] {
  const perChar = fontSize * (font === 'mono' ? 0.6 : 0.52)
  const maxChars = Math.max(1, Math.floor(width / perChar))
  const out: string[] = []
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.length) { out.push(''); continue }
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue
      const candidate = line ? `${line} ${word}` : word
      if (candidate.length <= maxChars) { line = candidate; continue }
      if (line) out.push(line)
      // A tul hosszu SZO magaban sem fer ki: darabokra vagjuk, hogy ne logjon ki.
      let rest = word
      while (rest.length > maxChars) { out.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars) }
      line = rest
    }
    out.push(line)
  }
  return out
}

export type ImageResolve =
  | { ok: true; dataUri: string }
  | { ok: false; note: string }

export interface RenderOptions {
  /** A kep utjat ADAT-URI-ra valto fuggveny. Ha nincs megadva, a kepek helyen
   *  tabla all -- igy a modul fajlrendszer NELKUL is tesztelheto. */
  resolveImage?: (src: string) => ImageResolve
}

/**
 * A vaszon KEPE -- fuggoseg nelkuli SVG, amit a bongeszo es minden kepnezo ert.
 * Ugyanez a kep megy az elonezetbe es a letoltesbe: nincs ket kulonbozo kimenet.
 */
export function renderCanvasSvg(doc: CanvasDoc, opts: RenderOptions = {}): string {
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`)
  if (doc.background !== 'none') {
    parts.push(`<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${esc(doc.background)}"/>`)
  }
  for (const o of doc.objects) {
    // A forgatott elem egy `<g transform>`-ba kerul, a doboz kozeppontja korul
    // -- ugyanugy, ahogy a felulet a dobozt forgatja.
    const rot = o.rotation ? `rotate(${o.rotation} ${o.x + o.width / 2} ${o.y + o.height / 2})` : ''
    if (rot) parts.push(`<g transform="${rot}">`)
    renderObject(parts, o, opts)
    if (rot) parts.push('</g>')
  }
  parts.push('</svg>')
  return parts.join('\n')
}

function renderObject(parts: string[], o: CanvasObject, opts: RenderOptions): void {
  const opacity = o.opacity >= 1 ? '' : ` opacity="${o.opacity}"`
  if (o.type === 'ellipse') {
    const stroke = o.stroke !== 'none' && o.strokeWidth > 0 ? ` stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}"` : ''
    parts.push(`<ellipse cx="${o.x + o.width / 2}" cy="${o.y + o.height / 2}" rx="${o.width / 2}" ry="${o.height / 2}" fill="${esc(o.fill)}"${stroke}${opacity}/>`)
    return
  }
  if (o.type === 'line') {
    const y = o.y + o.height / 2
    parts.push(`<line x1="${o.x}" y1="${y}" x2="${o.x + o.width}" y2="${y}" stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}" stroke-linecap="round"${opacity}/>`)
    return
  }
  if (o.type === 'rect') {
    const r = o.radius > 0 ? ` rx="${o.radius}" ry="${o.radius}"` : ''
    parts.push(`<rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="${esc(o.fill)}"${r}${opacity}/>`)
    return
  }
  if (o.type === 'image') {
    const r = opts.resolveImage ? opts.resolveImage(o.src) : { ok: false as const, note: 'the picture is not embedded here' }
    if (r.ok) {
      const fit = o.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'
      parts.push(`<image x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" preserveAspectRatio="${fit}" href="${esc(r.dataUri)}" xlink:href="${esc(r.dataUri)}"${opacity}>`
        + `<title>${esc(o.alt || o.src)}</title></image>`)
      return
    }
    // A HIANYZO KEP NEM TUNIK EL: a helyen lathato tabla all, es megmondja,
    // melyik fajlrol van szo es mi a baj vele.
    parts.push(`<g${opacity}><rect x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}" fill="#f2f2f2" stroke="#b00020" stroke-dasharray="8 6"/>`
      + `<text x="${o.x + 12}" y="${o.y + 28}" font-family="${esc(FONT_STACK.sans)}" font-size="18" fill="#b00020">${esc(o.src)}</text>`
      + `<text x="${o.x + 12}" y="${o.y + 52}" font-family="${esc(FONT_STACK.sans)}" font-size="16" fill="#b00020">${esc(r.note)}</text></g>`)
    return
  }
  const lines = wrapText(o.text, o.width, o.fontSize, o.font)
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'
  const tx = o.align === 'center' ? o.x + o.width / 2 : o.align === 'right' ? o.x + o.width : o.x
  const lineHeight = Math.round(o.fontSize * 1.25)
  // Az elso sor alapvonala: a betumagassag miatt a doboz tetejetol lejjebb.
  let ty = o.y + Math.round(o.fontSize * 0.95)
  const style = `font-family="${esc(FONT_STACK[o.font])}" font-size="${o.fontSize}" fill="${esc(o.color)}"`
    + (o.bold ? ' font-weight="bold"' : '') + (o.italic ? ' font-style="italic"' : '')
  parts.push(`<g${opacity}>`)
  for (const line of lines) {
    parts.push(`<text x="${tx}" y="${ty}" text-anchor="${anchor}" ${style}>${esc(line)}</text>`)
    ty += lineHeight
  }
  parts.push('</g>')
}

/** Rovid, EMBERI osszefoglalo a vaszonrol -- ezt kapja az agent es a naplo. */
export function canvasSummary(doc: CanvasDoc): string {
  if (!doc.objects.length) return `empty canvas, ${doc.width}x${doc.height}`
  const items = doc.objects.map((o) => {
    const extra = (o.rotation ? `, turned ${o.rotation}°` : '') + (o.group ? `, group "${o.group}"` : '')
    return o.type === 'text' ? `${o.id} (text: "${o.text.slice(0, 40)}"${extra})` : `${o.id} (${o.type}${extra})`
  })
  return `${doc.width}x${doc.height}, ${doc.objects.length} objects: ${items.join(', ')}`
}

/** `.canvas.json`-e a fajl. A vizsgalat a NEVRE megy, mert a tartalmat csak
 *  ezutan olvassuk be -- es a rossz tartalmu fajl is ez a fajta. */
export function isCanvasFile(name: unknown): boolean {
  // A ` (2)` valtozatot is fel kell ismerni: a fajl-iro SOSE ir felul, foglalt
  // nevnel szabad nevet keres (`freeFileName`), es a szamot a KITERJESZTES ELE
  // teszi -- `rajz.canvas.json` -> `rajz.canvas (2).json`. Enelkul a masodik
  // mentes utan a rajz ugy tunne el, mintha sosem lett volna (kanban #336).
  return /\.canvas(?: \(\d+\))?\.json$/i.test(String(name ?? ''))
}

/** A munkadarab cimebol fajlnev: `Nyari plakat` -> `nyari-plakat.canvas.json`. */
export function canvasFileName(title: unknown): string {
  const base = String(title ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `${base || 'rajz'}${CANVAS_EXT}`
}
