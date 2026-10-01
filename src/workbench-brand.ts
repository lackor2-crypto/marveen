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
 */
import { getDb } from './db.js'
import { safeColor, type CanvasDoc, type CanvasFont, type CanvasObject, type CanvasImage } from './workbench-graphic.js'

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
  no_exclamation: boolean
  /** Free-text style rules; the agent follows them, the machine cannot check them. */
  notes: string[]
}

export interface BrandRow extends Brand { project_id: string; updated_at: number }

export type BrandCode =
  | 'bad_color' | 'too_many_colors' | 'bad_logo' | 'bad_font' | 'bad_corner'
  | 'bad_min_width' | 'too_many_notes' | 'note_too_long' | 'bad_input'

export type BrandResult =
  | { ok: true; brand: BrandRow }
  | { ok: false; code: BrandCode; detail?: string }

export function emptyBrand(): Brand {
  return {
    colors: [], logo_light: null, logo_dark: null, font_heading: null, font_body: null,
    logo_corner: null, logo_min_width_pct: null, no_exclamation: false, notes: [],
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
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1 || n > 80) return { ok: false, code: 'bad_min_width' }
      b.logo_min_width_pct = Math.round(n * 10) / 10
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

export function getBrand(projectId: string): BrandRow | null {
  ensureBrandTable()
  const row = getDb().prepare('SELECT data, updated_at FROM workbench_brand WHERE project_id = ?')
    .get(projectId) as { data: string; updated_at: number } | undefined
  if (!row) return null
  let parsed: unknown
  try { parsed = JSON.parse(row.data) } catch { return null }
  const p = parseBrand(parsed)
  // A stored brand that no longer validates is treated as "not read", never as an empty brand.
  return p.ok ? { ...p.brand, project_id: projectId, updated_at: row.updated_at } : null
}

/** True when the brand holds nothing the agent or the check could use. */
export function brandIsEmpty(b: Brand): boolean {
  return !b.colors.length && !b.logo_light && !b.logo_dark && !b.font_heading && !b.font_body
    && !b.logo_corner && b.logo_min_width_pct == null && !b.no_exclamation && !b.notes.length
}

/** Saves a (partial) change: only the keys present in `patch` are touched. */
export function saveBrand(projectId: string, patch: unknown): BrandResult {
  const cur = getBrand(projectId)
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
  code: 'off_palette' | 'off_font' | 'logo_missing' | 'logo_small' | 'logo_corner' | 'exclamation'
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
  return o.type === 'text'
    ? { hu: `A(z) „${o.text.slice(0, 30)}” szöveg`, en: `The text "${o.text.slice(0, 30)}"` }
    : { hu: `A(z) ${o.id} elem`, en: `The element ${o.id}` }
}

/**
 * Compares a drawing with the brand. Returns [] when everything is in order or
 * when the brand has nothing to check against. Pure: no database, no files.
 */
export function checkCanvasBrand(doc: CanvasDoc, brand: Brand | null): BrandFinding[] {
  if (!brand || brandIsEmpty(brand)) return []
  const out: BrandFinding[] = []
  const palette = new Set(brand.colors.map((c) => c.hex))

  if (palette.size) {
    const colorsOf = (o: CanvasObject): string[] => {
      if (o.type === 'text') return [o.color]
      if (o.type === 'rect') return [o.fill]
      if (o.type === 'ellipse') return [o.fill, o.stroke]
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
    for (const o of doc.objects) {
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
    for (const o of doc.objects) {
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
    for (const o of doc.objects) {
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
    const used = doc.objects.filter((o): o is CanvasImage => o.type === 'image' && logos.includes(o.src))
    if (!used.length) {
      out.push({
        code: 'logo_missing', object: null,
        message: { hu: 'A márka logója nincs rajta a grafikán.', en: 'The brand logo is not on the drawing.' },
      })
    }
    for (const l of used) {
      const pct = (l.width / doc.width) * 100
      if (brand.logo_min_width_pct != null && pct < brand.logo_min_width_pct) {
        out.push({
          code: 'logo_small', object: l.id,
          message: {
            hu: `A logó túl kicsi: a grafika szélességének ${Math.round(pct)}%-a, legalább ${brand.logo_min_width_pct}% kell.`,
            en: `The logo is too small: ${Math.round(pct)}% of the drawing width, at least ${brand.logo_min_width_pct}% is needed.`,
          },
        })
      }
      if (brand.logo_corner) {
        const cx = (l.x + l.width / 2) / doc.width
        const cy = (l.y + l.height / 2) / doc.height
        const corner: LogoCorner = `${cy < 0.5 ? 'top' : 'bottom'}-${cx < 0.5 ? 'left' : 'right'}` as LogoCorner
        if (corner !== brand.logo_corner) {
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
  if (!b || brandIsEmpty(b)) return 'Brand Kit of this project: none set yet (it was read and it is empty). Do not invent brand colours.'
  const lines: string[] = ['Brand Kit of this project. Apply it by yourself to every post, drawing and document of this brand; do not ask the owner to repeat it:']
  if (b.colors.length) lines.push('- Colours: ' + b.colors.map((c) => (c.name ? `${c.name} ${c.hex}` : c.hex)).join(', ') + ' (use only these, plus black/white/grey)')
  if (b.logo_light) lines.push(`- Logo for light backgrounds (image src): ${b.logo_light}`)
  if (b.logo_dark) lines.push(`- Logo for dark backgrounds (image src): ${b.logo_dark}`)
  if (b.font_heading) lines.push(`- Heading font: ${b.font_heading}`)
  if (b.font_body) lines.push(`- Body font: ${b.font_body}`)
  if (b.logo_corner) lines.push(`- The logo always goes ${CORNER_LABEL[b.logo_corner].en}`)
  if (b.logo_min_width_pct != null) lines.push(`- The logo is at least ${b.logo_min_width_pct}% of the drawing width`)
  if (b.no_exclamation) lines.push('- No exclamation marks in any text')
  for (const n of b.notes) lines.push(`- Rule: ${n}`)
  lines.push('After a canvas change, run brand.check; if it lists deviations, fix them or tell the owner why you left them.')
  return lines.join('\n')
}
