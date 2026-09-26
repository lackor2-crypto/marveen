/**
 * MUNKAPAD: PROJEKT ATADOCSOMAG (kanban #406, 12. pont).
 *
 * "Egy gombbal minden kesz anyag egy csomagba vagy egyetlen PDF-be kerulne."
 *
 * A csomag egy ZIP, a projekt nevevel:
 *   - `Tartalom.html` (angolul `Contents.html`): EGY dokumentum, ami barmelyik
 *     bongeszoben megnyilik -- tartalomjegyzek, minden munkadarab szovege es
 *     kepei, a projekt ervenyes dontesei, es ha valami kimaradt, AZ IS. A
 *     bongeszo "Nyomtatas -> Mentes PDF-kent" gombja ebbol egyetlen PDF-et
 *     csinal, kulon program nelkul (friss telepitesen sincs LibreOffice-fuggoseg).
 *   - munkadarabonkent egy mappa (`01-Ajanlat/`) az eredeti fajllal es a
 *     kepekkel.
 *
 * Mit visz: alapbol a KESZ ("done") munkadarabokat; kerheto az osszes is.
 *
 * A NULLA KET DOLGOT JELENTHET: a hianyzo fajl NEM csendben marad ki. A terv
 * (`planHandoff`) es a Tartalom is kimondja, melyik fajl nem volt elerheto, es
 * miert (nincs Raktar / eltunt / tul nagy) -- a felhasznalo nem egy hianyos
 * csomagot ad at ugy, hogy nem tud rola.
 *
 * Semmit nem ir a lemezre es semmit nem kuld sehova: a csomag a memoriaban
 * keszul, es a bongeszo tolti le.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { explorerRoot, resolveLifePath } from './life-explorer.js'
import { getProject, type ProjectRow } from './projects.js'
import {
  listWorkItems, listWorkItemParts, getWorkItemVersion,
  type WorkItemRow, type WorkItemPartRow,
} from './workbench.js'
import { sourceRel } from './workbench-preview.js'
import { listDecisions } from './workbench-decisions.js'
import { buildZip, type ZipEntry } from './web/zip-writer.js'

type Lang = 'hu' | 'en'

export const HANDOFF_SCOPES = ['done', 'all'] as const
export type HandoffScope = typeof HANDOFF_SCOPES[number]

/** A csomag a memoriaban keszul: e folott nem vallaljuk (a tervben latszik). */
export const HANDOFF_MAX_BYTES = 200 * 1024 * 1024

export type FileProblem = 'no_depot' | 'unreachable' | 'missing' | 'not_a_file'

export interface HandoffFile {
  rel: string
  name: string
  size: number | null
  problem: FileProblem | null
}

export interface HandoffEntry {
  item_id: string
  title: string
  type: string
  status: string
  version_no: number | null
  folder: string
  source: HandoffFile | null
  text_parts: number
  images: HandoffFile[]
}

export interface HandoffPlan {
  project: { id: string; name: string }
  scope: HandoffScope
  /** Hany munkadarab van a projektben osszesen, es abbol hany kesz. */
  all_count: number
  done_count: number
  items: HandoffEntry[]
  files: number
  total_bytes: number
  /** A kimarado fajlok szama (a tetelek maguk a `problem` mezoben). */
  problems: number
  too_large: boolean
}

const TYPE_LABEL: Record<string, Record<Lang, string>> = {
  document: { hu: 'Dokumentum', en: 'Document' },
  image: { hu: 'Kép', en: 'Image' },
  graphic: { hu: 'Grafika', en: 'Graphic' },
  video: { hu: 'Videó', en: 'Video' },
  note: { hu: 'Jegyzet', en: 'Note' },
  composite: { hu: 'Vegyes', en: 'Mixed' },
}
const STATUS_LABEL: Record<string, Record<Lang, string>> = {
  draft: { hu: 'Vázlat', en: 'Draft' },
  in_progress: { hu: 'Folyamatban', en: 'In progress' },
  review: { hu: 'Átnézésre vár', en: 'In review' },
  done: { hu: 'Kész', en: 'Done' },
}
const PROBLEM_TEXT: Record<FileProblem, Record<Lang, string>> = {
  no_depot: { hu: 'nincs beállítva a Raktár, ezért a fájl nem érhető el', en: 'the Depot is not set up, so the file cannot be reached' },
  unreachable: { hu: 'a fájl útvonala nem érhető el', en: 'the file path cannot be reached' },
  missing: { hu: 'a fájl már nincs meg a helyén', en: 'the file is no longer where it was' },
  not_a_file: { hu: 'ez egy mappa, nem fájl', en: 'this is a folder, not a file' },
}

const L = (lang: Lang, hu: string, en: string) => (lang === 'en' ? en : hu)

/** Fajl- es mappanev, ami minden rendszeren ervenyes (Windows is). */
export function safeName(raw: string, fallback = 'munkadarab'): string {
  const s = String(raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim()
  return s || fallback
}

function inspect(rel: string | null): HandoffFile | null {
  if (!rel) return null
  const name = basename(rel)
  if (!explorerRoot()) return { rel, name, size: null, problem: 'no_depot' }
  const abs = resolveLifePath(rel)
  if (!abs) return { rel, name, size: null, problem: 'unreachable' }
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { rel, name, size: null, problem: 'not_a_file' }
    return { rel, name, size: st.size, problem: null }
  } catch {
    return { rel, name, size: null, problem: 'missing' }
  }
}

function entryFor(item: WorkItemRow, index: number, project: ProjectRow): HandoffEntry {
  const version = item.current_version_id ? getWorkItemVersion(item.current_version_id) ?? null : null
  const parts = listWorkItemParts(item.id)
  const images = parts
    .filter((p) => p.kind === 'image' && p.asset_path)
    .map((p) => inspect(p.asset_path))
    .filter((f): f is HandoffFile => !!f)
  return {
    item_id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    version_no: version ? version.version_no : null,
    folder: `${String(index + 1).padStart(2, '0')}-${safeName(item.title)}`,
    source: inspect(sourceRel(item, version, project)),
    text_parts: parts.filter((p) => p.kind === 'text').length,
    images,
  }
}

export function isHandoffScope(v: unknown): v is HandoffScope {
  return typeof v === 'string' && (HANDOFF_SCOPES as readonly string[]).includes(v)
}

/**
 * Mi kerulne a csomagba -- MIELOTT barmi elkeszulne. A felulet ezt mutatja
 * meg a letoltes gomb felett.
 */
export function planHandoff(projectId: string, scope: HandoffScope): HandoffPlan | null {
  const project = getProject(projectId)
  if (!project) return null
  const all = listWorkItems(project.id)
  const chosen = scope === 'done' ? all.filter((i) => i.status === 'done') : all
  const items = chosen.map((it, i) => entryFor(it, i, project))
  let files = 0
  let total = 0
  let problems = 0
  for (const e of items) {
    for (const f of [e.source, ...e.images]) {
      if (!f) continue
      if (f.problem) { problems++; continue }
      files++
      total += f.size ?? 0
    }
  }
  return {
    project: { id: project.id, name: project.name },
    scope,
    all_count: all.length,
    done_count: all.filter((i) => i.status === 'done').length,
    items,
    files,
    total_bytes: total,
    problems,
    too_large: total > HANDOFF_MAX_BYTES,
  }
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
function hrefOf(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** A zip-en beluli fajlnev: ugyanabban a mappaban nem lehet ket azonos. */
function uniqueIn(used: Set<string>, name: string): string {
  let n = safeName(name, 'fajl')
  if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n }
  const dot = n.lastIndexOf('.')
  const stem = dot > 0 ? n.slice(0, dot) : n
  const ext = dot > 0 ? n.slice(dot) : ''
  for (let i = 2; ; i++) {
    n = `${stem} (${i})${ext}`
    if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n }
  }
}

function contentsHtml(
  plan: HandoffPlan,
  lang: Lang,
  now: Date,
  placed: Map<string, string>,
  partsBy: Map<string, WorkItemPartRow[]>,
): string {
  const title = `${plan.project.name} -- ${L(lang, 'átadócsomag', 'handoff package')}`
  const scopeText = plan.scope === 'done'
    ? L(lang, 'a kész munkadarabok', 'the finished work items')
    : L(lang, 'a projekt összes munkadarabja', 'every work item of the project')
  const out: string[] = []
  out.push(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`)
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  out.push(`<title>${esc(title)}</title>`)
  out.push('<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.5;color:#1f2328}'
    + 'h1{font-size:1.6rem}h2{margin-top:2rem;border-top:1px solid #d0d7de;padding-top:1rem}'
    + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:6px;text-align:left;vertical-align:top}'
    + '.txt{white-space:pre-wrap}.muted{color:#656d76}.warn{background:#fff8c5;border:1px solid #d4a72c;padding:8px;border-radius:6px}'
    + 'img{max-width:100%;height:auto}@media print{h2{page-break-before:always}}</style></head><body>')
  out.push(`<h1>${esc(title)}</h1>`)
  out.push(`<p class="muted">${esc(L(lang, 'Készült', 'Created'))}: ${esc(localDate(now))} · ${esc(L(lang, 'Tartalom', 'Contents'))}: ${esc(scopeText)} (${plan.items.length})</p>`)
  out.push(`<p class="muted">${esc(L(lang,
    'Tipp: egyetlen PDF-hez nyisd meg ezt az oldalt a böngészőben, és válaszd a Nyomtatás -> Mentés PDF-ként lehetőséget.',
    'Tip: for a single PDF, open this page in a browser and choose Print -> Save as PDF.'))}</p>`)

  const missing: string[] = []
  for (const e of plan.items) {
    for (const f of [e.source, ...e.images]) {
      if (f && f.problem) missing.push(`${e.title}: ${f.name} (${PROBLEM_TEXT[f.problem][lang]})`)
    }
  }
  if (missing.length) {
    out.push(`<div class="warn"><strong>${esc(L(lang, 'Figyelem: ezek a fájlok NEM kerültek a csomagba', 'Note: these files are NOT in the package'))}</strong><ul>`)
    for (const m of missing) out.push(`<li>${esc(m)}</li>`)
    out.push('</ul></div>')
  }

  out.push(`<table><thead><tr><th>#</th><th>${esc(L(lang, 'Munkadarab', 'Work item'))}</th><th>${esc(L(lang, 'Fajta', 'Type'))}</th><th>${esc(L(lang, 'Állapot', 'Status'))}</th><th>${esc(L(lang, 'Verzió', 'Version'))}</th></tr></thead><tbody>`)
  plan.items.forEach((e, i) => {
    out.push(`<tr><td>${i + 1}</td><td><a href="#w${i + 1}">${esc(e.title)}</a></td><td>${esc(TYPE_LABEL[e.type]?.[lang] ?? e.type)}</td>`
      + `<td>${esc(STATUS_LABEL[e.status]?.[lang] ?? e.status)}</td><td>${e.version_no != null ? 'v' + e.version_no : ''}</td></tr>`)
  })
  out.push('</tbody></table>')

  plan.items.forEach((e, i) => {
    out.push(`<h2 id="w${i + 1}">${i + 1}. ${esc(e.title)}</h2>`)
    const src = e.source && !e.source.problem ? placed.get(`${e.item_id}|${e.source.rel}`) : null
    if (src) out.push(`<p>${esc(L(lang, 'Fájl', 'File'))}: <a href="${hrefOf(src)}">${esc(src)}</a></p>`)
    for (const p of partsBy.get(e.item_id) || []) {
      if (p.kind === 'text') {
        out.push(`<div class="txt">${esc(p.text)}</div>`)
      } else if (p.asset_path) {
        const at = placed.get(`${e.item_id}|${p.asset_path}`)
        if (at) out.push(`<figure><img src="${hrefOf(at)}" alt="${esc(p.caption || basename(p.asset_path))}">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}</figure>`)
      }
    }
    if (!src && !(partsBy.get(e.item_id) || []).length) {
      out.push(`<p class="muted">${esc(L(lang, 'Ebben a munkadarabban még nincs tartalom.', 'This work item has no content yet.'))}</p>`)
    }
  })

  const decisions = listDecisions(plan.project.id)
  out.push(`<h2>${esc(L(lang, 'Döntések', 'Decisions'))}</h2>`)
  if (!decisions.length) {
    out.push(`<p class="muted">${esc(L(lang, 'A projektben nincs rögzített döntés.', 'No decisions were recorded in this project.'))}</p>`)
  } else {
    out.push('<ul>' + decisions.map((d) => `<li>${esc(d.text)}</li>`).join('') + '</ul>')
  }
  out.push('</body></html>')
  return out.join('\n')
}

export type BuildHandoffResult =
  | { ok: true; zip: Buffer; filename: string; plan: HandoffPlan }
  | { ok: false; code: 'project_not_found' | 'handoff_no_items' | 'handoff_nothing_done' | 'handoff_too_large'; plan?: HandoffPlan }

/** A kesz csomag, a memoriaban. `now` a teszt kedveert injektalhato. */
export function buildHandoffZip(projectId: string, scope: HandoffScope, lang: Lang, now: Date = new Date()): BuildHandoffResult {
  const plan = planHandoff(projectId, scope)
  if (!plan) return { ok: false, code: 'project_not_found' }
  if (!plan.all_count) return { ok: false, code: 'handoff_no_items', plan }
  if (!plan.items.length) return { ok: false, code: 'handoff_nothing_done', plan }
  if (plan.too_large) return { ok: false, code: 'handoff_too_large', plan }

  const root = safeName(plan.project.name, 'projekt')
  const entries: ZipEntry[] = []
  const placed = new Map<string, string>()
  const partsBy = new Map<string, WorkItemPartRow[]>()
  let late = 0

  const add = (e: HandoffEntry, f: HandoffFile | null, used: Set<string>) => {
    if (!f || f.problem) return
    const key = `${e.item_id}|${f.rel}`
    if (placed.has(key)) return
    const abs = resolveLifePath(f.rel)
    let data: Buffer
    try { data = readFileSync(abs as string) } catch {
      // A terv ota eltunt: ugyanugy kimondjuk, mint a tobbi hianyt.
      f.problem = 'missing'
      late++
      plan.files--
      return
    }
    const name = uniqueIn(used, f.name)
    const at = `${e.folder}/${name}`
    placed.set(key, at)
    entries.push({ name: `${root}/${at}`, data })
  }

  for (const e of plan.items) {
    partsBy.set(e.item_id, listWorkItemParts(e.item_id))
    const used = new Set<string>()
    add(e, e.source, used)
    for (const img of e.images) add(e, img, used)
  }
  if (late) plan.problems += late

  const indexName = L(lang, 'Tartalom.html', 'Contents.html')
  entries.unshift({ name: `${root}/${indexName}`, data: contentsHtml(plan, lang, now, placed, partsBy) })
  const zip = buildZip(entries, now)
  const filename = `${root}-${L(lang, 'atadas', 'handoff')}-${localDate(now)}.zip`
  return { ok: true, zip, filename, plan }
}
