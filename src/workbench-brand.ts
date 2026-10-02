/**
 * WORKBENCH BRAND KIT (v4 spec phase 4, K-4.1 .. K-4.3).
 *
 * One brand per project: logos (a light-background and a dark-background
 * version), colours, fonts and a few style rules. Three consumers:
 *   - the owner edits it on the Brand Kit panel and sees the brand colours
 *     first in every colour picker of the canvas editor (K-4.2, manual side);
 *   - the Workbench agent gets it in every turn and applies it by itself
 *     (K-4.2, agent side), and can run the brand check;
 *   - checkCanvasBrand() compares a drawing with the brand and lists every
 *     deviation in plain language (K-4.3). It never changes the drawing.
 *
 * Logos are references to pictures kept once in the project's shared
 * materials (K-0.19), never copies. The canvas only has three font families
 * (sans / serif / mono), so a brand font is one of those three.
 *
 * Brand templates (K-4.1) are drawings the owner saved as the starting point
 * of the brand's next drawings; see the section at the end of this file.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { safeColor, parseCanvas, type CanvasDoc, type CanvasFont, type CanvasObject, type CanvasImage } from './workbench-graphic.js'

export const BRAND_MAX_COLORS = 12
export const BRAND_MAX_NOTES = 20
export const BRAND_NOTE_MAX_CHARS = 300
export const BRAND_NAME_MAX_CHARS = 40
export const BRAND_FONTS: readonly CanvasFont[] = ['sans', 'serif', 'mono']
export const LOGO_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export type LogoCorner = (typeof LOGO_CORNERS)[number]

export interface BrandColor { name: string; hex: string }

export interface Brand {
  colors: BrandColor[]
  logo_light: string | null
  logo_dark: string | null
  font_heading: CanvasFont | null
  font_body: CanvasFont | null
  /** The logo must sit in this corner of the drawing. */
  logo_corner: LogoCorner | null
  /** The logo must be at least this wide, in percent of the drawing width. */
  logo_min_width_pct: number | null
  /** Nothing else may come closer to the logo than this, in percent of the logo's own width. */
  logo_clear_space_pct: number | null
  no_exclamation: boolean
  /** Free-text style rules; the agent follows them, the machine cannot check them. */
  notes: string[]
}

export interface BrandRow extends Brand { project_id: string; updated_at: number }

export type BrandCode =
  | 'bad_color' | 'too_many_colors' | 'bad_logo' | 'bad_font' | 'bad_corner'
  | 'bad_min_width' | 'bad_clear_space' | 'too_many_notes' | 'note_too_long' | 'bad_input'

export type BrandResult =
  | { ok: true; brand: BrandRow }
  | { ok: false; code: BrandCode; detail?: string }

export function emptyBrand(): Brand {
  return {
    colors: [], logo_light: null, logo_dark: null, font_heading: null, font_body: null,
    logo_corner: null, logo_min_width_pct: null, logo_clear_space_pct: null, no_exclamation: false, notes: [],
  }
}

let tablesDb: unknown = null

export function ensureBrandTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS workbench_brand (
      project_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workbench_brand_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      doc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wb_brand_templates_project ON workbench_brand_templates(project_id);
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i

/** A logo path is a plain relative picture path: no `..`, no scheme, no absolute path. */
export function isLogoPath(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (!s || s.length > 500) return false
  if (s.startsWith('/') || s.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(s)) return false
  if (s.split('/').some((seg) => seg === '..' || seg === '')) return false
  return IMAGE_EXT.test(s)
}

function normHex(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase()
  const c = safeColor(s, '')
  if (!c || c === 'none') return null
  // #abc -> #aabbcc, so two spellings of one colour compare equal
  return c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c
}

/** Parses and validates an owner/agent supplied brand. Unknown keys are ignored. */
export function parseBrand(raw: unknown, base: Brand = emptyBrand()): { ok: true; brand: Brand } | { ok: false; code: BrandCode; detail?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'bad_input' }
  const r = raw as Record<string, unknown>
  const b: Brand = { ...base, colors: base.colors.slice(), notes: base.notes.slice() }

  if ('colors' in r) {
    if (!Array.isArray(r.colors)) return { ok: false, code: 'bad_color' }
    if (r.colors.length > BRAND_MAX_COLORS) return { ok: false, code: 'too_many_colors' }
    const seen = new Set<string>()
    const colors: BrandColor[] = []
    for (const c of r.colors) {
      const o = (c && typeof c === 'object' ? c : { hex: c }) as Record<string, unknown>
      const hex = normHex(o.hex)
      if (!hex) return { ok: false, code: 'bad_color', detail: String(o.hex ?? '') }
      if (seen.has(hex)) continue
      seen.add(hex)
      const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, BRAND_NAME_MAX_CHARS) : ''
      colors.push({ name, hex })
    }
    b.colors = colors
  }
  for (const key of ['logo_light', 'logo_dark'] as const) {
    if (!(key in r)) continue
    const v = r[key]
    if (v == null || v === '') { b[key] = null; continue }
    if (!isLogoPath(v)) return { ok: false, code: 'bad_logo', detail: key }
    b[key] = v.trim()
  }
  for (const key of ['font_heading', 'font_body'] as const) {
    if (!(key in r)) continue
    const v = r[key]
    if (v == null || v === '') { b[key] = null; continue }
    if (!(BRAND_FONTS as readonly unknown[]).includes(v)) return { ok: false, code: 'bad_font', detail: key }
    b[key] = v as CanvasFont
  }
  if ('logo_corner' in r) {
    const v = r.logo_corner
    if (v == null || v === '') b.logo_corner = null
    else if ((LOGO_CORNERS as readonly unknown[]).includes(v)) b.logo_corner = v as LogoCorner
    else return { ok: false, code: 'bad_corner' }
  }
  if ('logo_min_width_pct' in r) {
    const v = r.logo_min_width_pct
    if (v == null || v === '') b.logo_min_width_pct = null
    else {
      // A number, or a number typed as text. `true` or `[15]` is not a width.
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 80) return { ok: false, code: 'bad_min_width' }
      b.logo_min_width_pct = Math.round(n * 10) / 10
    }
  }
  if ('logo_clear_space_pct' in r) {
    const v = r.logo_clear_space_pct
    if (v == null || v === '') b.logo_clear_space_pct = null
    else {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 100) return { ok: false, code: 'bad_clear_space' }
      b.logo_clear_space_pct = Math.round(n * 10) / 10
    }
  }
  if ('no_exclamation' in r) b.no_exclamation = r.no_exclamation === true
  if ('notes' in r) {
    if (!Array.isArray(r.notes)) return { ok: false, code: 'bad_input' }
    const notes: string[] = []
    for (const n of r.notes) {
      const s = typeof n === 'string' ? n.replace(/\s+/g, ' ').trim() : ''
      if (!s) continue
      if (s.length > BRAND_NOTE_MAX_CHARS) return { ok: false, code: 'note_too_long' }
      notes.push(s)
    }
    if (notes.length > BRAND_MAX_NOTES) return { ok: false, code: 'too_many_notes' }
    b.notes = notes
  }
  return { ok: true, brand: b }
}

/** There IS a stored brand, but it cannot be understood. Never the same as "no brand yet". */
export class BrandUnreadableError extends Error {
  constructor(public readonly projectId: string) {
    super('the stored Brand Kit of this project cannot be read')
    this.name = 'BrandUnreadableError'
  }
}

/** `null` = nothing stored yet. Throws BrandUnreadableError when a stored brand no longer validates. */
export function getBrand(projectId: string): BrandRow | null {
  ensureBrandTable()
  const row = getDb().prepare('SELECT data, updated_at FROM workbench_brand WHERE project_id = ?')
    .get(projectId) as { data: string; updated_at: number } | undefined
  if (!row) return null
  let parsed: unknown
  try { parsed = JSON.parse(row.data) } catch { throw new BrandUnreadableError(projectId) }
  const p = parseBrand(parsed)
  if (!p.ok) throw new BrandUnreadableError(projectId)
  return { ...p.brand, project_id: projectId, updated_at: row.updated_at }
}

/** True when the brand holds nothing the agent or the check could use. */
export function brandIsEmpty(b: Brand): boolean {
  return !b.colors.length && !b.logo_light && !b.logo_dark && !b.font_heading && !b.font_body
    && !b.logo_corner && b.logo_min_width_pct == null && b.logo_clear_space_pct == null && !b.no_exclamation && !b.notes.length
}

/** Saves a (partial) change: only the keys present in `patch` are touched. */
export function saveBrand(projectId: string, patch: unknown): BrandResult {
  // An unreadable stored brand is replaced: saving again is the owner's way out of it.
  let cur: BrandRow | null = null
  try { cur = getBrand(projectId) } catch (e) { if (!(e instanceof BrandUnreadableError)) throw e }
  const p = parseBrand(patch, cur ?? emptyBrand())
  if (!p.ok) return p
  const t = now()
  getDb().prepare(
    'INSERT INTO workbench_brand (project_id, data, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  ).run(projectId, JSON.stringify(p.brand), t)
  return { ok: true, brand: { ...p.brand, project_id: projectId, updated_at: t } }
}

// ---- the brand check (K-4.3) --------------------------------------------------------

type Text = { hu: string; en: string }

export interface BrandFinding {
  code: 'off_palette' | 'off_font' | 'logo_missing' | 'logo_small' | 'logo_corner' | 'logo_crowded' | 'exclamation'
  /** The canvas object the finding is about, when there is one. */
  object: string | null
  message: Text
}

/** Black, white and the neutral greys are never flagged: a brand palette rarely lists them. */
function isNeutral(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12
}

function colorName(brand: Brand, hex: string): string {
  const c = brand.colors.find((x) => x.hex === hex)
  return c?.name ? `${c.name} (${hex})` : hex
}

const CORNER_LABEL: Record<LogoCorner, Text> = {
  'top-left': { hu: 'a bal felső sarokban', en: 'in the top left corner' },
  'top-right': { hu: 'a jobb felső sarokban', en: 'in the top right corner' },
  'bottom-left': { hu: 'a bal alsó sarokban', en: 'in the bottom left corner' },
  'bottom-right': { hu: 'a jobb alsó sarokban', en: 'in the bottom right corner' },
}

function objLabel(o: CanvasObject): Text {
  if (o.type !== 'text') return { hu: `A(z) ${o.id} elem`, en: `The element ${o.id}` }
  // One line, and a cut text says it was cut.
  const flat = o.text.replace(/\s+/g, ' ').trim()
  const s = flat.length > 30 ? flat.slice(0, 30).trimEnd() + '…' : flat
  return { hu: `A(z) „${s}” szöveg`, en: `The text "${s}"` }
}

/**
 * What cannot be seen is not on the drawing: a fully transparent element or an
 * empty text is neither a deviation nor "the logo is there".
 */
function isVisible(o: CanvasObject): boolean {
  return !(o.opacity <= 0) && (o.type !== 'text' || o.text.trim() !== '')
}

/** Which half the centre falls in; dead centre is neither (so it is in no corner). */
function half(pos: number, low: string, high: string): string | null {
  return Math.abs(pos - 0.5) < 1e-6 ? null : pos < 0.5 ? low : high
}

/**
 * A canvas picture can be written two ways (as the drawing itself resolves it):
 * the Depot-relative path the brand stores, or relative to the project folder,
 * which is how the agent sees the project's files. Both are the same file.
 */
function isLogoSrc(src: string, logo: string, projectFolder: string | null | undefined): boolean {
  const s = src.trim()
  if (s === logo) return true
  const base = projectFolder ? projectFolder.replace(/\/+$/, '') : ''
  return !!base && `${base}/${s.replace(/^[./\\]+/, '')}` === logo
}

/**
 * Compares a drawing with the brand. Returns [] when everything is in order or
 * when the brand has nothing to check against. Pure: no database, no files.
 * `projectFolder` (the project's folder_path) lets a project-relative logo path match.
 */
export function checkCanvasBrand(doc: CanvasDoc, brand: Brand | null, projectFolder?: string | null): BrandFinding[] {
  if (!brand || brandIsEmpty(brand)) return []
  const out: BrandFinding[] = []
  const palette = new Set(brand.colors.map((c) => c.hex))
  const objects = doc.objects.filter(isVisible)

  if (palette.size) {
    const colorsOf = (o: CanvasObject): string[] => {
      if (o.type === 'text') return [o.color]
      if (o.type === 'rect') return [o.fill]
      // An outline of zero width is not drawn (see renderCanvasSvg), so its colour is not on the drawing.
      if (o.type === 'ellipse') return o.strokeWidth > 0 ? [o.fill, o.stroke] : [o.fill]
      if (o.type === 'line') return [o.stroke]
      return []
    }
    const check = (raw: string, who: Text): void => {
      const hex = normHex(raw)
      if (!hex || palette.has(hex) || isNeutral(hex)) return
      out.push({
        code: 'off_palette', object: null,
        message: { hu: `${who.hu} ${hex} színű, ami nincs a márkaszínek között.`, en: `${who.en} uses ${hex}, which is not one of the brand colours.` },
      })
    }
    check(doc.background, { hu: 'A háttér', en: 'The background' })
    for (const o of objects) {
      const seen = new Set<string>()
      for (const c of colorsOf(o)) {
        const hex = normHex(c)
        if (!hex || seen.has(hex)) continue
        seen.add(hex)
        if (palette.has(hex) || isNeutral(hex)) continue
        out.push({
          code: 'off_palette', object: o.id,
          message: { hu: `${objLabel(o).hu} ${hex} színű, ami nincs a márkaszínek között.`, en: `${objLabel(o).en} uses ${hex}, which is not one of the brand colours.` },
        })
      }
    }
  }

  const fonts = [brand.font_heading, brand.font_body].filter((f): f is CanvasFont => !!f)
  if (fonts.length) {
    for (const o of objects) {
      if (o.type === 'text' && !fonts.includes(o.font)) {
        out.push({
          code: 'off_font', object: o.id,
          message: {
            hu: `${objLabel(o).hu} nem a márka betűtípusával készült (${o.font}); a márkáé: ${fonts.join(', ')}.`,
            en: `${objLabel(o).en} does not use the brand font (${o.font}); the brand uses: ${fonts.join(', ')}.`,
          },
        })
      }
    }
  }

  if (brand.no_exclamation) {
    for (const o of objects) {
      if (o.type === 'text' && /[!！]/.test(o.text)) {
        out.push({
          code: 'exclamation', object: o.id,
          message: { hu: `${objLabel(o).hu} felkiáltójelet tartalmaz, a márka szabálya szerint nem lehet.`, en: `${objLabel(o).en} contains an exclamation mark, which the brand rules forbid.` },
        })
      }
    }
  }

  const logos = [brand.logo_light, brand.logo_dark].filter((l): l is string => !!l)
  if (logos.length) {
    const used = objects.filter((o): o is CanvasImage => o.type === 'image' && logos.some((l) => isLogoSrc(o.src, l, projectFolder)))
    if (!used.length) {
      out.push({
        code: 'logo_missing', object: null,
        message: { hu: 'A márka logója nincs rajta a grafikán.', en: 'The brand logo is not on the drawing.' },
      })
    }
    for (const l of used) {
      const pct = (l.width / doc.width) * 100
      if (brand.logo_min_width_pct != null && pct < brand.logo_min_width_pct) {
        // Rounded DOWN to one decimal: 9.6% must not read "10%, at least 10% is needed".
        const shown = Math.floor(pct * 10 + 1e-6) / 10
        out.push({
          code: 'logo_small', object: l.id,
          message: {
            hu: `A logó túl kicsi: a grafika szélességének ${shown}%-a, legalább ${brand.logo_min_width_pct}% kell.`,
            en: `The logo is too small: ${shown}% of the drawing width, at least ${brand.logo_min_width_pct}% is needed.`,
          },
        })
      }
      if (brand.logo_clear_space_pct != null) {
        // The free zone is a margin around the logo, a share of the logo's own
        // width (the way brand guides draw it). An object that holds the whole
        // logo (a background panel) is what the logo sits on, not a crowding one.
        const m = (l.width * brand.logo_clear_space_pct) / 100
        const zone = { x1: l.x - m, y1: l.y - m, x2: l.x + l.width + m, y2: l.y + l.height + m }
        const crowding = objects.filter((o) => {
          if (o.id === l.id || o.type === 'line') return false
          const ox2 = o.x + o.width, oy2 = o.y + o.height
          if (o.x <= l.x && o.y <= l.y && ox2 >= l.x + l.width && oy2 >= l.y + l.height) return false
          return o.x < zone.x2 && ox2 > zone.x1 && o.y < zone.y2 && oy2 > zone.y1
        })
        if (crowding.length) {
          const who = crowding[0]
          const more = crowding.length - 1
          out.push({
            code: 'logo_crowded', object: l.id,
            message: {
              hu: `A logó körül nincs meg a szabad terület (a logó szélességének ${brand.logo_clear_space_pct}%-a): ${objLabel(who).hu}${more ? ` és még ${more} elem` : ''} túl közel van.`,
              en: `The logo's clear space (${brand.logo_clear_space_pct}% of the logo width) is not free: ${objLabel(who).en}${more ? ` and ${more} more` : ''} is too close.`,
            },
          })
        }
      }
      if (brand.logo_corner) {
        // The corner is the quarter the logo's centre falls in. A logo centred on
        // an axis is in no corner: "centred at the bottom" is not "bottom right".
        const v = half((l.y + l.height / 2) / doc.height, 'top', 'bottom')
        const h = half((l.x + l.width / 2) / doc.width, 'left', 'right')
        if (!v || !h || `${v}-${h}` !== brand.logo_corner) {
          out.push({
            code: 'logo_corner', object: l.id,
            message: {
              hu: `A logónak ${CORNER_LABEL[brand.logo_corner].hu} kell lennie, most másutt van.`,
              en: `The logo must be ${CORNER_LABEL[brand.logo_corner].en}, but it is elsewhere.`,
            },
          })
        }
      }
    }
  }
  return out
}

// ---- the agent's view ---------------------------------------------------------------

/** The text block put in front of the Workbench agent in every turn (K-4.2). */
export function brandForContext(projectId: string): string {
  const b = getBrand(projectId)
  const usable = listBrandTemplates(projectId).filter((t) => !t.unreadable)
  const shown = usable.slice(0, CONTEXT_TEMPLATES_MAX).map((t) => `"${t.name}" (${t.width}x${t.height})`).join(', ')
  const templates = usable.length
    ? '- Brand templates (start a new branded drawing from one with brand.useTemplate instead of an empty canvas): ' + shown
      + (usable.length > CONTEXT_TEMPLATES_MAX ? `, and ${usable.length - CONTEXT_TEMPLATES_MAX} more (brand.get lists all)` : '')
    : ''
  if (!b || brandIsEmpty(b)) {
    const none = 'Brand Kit of this project: none set yet (it was read and it is empty). Do not invent brand colours.'
    return templates ? none + '\n' + templates : none
  }
  const lines: string[] = ['Brand Kit of this project. Apply it by yourself to every post, drawing and document of this brand; do not ask the owner to repeat it:']
  if (b.colors.length) lines.push('- Colours: ' + b.colors.map((c) => (c.name ? `${c.name} ${c.hex}` : c.hex)).join(', ') + ' (use only these, plus black/white/grey)')
  if (b.logo_light) lines.push(`- Logo for light backgrounds (image src): ${b.logo_light}`)
  if (b.logo_dark) lines.push(`- Logo for dark backgrounds (image src): ${b.logo_dark}`)
  if (b.font_heading) lines.push(`- Heading font: ${b.font_heading}`)
  if (b.font_body) lines.push(`- Body font: ${b.font_body}`)
  if (b.logo_corner) lines.push(`- The logo always goes ${CORNER_LABEL[b.logo_corner].en}`)
  if (b.logo_min_width_pct != null) lines.push(`- The logo is at least ${b.logo_min_width_pct}% of the drawing width`)
  if (b.logo_clear_space_pct != null) lines.push(`- Keep ${b.logo_clear_space_pct}% of the logo's width free around the logo (nothing else inside that margin)`)
  if (b.no_exclamation) lines.push('- No exclamation marks in any text')
  for (const n of b.notes) lines.push(`- Rule: ${n}`)
  if (templates) lines.push(templates)
  lines.push('After a canvas change, run brand.check; if it lists deviations, fix them or tell the owner why you left them.')
  return lines.join('\n')
}

// ---- brand templates (K-4.1) --------------------------------------------------------
//
// A brand template is a drawing the owner saved as the starting point of the
// brand's next drawings ("Instagram post", "story"). It is a SNAPSHOT of the
// canvas, not a link to the work item it was made from: that work item can be
// changed, binned or purged without touching the template. (The table has no
// work_item_id column on purpose -- purgeWorkItem sweeps every table that has one.)

export const BRAND_MAX_TEMPLATES = 30
export const BRAND_TEMPLATE_NAME_MAX = 80
/** The agent sees this many template names in every turn; brand.get lists all. */
const CONTEXT_TEMPLATES_MAX = 10

export interface BrandTemplate {
  id: string
  name: string
  /** Size and element count of the drawing; `null` when it cannot be read. */
  width: number | null
  height: number | null
  objects: number | null
  created_at: number
  /** The stored drawing no longer validates: it is listed and can be removed, but not used. */
  unreadable: boolean
}

interface TemplateRow { id: string; project_id: string; name: string; doc: string; created_at: number; created_by: string | null }

function templateView(row: Pick<TemplateRow, 'id' | 'name' | 'doc' | 'created_at'>): BrandTemplate {
  const p = parseCanvas(row.doc)
  const base = { id: row.id, name: row.name, created_at: row.created_at }
  return p.ok
    ? { ...base, width: p.doc.width, height: p.doc.height, objects: p.doc.objects.length, unreadable: false }
    : { ...base, width: null, height: null, objects: null, unreadable: true }
}

function templateRows(projectId: string): TemplateRow[] {
  ensureBrandTable()
  return getDb().prepare('SELECT * FROM workbench_brand_templates WHERE project_id = ? ORDER BY name COLLATE NOCASE, created_at, id')
    .all(projectId) as TemplateRow[]
}

/** The project's brand templates by name. An unreadable one is listed too, marked. */
export function listBrandTemplates(projectId: string): BrandTemplate[] {
  return templateRows(projectId).map(templateView)
}

export type BrandTemplateCode = 'template_name_required' | 'template_name_too_long' | 'template_name_taken' | 'too_many_templates'

export type BrandTemplateSave =
  | { ok: true; template: BrandTemplate; replaced: boolean }
  | { ok: false; code: BrandTemplateCode }

const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/**
 * Saves a drawing as a brand template. A name is used once per project: saving
 * under an existing name is refused unless `replace` says the owner meant it.
 */
export function saveBrandTemplate(
  projectId: string,
  rawName: unknown,
  doc: CanvasDoc,
  opts: { replace?: boolean; createdBy?: string | null } = {},
): BrandTemplateSave {
  const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : ''
  if (!name) return { ok: false, code: 'template_name_required' }
  if (name.length > BRAND_TEMPLATE_NAME_MAX) return { ok: false, code: 'template_name_too_long' }
  const rows = templateRows(projectId)
  const old = rows.find((r) => sameName(r.name, name))
  if (old && !opts.replace) return { ok: false, code: 'template_name_taken' }
  if (!old && rows.length >= BRAND_MAX_TEMPLATES) return { ok: false, code: 'too_many_templates' }
  const row = { id: old ? old.id : randomUUID().replace(/-/g, '').slice(0, 12), name, doc: JSON.stringify(doc), created_at: now() }
  const db = getDb()
  if (old) {
    db.prepare('UPDATE workbench_brand_templates SET name = ?, doc = ?, created_at = ?, created_by = ? WHERE id = ?')
      .run(row.name, row.doc, row.created_at, opts.createdBy ?? null, row.id)
  } else {
    db.prepare('INSERT INTO workbench_brand_templates (id, project_id, name, doc, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, projectId, row.name, row.doc, row.created_at, opts.createdBy ?? null)
  }
  return { ok: true, template: templateView(row), replaced: !!old }
}

export type BrandTemplateRead =
  | { ok: true; template: BrandTemplate; doc: CanvasDoc }
  | { ok: false; code: 'template_not_found' | 'template_unreadable'; detail: string | null }

/** One template with its drawing, by id or (for the agent, who knows the names) by name. */
export function getBrandTemplate(projectId: string, idOrName: unknown): BrandTemplateRead {
  const key = typeof idOrName === 'string' ? idOrName.trim() : ''
  const rows = key ? templateRows(projectId) : []
  const row = rows.find((r) => r.id === key) ?? rows.find((r) => sameName(r.name, key))
  if (!row) return { ok: false, code: 'template_not_found', detail: null }
  const p = parseCanvas(row.doc)
  if (!p.ok) return { ok: false, code: 'template_unreadable', detail: `${p.code}: ${p.detail}` }
  return { ok: true, template: templateView(row), doc: p.doc }
}

/** Removes a template. The drawings made from it are work items of their own and stay. */
export function deleteBrandTemplate(projectId: string, id: string): boolean {
  ensureBrandTable()
  return getDb().prepare('DELETE FROM workbench_brand_templates WHERE project_id = ? AND id = ?').run(projectId, id).changes > 0
}
