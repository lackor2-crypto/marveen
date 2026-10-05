/**
 * MUNKAPAD: SABLONOK (kanban #406, 11. pont).
 *
 * "Ajanlat, level, kozossegi poszt vagy meghivo egy kattintassal, elore
 * kitoltott szerkezettel." A sablon egy UJ munkadarab, aminek a reszei mar
 * megvannak: a felhasznalo nem ures lappal indul, hanem a szerkezettel, es a
 * szogletes zarojeles helyeket ([Ugyfel neve]) irja at.
 *
 * A sablonok a KODBAN elnek, nem az adatbazisban: friss telepitesen is ott
 * vannak, nincs mit beallitani. A szoveg a FELULET nyelvet koveti (HU/EN), es
 * nincs benne semmilyen telepitesfuggo nev -- az alairas is helyorzo.
 *
 * A letrehozas EGY tranzakcio: munkadarab + v1 verzio + minden resz. Ha egy
 * resz elbukik, nem marad felkesz munkadarab a listaban.
 */
import { getDb } from './db.js'
import type { ProjectRow } from './projects.js'
import {
  createWorkItem, addWorkItemPart, listWorkItemParts, getWorkItem, TITLE_MAX,
  type WorkItemType, type WorkItemRow, type WorkItemVersionRow, type WorkItemPartRow,
} from './workbench.js'
import { parseCanvas, type CanvasDoc } from './workbench-graphic.js'
import { commitCanvasChange, type CanvasStepSource } from './workbench-canvas-store.js'
import { canvasPlatform } from './workbench-canvas-platforms.js'

type Lang = 'hu' | 'en'
type Text = { hu: string; en: string }

export interface WorkbenchTemplate {
  id: string
  type: WorkItemType
  name: Text
  description: Text
  /** A reszek sorrendben; mindegyik egy szoveg-blokk. */
  parts: Text[]
  /** #493: the item opens on a platform-sized canvas with the parts' text laid on it, not on the
   *  parts list. The parts stay, as with the "convert to canvas post" button. */
  canvas?: boolean
}

/** The size a canvas template starts at when the caller names no (known) platform. */
export const TEMPLATE_CANVAS_PLATFORM = 'facebook_post'

export const WORKBENCH_TEMPLATES: readonly WorkbenchTemplate[] = [
  {
    id: 'offer',
    type: 'document',
    name: { hu: 'Ajánlat', en: 'Offer' },
    description: {
      hu: 'Árajánlat egy ügyfélnek: mit, mennyiért, meddig érvényes.',
      en: 'A quote for a client: what, for how much, valid until when.',
    },
    parts: [
      { hu: 'Árajánlat -- [Ügyfél neve]', en: 'Quote -- [Client name]' },
      {
        hu: 'Tisztelt [Ügyfél neve]!\n\nKöszönöm a megkeresést. Az alábbiakban küldöm az ajánlatomat a(z) [munka rövid leírása] elvégzésére.',
        en: 'Dear [Client name],\n\nThank you for your enquiry. Please find below my offer for [short description of the work].',
      },
      {
        hu: 'Mit tartalmaz az ajánlat:\n- [1. tétel]\n- [2. tétel]\n- [3. tétel]',
        en: 'What the offer includes:\n- [Item 1]\n- [Item 2]\n- [Item 3]',
      },
      {
        hu: 'Ár: [összeg] Ft + ÁFA\nElkészülés: [időpont]\nAz ajánlat érvényes: [dátum]-ig',
        en: 'Price: [amount] + VAT\nCompletion: [date]\nThis offer is valid until: [date]',
      },
      {
        hu: 'Ha kérdése van, keressen bizalommal.\n\nÜdvözlettel:\n[Az Ön neve]\n[Telefonszám] · [E-mail cím]',
        en: 'If you have any questions, please get in touch.\n\nKind regards,\n[Your name]\n[Phone] · [Email address]',
      },
    ],
  },
  {
    id: 'letter',
    type: 'document',
    name: { hu: 'Levél', en: 'Letter' },
    description: {
      hu: 'Hivatalos vagy üzleti levél megszólítással, tárggyal és aláírással.',
      en: 'A formal or business letter with greeting, subject and signature.',
    },
    parts: [
      { hu: 'Tárgy: [a levél tárgya]', en: 'Subject: [subject of the letter]' },
      {
        hu: 'Tisztelt [Címzett neve]!\n\n[Első bekezdés: miért írok.]',
        en: 'Dear [Recipient name],\n\n[First paragraph: why I am writing.]',
      },
      {
        hu: '[Második bekezdés: a részletek, amit a címzettnek tudnia kell.]',
        en: '[Second paragraph: the details the recipient needs to know.]',
      },
      {
        hu: '[Zárás: mit kérek, és meddig.]\n\nÜdvözlettel:\n[Az Ön neve]\n[Kelt: hely, dátum]',
        en: '[Closing: what I am asking for, and by when.]\n\nKind regards,\n[Your name]\n[Place, date]',
      },
    ],
  },
  {
    id: 'social_post',
    type: 'composite',
    canvas: true,
    name: { hu: 'Közösségi poszt', en: 'Social post' },
    description: {
      hu: 'Facebook-, Instagram- vagy LinkedIn-bejegyzés a választott méretű vásznon: figyelemfelkeltő első sor, szöveg, felhívás, címkék. Mindet közvetlenül a vásznon írod át; képet a bal oldali „Feltöltések” fülről teszel rá.',
      en: 'A Facebook, Instagram or LinkedIn post on a canvas of the chosen size: an eye-catching first line, text, call to action, hashtags. You rewrite them right on the canvas; add a picture from the "Uploads" tab on the left.',
    },
    parts: [
      { hu: '[Figyelemfelkeltő első mondat]', en: '[Eye-catching first sentence]' },
      {
        hu: '[2-3 mondat arról, mi történt / mit kínálsz, és miért jó ez az olvasónak.]',
        en: '[2-3 sentences about what happened / what you offer, and why it is good for the reader.]',
      },
      {
        hu: '👉 [Felhívás: például „Írj üzenetet!”, „Foglalj időpontot!”, „Nézd meg a honlapon!”]',
        en: '👉 [Call to action: for example "Send a message!", "Book a time!", "See the website!"]',
      },
      { hu: '#[címke1] #[címke2] #[címke3]', en: '#[tag1] #[tag2] #[tag3]' },
    ],
  },
  {
    id: 'invitation',
    type: 'document',
    name: { hu: 'Meghívó', en: 'Invitation' },
    description: {
      hu: 'Meghívó egy eseményre: mi, mikor, hol, és hogyan kell visszajelezni.',
      en: 'An invitation to an event: what, when, where, and how to reply.',
    },
    parts: [
      { hu: 'Meghívó -- [Az esemény neve]', en: 'Invitation -- [Name of the event]' },
      {
        hu: 'Kedves [Meghívott neve]!\n\nSzeretettel meghívlak a(z) [esemény] alkalmából.',
        en: 'Dear [Guest name],\n\nYou are warmly invited to [event].',
      },
      {
        hu: 'Időpont: [dátum], [óra]\nHelyszín: [cím]\n[Egyéb tudnivaló: öltözet, parkolás, ajándék]',
        en: 'Date: [date], [time]\nPlace: [address]\n[Other details: dress code, parking, gifts]',
      },
      {
        hu: 'Kérlek, jelezz vissza [dátum]-ig: [telefonszám vagy e-mail].\n\nSzeretettel vár:\n[Az Ön neve]',
        en: 'Please reply by [date]: [phone or email].\n\nLooking forward to seeing you,\n[Your name]',
      },
    ],
  },
]

export function getTemplate(id: unknown): WorkbenchTemplate | undefined {
  return typeof id === 'string' ? WORKBENCH_TEMPLATES.find((t) => t.id === id) : undefined
}

export interface TemplateView {
  id: string
  type: WorkItemType
  name: string
  description: string
  part_count: number
  /** Az elso resz, hogy a felulet megmutathassa, mivel indul. */
  first_line: string
  /** #493: starts on a platform-sized canvas -- the front end offers the platform picker for it. */
  canvas: boolean
}

/** A sablonok a felulet nyelven. */
export function listTemplates(lang: Lang): TemplateView[] {
  return WORKBENCH_TEMPLATES.map((t) => ({
    id: t.id,
    type: t.type,
    name: t.name[lang],
    description: t.description[lang],
    part_count: t.parts.length,
    first_line: (t.parts[0]?.[lang] ?? '').split('\n')[0],
    canvas: !!t.canvas,
  }))
}

/**
 * The post layout on a canvas: the first text as a headline, the rest as body text below it.
 * Same placement as the "convert to canvas post" button lays out a post without a picture
 * (web/workbench.js postCanvasDoc), so a post looks the same whichever way it reached the canvas.
 */
export function postCanvasFromTexts(texts: readonly string[], width: number, height: number): CanvasDoc {
  const W = width, H = height
  const lines = texts.map((s) => s.trim()).filter(Boolean)
  const objects: Record<string, unknown>[] = []
  const pad = Math.round(W * 0.06)
  const top = pad
  if (lines.length) {
    const head = Math.round(W * 0.05)
    objects.push({ type: 'text', text: lines[0], x: pad, y: top + Math.round(pad / 2), width: W - 2 * pad, height: Math.round(head * 2.6), fontSize: head, color: '#111111', bold: true, align: 'left' })
  }
  if (lines.length > 1) {
    const body = Math.round(W * 0.028)
    const y = top + Math.round(pad / 2) + Math.round(W * 0.05 * 2.8)
    objects.push({ type: 'text', text: lines.slice(1).join('\n\n'), x: pad, y, width: W - 2 * pad, height: Math.max(body * 2, H - y - pad), fontSize: body, color: '#333333', align: 'left' })
  }
  const parsed = parseCanvas({ width: W, height: H, background: '#ffffff', objects })
  if (!parsed.ok) throw new Error(`post canvas layout rejected: ${parsed.detail}`)
  return parsed.doc
}

export type CreateFromTemplateResult =
  | {
    ok: true; item: WorkItemRow; version: WorkItemVersionRow; parts: WorkItemPartRow[]; template: string
    /** Canvas template only: the canvas was written. False = it stayed a parts list (e.g. the project has
     *  no folder yet); the item is still made, and its page offers the convert button. */
    canvas?: boolean
  }
  | { ok: false; code: 'template_not_found' | 'title_too_long' | 'template_failed'; detail?: string }

/**
 * Uj munkadarab a sablonbol, a projektben. A cim a megadott, vagy ha ures, a
 * sablon neve (a felulet nyelven) -- igy tenyleg egy kattintas.
 *
 * A canvas template (#493) also gets its canvas at the `platform` size (default: Facebook post).
 * The canvas is written after the item and its parts, outside their transaction: it is a file in
 * the project folder, and a project without one keeps the old parts-list post rather than nothing.
 */
export function createFromTemplate(
  project: Pick<ProjectRow, 'id'>,
  templateId: unknown,
  opts: { title?: unknown; lang: Lang; created_by?: string | null; platform?: unknown; source?: CanvasStepSource },
): CreateFromTemplateResult {
  const tpl = getTemplate(templateId)
  if (!tpl) return { ok: false, code: 'template_not_found' }
  const given = typeof opts.title === 'string' ? opts.title.trim() : ''
  const title = given || tpl.name[opts.lang]
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long' }

  class Abort extends Error {}
  const db = getDb()
  let made: CreateFromTemplateResult
  try {
    made = db.transaction((): CreateFromTemplateResult => {
      const r = createWorkItem({
        project_id: project.id,
        type: tpl.type,
        title,
        created_by: opts.created_by ?? null,
        prompt: null,
      })
      if (!r.ok) throw new Abort(r.code)
      for (const text of tpl.parts) {
        const p = addWorkItemPart({ work_item_id: r.item.id, kind: 'text', text: text[opts.lang], created_by: opts.created_by ?? null })
        if (!p.ok) throw new Abort(p.code)
      }
      return { ok: true, item: r.item, version: r.version, parts: listWorkItemParts(r.item.id), template: tpl.id }
    })()
  } catch (e) {
    if (e instanceof Abort) return { ok: false, code: 'template_failed', detail: e.message }
    throw e
  }
  if (!made.ok || !tpl.canvas) return made

  const size = canvasPlatform(opts.platform) ?? canvasPlatform(TEMPLATE_CANVAS_PLATFORM)
  const doc = postCanvasFromTexts(made.parts.map((p) => p.text ?? ''), size?.width ?? 1200, size?.height ?? 630)
  let laid: ReturnType<typeof commitCanvasChange>
  try {
    laid = commitCanvasChange(made.item, doc, { source: opts.source ?? 'owner', label: 'replace', actor: opts.created_by ?? null })
  } catch {
    // The item is already made: a failed canvas write leaves the parts-list post, never an error page.
    return { ...made, canvas: false }
  }
  if (!laid.ok || !laid.created) return { ...made, canvas: false }
  return {
    ...made,
    item: getWorkItem(made.item.id) ?? made.item,
    version: laid.created.version,
    parts: listWorkItemParts(made.item.id),
    canvas: true,
  }
}
