/**
 * A TOOLOK VEGREHAJTASA (kanban #336, 2. fazis, spec 5/10-11. lepes).
 *
 * A `tools.ts` megmondja, MI letezik es SZABAD-E; ez a modul csinalja meg.
 * Ket szabaly all minden sor folott:
 *
 *   1. A PROJEKT MAPPAJAN KIVULRE NEM LATUNK. A `file.read` a meglevo
 *      `projectFileTarget()`-en megy at, ami a Raktaron es a projektmappan
 *      kivuli utat elutasitja -- tehat egy kitalalt `../../etc/passwd` nem a
 *      mi ellenorzesunkon mulik, hanem azon, amit a Projektek modul mar tud.
 *   2. A NULLA KET DOLGOT JELENTHET. Minden eredmeny megmondja, hogy "nincs
 *      ilyen" vagy "nem latok oda" -- a tool SOSE ad vissza ures listat
 *      magyarazat nelkul.
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { getTool } from './tools.js'
import { join, sep } from 'node:path'
import { getProject, type ProjectRow } from '../projects.js'
import { projectContext } from '../project-context.js'
import { projectFileTarget, writeProjectFile, safeFileName, freeFileName } from '../project-files.js'
import { recentFiles, buildProjectOverview } from '../project-overview.js'
import { moveLife, renameLife, trashLife } from '../life-explorer.js'
import { fileKind } from '../file-kind.js'
import { convertOfficeToPdf, isOfficeConvertible } from '../office-convert.js'
import { listWorkItemAssetsSynced, renameWorkItemFolder, listSharedFiles, linkSharedAsset } from '../workbench-assets.js'
import {
  createWorkItem, getWorkItem, listWorkItems, listWorkItemVersions, isWorkItemStatus,
  listWorkItemParts, addWorkItemPart, type WorkItemRow,
  createWorkItemVersion, restoreWorkItemVersion, listWorkItemVersionsView,
} from '../workbench.js'
import { applyCanvasOps, canvasSummary } from '../workbench-graphic.js'
import { readCanvas, saveCanvas } from '../workbench-canvas-store.js'
import { createCardWithRules } from '../kanban-create.js'
import { getDb } from '../db.js'
import { ensureWorkbenchTables } from '../workbench.js'
import { MAIN_AGENT_ID } from '../config.js'
import { ideaCreate, ideaList, kanbanComment, kanbanRelate, researchSave, decisionList, decisionRecord, todoAdd } from './project-tools.js'
import { webSearch } from './web-search.js'
import { createFromTemplate, WORKBENCH_TEMPLATES } from '../workbench-templates.js'
import { createVariant, variantInfo, variantsSummary, translateSection, setBackTranslation, listGlossary, addGlossaryTerm, removeGlossaryTerm, backchecks } from '../workbench-doclang.js'
import {
  documentOutline, addSection, updateSection, removeSection, addBlock, updateBlock, removeBlock, addClaim, removeClaim, proposeRewrite,
  documentCheck, recheckPendingSources,
} from '../workbench-docmodel.js'
import { finalizationState } from '../workbench-docfinal.js'
import { addAnnex, annexCheck, docSettings, listAnnexes, removeAnnex, setDocSettings, updateAnnex } from '../workbench-docannex.js'
import { consistencyIssues } from '../workbench-doccheck.js'
import { itemDeadlines } from '../workbench-deadlines.js'
import { sourceWorldFor } from '../workbench-docmodel-world.js'
import { documentOverview, documentPagesText, verifyQuote, makeSearchableCopy, searchableName, searchableCopyAvailable } from '../workbench-docread.js'

/** Egy fajlbol ennyit adunk at a modellnek. A kontextus meretkorlatos (spec 16). */
export const FILE_READ_MAX_CHARS = 8000
/**
 * Egy tool-eredmeny ennyi karakterig jut el a modellhez (JSON-kent, lasd
 * `toolResultForModel`). A file.read oldala ENNEL kisebb kell legyen, kulonben
 * a modell az oldal veget nem latja (#432, merve 2026-09-28: 8000 karakteres
 * oldal, 6000-es vagas -> a 6-8., 16-20. es 33. fejezet kimaradt).
 */
export const TOOL_RESULT_MAX_CHARS = 12_000
/** A file.read oldal szovegenek JSON-kodolt hossza legfeljebb ennyi; a
 *  maradek (ut, meret, eltolas) boven befer a TOOL_RESULT_MAX_CHARS ala. */
export const FILE_READ_MAX_JSON_CHARS = 10_000
/** Ennyi fajlt sorolunk fel. */
export const LIST_FILES_MAX = 60

/** Egy surrogate-par elso fele nem maradhat a vegen, kulonben a byte-hossz
 *  (es vele a nextOffset) elcsuszna. */
function dropLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1)
  return s.length && last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/**
 * A file.read oldal addig rovidul, amig JSON-kodolva is belefer a
 * FILE_READ_MAX_JSON_CHARS-ba. Sok idezojel, sortores vagy vezerlo karakter
 * eseten a kodolt alak joval hosszabb a nyers szovegnel -- a modell a KODOLT
 * alakot kapja, tehat annak kell befernie.
 */
export function fitFilePage(text: string): string {
  let page = dropLoneHighSurrogate(text)
  for (;;) {
    const over = JSON.stringify(page).length - FILE_READ_MAX_JSON_CHARS
    if (over <= 0 || !page.length) return page
    // Minden karakter legalabb egy kodolt karakter: `over` levagasa biztosan
    // halad, es par korben a keret ala er.
    page = dropLoneHighSurrogate(page.slice(0, Math.max(0, page.length - over)))
  }
}

/**
 * Egy sikeres tool-eredmeny a modellnek. Ha a keretnel hosszabb, NEM vagjuk
 * nemán: a modell megtudja, hogy a vege hianyzik (kulonben azt hinne, mindent
 * latott, es a hianyzo reszt kitalalna).
 */
export function toolResultForModel(data: unknown): string {
  const s = JSON.stringify(data) ?? 'null'
  if (s.length <= TOOL_RESULT_MAX_CHARS) return s
  return `${s.slice(0, TOOL_RESULT_MAX_CHARS)}\n[CUT: only the first ${TOOL_RESULT_MAX_CHARS} of ${s.length} characters of this result are shown above. The rest was NOT shown to you -- do not claim to know it.]`
}

export interface ToolContext {
  projectId: string
  workItemId: string | null
  lang: 'hu' | 'en'
  /** Ki kerte a dashboardon (a kanban-komment szerzoje). Nelkule a fo agens. */
  actor?: string | null
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; detail: string }

function asString(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

/** Szam-input laza olvasasa (a modell stringkent is kuldheti). Nem-szamra 0. */
function asNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** A mappa-allapot kodja emberi mondatta -- "nem latok oda" vs "nincs semmi". */
function folderStateDetail(state: string): string {
  switch (state) {
    case 'no_depot': return 'the Depot (file storage) is not set up on this machine'
    case 'no_folder': return 'this project has no folder yet'
    case 'missing': return 'the project folder was not found (it may have been renamed or moved)'
    case 'unreachable': return 'the project folder cannot be reached right now'
    default: return state
  }
}


/**
 * EGY hely, ahol egy projekten beluli fajl-ut feloldodik.
 *
 * Eddig a `file.read` es a `workItem.addPart` kulon-kulon csinalta ugyanezt a
 * hat sort; a 6. fazis hat tovabbi fajl-toolt hoz, es hat masolat garantaltan
 * szetcsuszna. A hatar-ellenorzes tovabbra is a MEGLEVO `projectFileTarget()`,
 * ami a Raktaron es a projektmappan kivuli utat elutasitja.
 */
type FileRef =
  | { ok: true; dirAbs: string; dirRel: string; name: string; abs: string; rel: string }
  | { ok: false; code: string; detail: string }

function projectFileRef(project: ProjectRow, raw: unknown): FileRef {
  const rel = asString(raw)
  if (!rel) return { ok: false, code: 'bad_input', detail: 'path is required' }
  const segments = rel.split('/').filter(Boolean)
  const name = segments.pop() || ''
  if (!name || name === '.' || name === '..') return { ok: false, code: 'bad_input', detail: 'path does not name a file' }
  const target = projectFileTarget(project, segments.join('/'))
  if (!target.ok) return { ok: false, code: target.code, detail: folderStateDetail(target.code) }
  const abs = join(target.dirAbs, name)
  // A join utan is ellenorizzuk: egy `..`-t tartalmazo fajlnev nem vihet ki.
  if (!abs.startsWith(target.dirAbs)) return { ok: false, code: 'bad_input', detail: 'path leads outside the project folder' }
  // #406 bugkereses 1.: a mappat a projectFileTarget feloldja, a fajlnevet
  // nem -- egy projektbeli jelkapcsolat (`titok.txt -> ~/.ssh/...`) a
  // statSync/readFileSync-en at KIFELE vezetett. A link celja a projekt
  // mappajan belul kell maradjon; ha nem (vagy nem tudjuk feloldani), elutasitjuk.
  if (isEscapingLink(project, abs)) {
    return { ok: false, code: 'bad_input', detail: 'this is a link that points outside the project folder; the workbench does not follow it' }
  }
  return { ok: true, dirAbs: target.dirAbs, dirRel: target.dirRel, name, abs, rel: `${target.dirRel}/${name}` }
}

function isEscapingLink(project: ProjectRow, abs: string): boolean {
  let isLink = false
  try { isLink = lstatSync(abs).isSymbolicLink() } catch { return false }
  if (!isLink) return false
  const root = projectFileTarget(project, '')
  if (!root.ok) return true
  try {
    const base = realpathSync(root.dirAbs)
    const real = realpathSync(abs)
    return real !== base && !real.startsWith(base + sep)
  } catch {
    // Torott link, vagy nem tudjuk megnezni, hova mutat: inkabb nem kovetjuk.
    return true
  }
}

/** Letezik-e, es fajl-e. A hibauzenetet SOSE talaljuk ki: az eredeti megy tovabb. */
function mustBeFile(abs: string): { ok: true; size: number } | { ok: false; code: string; detail: string } {
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return { ok: false, code: 'not_a_file', detail: 'this is a folder, not a file' }
    return { ok: true, size: st.size }
  } catch (e) {
    return { ok: false, code: 'not_found', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** IDOT IGENYLO eszkozok (7. fazis). A tobbseg azonnal valaszol, es marad a
 *  szinkron `executeTool`; egy dokumentum PDF-fe alakitasa viszont masodpercek,
 *  es egy kulso folyamat futasa -- azt nem lehet a szal blokkolasaval megoldani.
 *
 *  Ezert EGY belepesi pont van a hivoknak: `runTool`. Az azonnali eszkozoket
 *  valtozatlanul a `executeTool` vegzi (nincs ketszer megirva semmi), a lassukat
 *  pedig ez a fuggveny -- igy a hivonak nem kell tudnia, melyik melyik. */
export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (name !== 'web.search' && name !== 'document.toPdf') return executeTool(name, input, ctx)

  // #406 bugkereses 8.: a lassu eszkozok is UGYANAZON a kapun mennek at, mint
  // az executeTool -- kulonben egy uj async eszkoz csendben kikerulne.
  const project = getProject(ctx.projectId)
  if (!project) return { ok: false, code: 'project_not_found', detail: 'the project was not found (it may have been deleted)' }
  const archived = archivedGate(name, project)
  if (archived) return archived
  if (name === 'web.search') return webSearch(input, ctx.lang)

  const ref = projectFileRef(project, input.path)
  if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
  const st = mustBeFile(ref.abs)
  if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
  if (!isOfficeConvertible(ref.name)) {
    return { ok: false, code: 'unsupported', detail: `${ref.name} is not an office document, so no PDF can be made from it` }
  }
  const out = await convertOfficeToPdf(ref.abs)
  if (!out.ok) {
    // A HIBA OKAT az atalakito mondja meg (nincs telepitve / nem tudtam
    // megkerdezni / idotullepes / a sajat hibauzenete). Nem talalgatunk, es a
    // "nem tudtam megkerdezni" SOSE valik "nincs"-cse.
    // A `detail` sosem maradhat ures: ha az atalakito nem mondott tobbet, akkor
    // azt mondjuk el, AMIT TUDUNK -- es nem talalunk ki ehelyett okot.
    const fallback = out.code === 'not_installed'
      ? 'LibreOffice is not installed on this machine, so office documents cannot be turned into PDF here'
      : out.code === 'no_output'
        ? 'the converter ran but produced no PDF (a damaged or password-protected document does this)'
        : 'the converter gave no further information'
    return { ok: false, code: out.code, detail: out.detail || fallback }
  }
  return {
    ok: true,
    data: {
      path: ref.rel, ready: true, cached: out.cached,
      note: out.cached
        ? 'the PDF preview was already made earlier, it is ready'
        : 'the PDF preview has been made; the original document was not changed',
    },
  }
}

/** Az archivalt projekt CSAK OLVASHATO: minden jogosultsag-koteles eszkoz
 *  (van autonomia-kategoriaja) elutasitva. Egy helyen, hogy a runTool es az
 *  executeTool ne terhessen el. */
function archivedGate(name: string, project: ProjectRow): ToolResult | null {
  const def = getTool(name)
  if (def && def.autonomyCategory !== null && project.archived_at != null) {
    return { ok: false, code: 'project_archived', detail: 'the project is archived, so it is read-only; the owner can restore it on the Projects page first' }
  }
  return null
}

export function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const project = getProject(ctx.projectId)
  if (!project) return { ok: false, code: 'project_not_found', detail: 'the project was not found (it may have been deleted)' }
  // Az archivalt projekt CSAK OLVASHATO -- a felulet is igy mutatja, es a
  // REST-utak is elutasitjak. Az ugynok iro toolja eddig ezt megkerulte.
  const archived = archivedGate(name, project)
  if (archived) return archived

  switch (name) {
    case 'project.get':
      return {
        ok: true,
        data: {
          id: project.id, name: project.name, description: project.description,
          client: project.client, status: project.status, archived: project.archived_at != null,
          hasFolder: !!project.folder_path,
        },
      }

    case 'project.getContext': {
      const c = projectContext(project.id, ctx.lang)
      if (!c) return { ok: false, code: 'project_not_found', detail: 'the project was not found' }
      return { ok: true, data: { text: c.text } }
    }

    case 'project.listFiles': {
      const r = recentFiles(project, LIST_FILES_MAX)
      if (r.state !== 'ok') return { ok: false, code: r.state, detail: folderStateDetail(r.state) }
      return {
        ok: true,
        data: {
          count: r.files.length,
          // Ures lista != hiba: kimondjuk, hogy a mappa LATSZIK es ures.
          note: r.files.length ? '' : 'the project folder is reachable and contains no files',
          files: r.files.map((f) => ({ path: f.rel, name: f.name })),
        },
      }
    }

    case 'document.pages':
    case 'document.read': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      const retry = input.retry === true || input.retry === 'true'
      const r = name === 'document.pages'
        ? documentOverview(ref.abs, ref.name, { retry })
        : documentPagesText(ref.abs, ref.name, asNumber(input.from) || 1, asNumber(input.to) || asNumber(input.from) || 1, { retry })
      if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
      return { ok: true, data: { path: asString(input.path), ...r.data } }
    }
    case 'source.verifyQuote': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      const r = verifyQuote(ref.abs, ref.name, asNumber(input.page), asString(input.quote))
      if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
      return { ok: true, data: { path: asString(input.path), ...r.data } }
    }
    case 'document.makeSearchable': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      if (!/\.pdf$/i.test(ref.name)) return { ok: false, code: 'bad_input', detail: 'only a PDF can get a searchable copy' }
      if (!searchableCopyAvailable()) return { ok: false, code: 'not_installed', detail: 'OCRmyPDF (ocrmypdf) is not installed on this machine; tell the owner exactly this' }
      const destName = freeFileName(ref.dirAbs, searchableName(ref.name, ctx.lang === 'en' ? 'en' : 'hu'))
      makeSearchableCopy(ref.abs, join(ref.dirAbs, destName)).catch(() => undefined)
      const relDir = asString(input.path).split('/').slice(0, -1).join('/')
      return {
        ok: true,
        data: {
          started: true, will_create: relDir ? `${relDir}/${destName}` : destName,
          note: 'it runs in the background; the copy appears in the same folder when ready (list the materials or the folder to see it)',
        },
      }
    }
    case 'doc.outline': case 'doc.addSection': case 'doc.updateSection': case 'doc.removeSection':
    case 'doc.addBlock': case 'doc.updateBlock': case 'doc.removeBlock': case 'doc.addClaim': case 'doc.removeClaim':
    case 'doc.proposeRewrite': case 'doc.check': case 'doc.annexes': case 'doc.addAnnex': case 'doc.updateAnnex': case 'doc.removeAnnex': case 'doc.annexSettings':
    case 'doc.deadlines': case 'doc.variants': case 'doc.createVariant': case 'doc.translateSection': case 'doc.backTranslate':
    case 'doc.glossary': case 'doc.addTerm': case 'doc.removeTerm': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required (open a work item first)' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const world = sourceWorldFor(project, item.id)
      const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v))
      const res = ((): { ok: true; data: unknown } | { ok: false; code: string; detail: string } => {
        switch (name) {
          case 'doc.outline': recheckPendingSources(item.id, world); return { ok: true, data: documentOutline(item.id) }
          case 'doc.deadlines': {
            const list = itemDeadlines(item.id, listWorkItemAssetsSynced(item.id))
            return {
              ok: true,
              data: {
                deadlines: list.map((d) => ({
                  kind: d.kind, topic: d.topic, date: d.date, time: d.time, counts_from: d.relative, file: d.path, page: d.page, quote: d.quote,
                  hard_to_read_page: d.low, added_as_todo: d.todo ? d.todo.due_date : null, not_relevant_by_owner: d.dismissed,
                })),
                note: 'Found by rules in the documents already read (materials of this work item). Say them with their source (file, page). A deadline that counts from delivery (counts_from) is NOT computed by you: ask the owner for the delivery date; Marveen proposes the day and the owner approves it with a click in the "Határidők és időpontok" box, which also makes the to-do (and from there the calendar entry). If a page is hard to read, tell the owner to check it in the document.',
              },
            }
          }
          case 'doc.variants': {
            const v = variantInfo(item.id)
            if (!v) return { ok: true, data: { is_language_version: false, language_versions: variantsSummary(item.id), note: 'This is an original. Make a language version with doc.createVariant {lang}.' } }
            const src = documentOutline(v.source_item_id)
            return {
              ok: true,
              data: {
                is_language_version: true, lang: v.lang, original: { id: v.source_item_id, title: v.source_title },
                sections: v.sections, original_sections_not_here_yet: v.new_in_source,
                original_outline: src.sections.map((s) => ({ id: s.id, title: s.title, status: s.status, blocks: s.blocks.map((b) => ({ kind: b.kind, text: b.text, claims: b.claims.map((c) => ({ id: c.id, text: c.text, strength: c.strength })) })) })),
                glossary: listGlossary(project.id, v.lang).map((g) => ({ id: g.id, term: g.term, translation: g.translation, note: g.note })),
                back_translations: backchecks(item.id).map((b) => ({ section: b.section_id, stale: b.stale })),
              },
            }
          }
          case 'doc.createVariant': {
            const r = createVariant(item, input.lang, 'workbench-agent')
            return r.ok ? { ok: true, data: { item_id: r.item.id, title: r.item.title, existing: r.existing, note: 'Now translate it section by section: doc.variants {id: item_id} shows the original outline to translate from, then doc.translateSection {id: item_id, source_section, title, blocks} for each section. Tell the owner the language version is a separate work item they can open.' } } : { ok: false, code: 'bad_input', detail: r.detail }
          }
          case 'doc.translateSection': { const r = translateSection(item.id, { source_section: input.source_section, title: input.title, blocks: input.blocks }, 'workbench-agent'); return r.ok ? { ok: true, data: r.result } : r }
          case 'doc.backTranslate': { const r = setBackTranslation(item.id, asString(input.section), input.text, 'workbench-agent'); return r.ok ? { ok: true, data: r.backcheck } : r }
          case 'doc.glossary': return { ok: true, data: { glossary: listGlossary(project.id, asString(input.lang).toLowerCase() || undefined) } }
          case 'doc.addTerm': { const r = addGlossaryTerm(project.id, { term: input.term, translation: input.translation, lang: input.lang, note: input.note }, 'workbench-agent'); return r.ok ? { ok: true, data: r.term } : r }
          case 'doc.removeTerm': { const r = removeGlossaryTerm(project.id, asString(input.term_id)); return r.ok ? { ok: true, data: r } : r }
          case 'doc.check': {
            recheckPendingSources(item.id, world)
            const fin = finalizationState(item)
            return {
              ok: true,
              data: {
                ...documentCheck(item.id, world.resolveFile),
                consistency: consistencyIssues(item.id).map((i) => ({ kind: i.kind, values: i.values, section: i.where, marked_intentional_by_owner: i.acked })),
                reviewed_by_owner: fin.reviewed,
                final: fin.final ? { label: fin.final.label, version_no: fin.final.version_no, file: fin.final.pdf_path, stale: fin.final.stale } : null,
                pdf: 'The owner makes the draft PDF (watermarked, any time) and the final PDF (only after this check passes, they opened and reviewed it and ticked that they take responsibility) with the buttons of the Vázlat box. You can not finalize.',
              },
            }
          }
          case 'doc.annexes': return { ok: true, data: { annexes: listAnnexes(item.id, world.resolveFile), settings: docSettings(item.id), check: annexCheck(item.id, world.resolveFile) } }
          case 'doc.addAnnex': { const r = addAnnex(item.id, { path: input.path, title: input.title, position: input.position }, world.resolveFile, 'workbench-agent'); return r.ok ? { ok: true, data: r } : r }
          case 'doc.updateAnnex': { const r = updateAnnex(item.id, asString(input.annex), { title: input.title, position: input.position }); return r.ok ? { ok: true, data: r } : r }
          case 'doc.removeAnnex': { const r = removeAnnex(item.id, asString(input.annex)); return r.ok ? { ok: true, data: r } : r }
          case 'doc.annexSettings': { const r = setDocSettings(item.id, { annex_scheme: input.scheme, annex_prefix: input.prefix, annex_mode: input.mode }); return r.ok ? { ok: true, data: r } : r }
          case 'doc.addSection': { const r = addSection(item.id, input.title, { position: num(input.position), status: input.status }); return r.ok ? { ok: true, data: r.section } : r }
          case 'doc.updateSection': { const r = updateSection(item.id, asString(input.section), { title: input.title, status: input.status, position: input.position }); return r.ok ? { ok: true, data: r.section } : r }
          case 'doc.removeSection': { const r = removeSection(item.id, asString(input.section)); return r.ok ? { ok: true, data: r } : r }
          case 'doc.addBlock': { const r = addBlock(item.id, asString(input.section), { kind: input.kind, text: input.text, position: input.position, author: 'agent' }); return r.ok ? { ok: true, data: r.block } : r }
          case 'doc.updateBlock': { const r = updateBlock(item.id, asString(input.block), { text: input.text, kind: input.kind, author: 'agent' }); return r.ok ? { ok: true, data: r } : r }
          case 'doc.proposeRewrite': { const r = proposeRewrite(item.id, asString(input.block), { text: input.text, style: input.style }, 'workbench-agent'); return r.ok ? { ok: true, data: { ...r.rewrite, note: r.rewrite.would_drop.length ? 'These sourced claims would drop out on accept, because their text is not in the proposal verbatim. Keep them word for word and propose again, unless dropping them is intended.' : 'The owner sees the proposal in the outline and accepts or dismisses it.' } } : r }
          case 'doc.removeBlock': { const r = removeBlock(item.id, asString(input.block)); return r.ok ? { ok: true, data: r } : r }
          case 'doc.addClaim': { const r = addClaim(item.id, asString(input.block), input.text, input.sources, world, 'workbench-agent'); return r.ok ? { ok: true, data: r.claim } : r }
          default: { const r = removeClaim(item.id, asString(input.claim)); return r.ok ? { ok: true, data: r } : r }
        }
      })()
      return res.ok ? { ok: true, data: res.data } : { ok: false, code: res.code, detail: res.detail }
    }
    case 'file.read': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      // Honnan olvassunk: a lapozashoz byte-eltolas. Enelkul egy 8000
      // karakternel hosszabb fajl tobbi resze SOHA nem volt elerheto (valos
      // eset: 29k karakteres MD, csak az 1-5. fejezet jott vissza, a 6.-tol
      // semmi). A blokk vege a `nextOffset`, azzal kell ujra hivni.
      const start = Math.max(0, Math.floor(asNumber(input.offset)))
      // Csak a szukseges resz kerul memoriaba: egy tobb GB-os fajl egesze eddig
      // sem olvasodott be, csak a blokk.
      let text: string
      try {
        const cap = FILE_READ_MAX_CHARS * 4 + 4
        const remaining = Math.max(0, st.size - start)
        const buf = Buffer.alloc(Math.min(cap, remaining))
        const fd = openSync(ref.abs, 'r')
        let n = 0
        try { n = readSync(fd, buf, 0, buf.length, start) } finally { closeSync(fd) }
        text = buf.subarray(0, n).toString('utf-8')
        // Ha a blokk nem er a fajl vegeig, az utolso karakter lehet elvagott
        // tobb-bajtos UTF-8; a csonkot levagjuk, hogy a kovetkezo lapozas ott
        // folytassa, ahol egy ep karakter kezdodik.
        const reachedEof = start + n >= st.size
        if (!reachedEof && text.endsWith('\uFFFD')) text = text.replace(/\uFFFD+$/, '')
      } catch (e) {
        // SOSE talalgatjuk az okot: a tenyleges hibauzenet megy tovabb.
        return { ok: false, code: 'unreadable', detail: e instanceof Error ? e.message : String(e) }
      }
      // Egy blokkban legfeljebb ennyi karakter. A vegen ne vagjunk kette egy
      // surrogate-part (emoji), kulonben a byte-hossz elcsuszna.
      const capped = fitFilePage(text.length > FILE_READ_MAX_CHARS ? text.slice(0, FILE_READ_MAX_CHARS) : text)
      // A tenylegesen atadott szoveg byte-hossza mondja meg, hol folytassuk.
      const nextOffset = start + Buffer.byteLength(capped, 'utf-8')
      const hasMore = nextOffset < st.size
      return {
        ok: true,
        data: {
          path: asString(input.path),
          size: st.size,
          offset: start,
          truncated: hasMore,
          // A modell ebbol tudja, hogy VAN meg, es honnan folytassa a file.read-et.
          nextOffset: hasMore ? nextOffset : null,
          text: capped,
        },
      }
    }

    case 'workItem.open': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      return { ok: true, data: item }
    }

    case 'workItem.listVersions': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const versions = listWorkItemVersions(item.id)
      return { ok: true, data: { count: versions.length, versions } }
    }

    case 'workItem.create': {
      const r = createWorkItem({
        project_id: project.id,
        title: input.title,
        type: input.type,
        created_by: 'workbench-agent',
      })
      if (!r.ok) return { ok: false, code: r.code, detail: `the work item was not created: ${r.code}` }
      return { ok: true, data: { item: r.item, version: r.version } }
    }

    case 'workItem.fromTemplate': {
      const r = createFromTemplate(project, input.template, { title: input.title, lang: ctx.lang, created_by: 'workbench-agent' })
      if (!r.ok) {
        const known = WORKBENCH_TEMPLATES.map((t) => t.id).join(', ')
        return { ok: false, code: r.code, detail: r.code === 'template_not_found' ? `no such template; use one of: ${known}` : `the work item was not created: ${r.detail ?? r.code}` }
      }
      return { ok: true, data: { item: r.item, version: r.version, parts: r.parts.map((p) => ({ id: p.id, text: p.text })) } }
    }

    case 'workItem.update': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const title = input.title === undefined ? null : asString(input.title)
      const status = input.status === undefined ? null : asString(input.status)
      if (title !== null && !title) return { ok: false, code: 'title_required', detail: 'the title cannot be empty' }
      if (status !== null && !isWorkItemStatus(status)) return { ok: false, code: 'bad_status', detail: 'unknown work item status' }
      if (title === null && status === null) return { ok: false, code: 'bad_input', detail: 'nothing to change' }
      ensureWorkbenchTables()
      const now = Math.floor(Date.now() / 1000)
      getDb().prepare(
        'UPDATE work_items SET title = COALESCE(?, title), status = COALESCE(?, status), updated_at = ? WHERE id = ?',
      ).run(title, status, now, item.id)
      // K-0.11 (#441): uj nev -> a munkadarab mappaja is atnevezodik (ha lehet;
      // ha nem, a valasz megmondja, miert maradt a regi neven).
      const folder = title !== null && title !== item.title ? renameWorkItemFolder(item, title) : null
      const updated = getWorkItem(item.id) as WorkItemRow
      return { ok: true, data: folder ? { ...updated, folder_rename: folder } : updated }
    }

    case 'workItem.listAssets': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const assets = listWorkItemAssetsSynced(item.id)
      return {
        ok: true,
        data: {
          folder: item.folder ?? null,
          count: assets.length,
          note: assets.length ? '' : 'this work item exists and has no attached materials yet',
          assets: assets.map((a) => ({
            path: a.project_path || a.path, name: a.name, support: a.support,
            bytes: a.bytes, present: a.present, shared: a.shared,
          })),
        },
      }
    }
    case 'project.listShared': {
      const r = listSharedFiles(project)
      return {
        ok: true,
        data: {
          folder: r.folder,
          count: r.files.length,
          note: r.folder ? (r.files.length ? '' : 'the shared folder exists but it is empty') : 'this project has no shared materials yet',
          files: r.files.map((f) => ({ path: f.project_path || f.path, name: f.name, support: f.support, bytes: f.bytes, used_by: f.used_by })),
        },
      }
    }
    case 'workItem.linkShared': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const r = linkSharedAsset(item, input.path, 'workbench-agent')
      if (!r.ok) {
        const detail = r.code === 'not_shared' ? 'this file is not in the shared materials of the project (see project.listShared)'
          : r.code === 'no_shared_folder' ? 'this project has no shared materials yet'
          : r.code
        return { ok: false, code: r.code === 'not_found' ? 'not_found' : 'bad_input', detail }
      }
      return { ok: true, data: { linked: r.asset.project_path || r.asset.path, already: r.already } }
    }
    case 'workItem.listParts': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const parts = listWorkItemParts(item.id)
      return {
        ok: true,
        data: {
          count: parts.length,
          // Ures lista != hiba: kimondjuk, hogy a munkadarab LATSZIK es ures.
          note: parts.length ? '' : 'this work item exists and has no parts yet',
          parts: parts.map((p) => ({
            id: p.id, position: p.position, kind: p.kind,
            text: p.text, path: p.asset_path, caption: p.caption,
          })),
        },
      }
    }

    case 'workItem.addPart': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const kind = asString(input.kind) || (asString(input.path) ? 'image' : 'text')
      let assetPath = ''
      if (kind === 'image') {
        // A kep a PROJEKT mappajabol jon -- a meglevo, projektmappan beluli
        // ellenorzesen at. Kitalalt ut nem kerulhet be a munkadarabba.
        if (!asString(input.path)) return { ok: false, code: 'bad_input', detail: 'path is required for an image part' }
        const ref = projectFileRef(project, input.path)
        if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
        const st = mustBeFile(ref.abs)
        if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
        assetPath = ref.rel
      }
      const r = addWorkItemPart({
        work_item_id: item.id,
        kind,
        text: input.text,
        asset_path: assetPath,
        caption: input.caption,
        created_by: 'workbench-agent',
      })
      if (!r.ok) return { ok: false, code: r.code, detail: `the part was not added: ${r.code}` }
      return { ok: true, data: { part: r.part, count: listWorkItemParts(item.id).length } }
    }

    case 'file.preview': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      const k = fileKind(ref.name)
      return {
        ok: true,
        data: {
          path: ref.rel, size: st.size, kind: k.kind, mime: k.mime, previewable: k.previewable,
          // A "nem" is valasz, es megmondja MIERT nem -- nem ures mezo.
          note: k.previewable ? '' : 'the browser cannot show this file type on its own; it can only be downloaded or converted',
        },
      }
    }

    case 'file.write': {
      const rel = asString(input.path)
      if (!rel) return { ok: false, code: 'bad_input', detail: 'path is required' }
      const segments = rel.split('/').filter(Boolean)
      const wanted = segments.pop() || ''
      if (!safeFileName(wanted)) return { ok: false, code: 'bad_name', detail: 'this file name cannot be used' }
      // A meglevo iro fuggveny: SOSE ir felul, foglalt nevnel `nev (2).ext`.
      const out = writeProjectFile(project, segments.join('/'), wanted, Buffer.from(String(input.text ?? ''), 'utf-8'))
      if (!out.ok) return { ok: false, code: out.code, detail: out.message || folderStateDetail(out.code) }
      return {
        ok: true,
        data: {
          path: out.rel, name: out.name, bytes: out.bytes, renamed: out.renamed,
          // A nev-valtast KI KELL MONDANI, kulonben a modell a kert nevrol beszelne tovabb.
          note: out.renamed ? `the name was taken, so the file was saved as ${out.name}` : '',
        },
      }
    }

    case 'file.copy': {
      const from = projectFileRef(project, input.path)
      if (!from.ok) return { ok: false, code: from.code, detail: from.detail }
      const st = mustBeFile(from.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      const toRel = asString(input.to)
      if (!toRel) return { ok: false, code: 'bad_input', detail: 'to is required (the target file path)' }
      const toSegments = toRel.split('/').filter(Boolean)
      const toName = toSegments.pop() || ''
      if (!safeFileName(toName)) return { ok: false, code: 'bad_name', detail: 'this target file name cannot be used' }
      let bytes: Buffer
      try {
        bytes = readFileSync(from.abs)
      } catch (e) {
        return { ok: false, code: 'unreadable', detail: e instanceof Error ? e.message : String(e) }
      }
      const out = writeProjectFile(project, toSegments.join('/'), toName, bytes)
      if (!out.ok) return { ok: false, code: out.code, detail: out.message || folderStateDetail(out.code) }
      return {
        ok: true,
        data: {
          from: from.rel, path: out.rel, name: out.name, bytes: out.bytes, renamed: out.renamed,
          note: out.renamed ? `the name was taken, so the copy was saved as ${out.name}` : '',
        },
      }
    }

    case 'file.move': {
      const from = projectFileRef(project, input.path)
      if (!from.ok) return { ok: false, code: from.code, detail: from.detail }
      const st = mustBeFile(from.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      // A CEL is a projektmappan belul kell legyen -- ezt ugyanaz a hatar dönti el.
      const target = projectFileTarget(project, asString(input.to))
      if (!target.ok) return { ok: false, code: target.code, detail: folderStateDetail(target.code) }
      const r = moveLife(from.rel, target.dirRel, ctx.lang)
      if (!r.ok) return { ok: false, code: r.code || 'move_failed', detail: r.message }
      return { ok: true, data: { from: from.rel, path: r.rel, note: r.notice || '' } }
    }

    case 'file.rename': {
      const from = projectFileRef(project, input.path)
      if (!from.ok) return { ok: false, code: from.code, detail: from.detail }
      const st = mustBeFile(from.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      const newName = asString(input.name)
      if (!newName) return { ok: false, code: 'bad_input', detail: 'name is required' }
      if (!safeFileName(newName)) return { ok: false, code: 'bad_name', detail: 'this file name cannot be used' }
      const r = renameLife(from.rel, newName, ctx.lang)
      if (!r.ok) return { ok: false, code: r.code || 'rename_failed', detail: r.message }
      return { ok: true, data: { from: from.rel, path: r.rel, note: r.notice || '' } }
    }

    case 'file.delete': {
      const from = projectFileRef(project, input.path)
      if (!from.ok) return { ok: false, code: from.code, detail: from.detail }
      const st = mustBeFile(from.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      // NEM torles: a Raktar Kukajaba kerul, ahonnan a tulajdonos visszaveheti.
      const r = trashLife(from.rel, ctx.lang)
      if (!r.ok) return { ok: false, code: r.code || 'trash_failed', detail: r.message }
      return { ok: true, data: { from: from.rel, path: r.rel, trashed: true, note: 'the file was moved to the Trash, not erased' } }
    }

    case 'project.listWorkItems': {
      const items = listWorkItems(project.id)
      return {
        ok: true,
        data: {
          count: items.length,
          // Ures lista != hiba: a projekt LATSZIK es nincs benne munkadarab.
          note: items.length ? '' : 'this project exists and has no work items yet',
          items: items.map((i) => ({ id: i.id, title: i.title, type: i.type, status: i.status, version: i.current_version_id })),
        },
      }
    }

    case 'project.listKanban': {
      const overview = buildProjectOverview(project.id)
      if (!overview) return { ok: false, code: 'project_not_found', detail: 'the project was not found' }
      const cards = overview.nextSteps
      return {
        ok: true,
        data: {
          count: overview.nextStepsTotal,
          shown: cards.length,
          note: overview.nextStepsTotal ? '' : 'this project has no open kanban card',
          cards: cards.map((c) => ({ id: c.id, seq: c.seq, title: c.title, status: c.status, priority: c.priority })),
        },
      }
    }

    // GRAFIKA (9. fazis, spec 9): a rajz STRUKTURALT -- az objektumoknak stabil
    // ID-juk van, ezert az agent nevvel hivatkozhat rajuk, es nem kell ujra
    // felrajzolnia az egeszet egy apro modositas miatt.
    case 'canvas.get': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const r = readCanvas(item.id)
      // A "nem latok oda" NEM valik "ures rajz"-za: a hibakod es a rendszer
      // sajat uzenete megy vissza, hogy a modell ne talalgasson helyette.
      if (!r.ok) return { ok: false, code: r.code, detail: r.detail || r.code }
      return {
        ok: true,
        data: {
          canvas: r.doc, exists: r.exists, summary: canvasSummary(r.doc),
          note: r.exists ? '' : 'there is no drawing yet on this work item; this is an empty canvas to start from',
        },
      }
    }

    case 'canvas.edit': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const current = readCanvas(item.id)
      if (!current.ok) return { ok: false, code: current.code, detail: current.detail || current.code }
      const applied = applyCanvasOps(current.doc, input.ops)
      if (!applied.ok) return { ok: false, code: applied.code, detail: applied.detail }
      const saved = saveCanvas(item, applied.doc, { createdBy: 'workbench-agent', name: current.name })
      if (!saved.ok) return { ok: false, code: saved.code, detail: saved.detail || folderStateDetail(saved.code) }
      return {
        ok: true,
        data: {
          canvas: applied.doc, applied: applied.applied, summary: canvasSummary(applied.doc),
          path: saved.rel, version: saved.version.version_no,
          note: saved.renamed
            ? `saved as a new version; the file name was taken, so it was written as ${saved.name}`
            : 'saved as a new version; nothing was overwritten',
        },
      }
    }

    case 'workItem.createVersion': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const r = createWorkItemVersion(item.id, { created_by: 'workbench-agent' })
      if (!r.ok) return { ok: false, code: r.code, detail: `the version was not created: ${r.code}` }
      return { ok: true, data: { version: r.version, versions: listWorkItemVersionsView(item.id).length } }
    }

    case 'workItem.restoreVersion': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const versionId = asString(input.version)
      if (!versionId) return { ok: false, code: 'bad_input', detail: 'version is required' }
      const r = restoreWorkItemVersion(versionId, { created_by: 'workbench-agent', work_item_id: item.id })
      if (!r.ok) return { ok: false, code: r.code, detail: `the version was not restored: ${r.code}` }
      return {
        ok: true,
        data: {
          version: r.version,
          note: 'the restore wrote a NEW version; the earlier version and the later ones are all kept',
        },
      }
    }

    case 'workItem.compareVersions': {
      const id = asString(input.id) || ctx.workItemId || ''
      if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
      const item = getWorkItem(id)
      if (!item || item.project_id !== project.id) {
        return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
      }
      const known = listWorkItemVersionsView(item.id)
      const fromId = asString(input.from)
      const toId = asString(input.to)
      if (!fromId || !toId) return { ok: false, code: 'bad_input', detail: 'from and to are required (two version ids)' }
      const fromV = known.find((v) => v.id === fromId)
      const toV = known.find((v) => v.id === toId)
      // KULON mondjuk meg, MELYIK nem talalhato -- a "nem talalom" onmagaban semmit nem er.
      if (!fromV) return { ok: false, code: 'version_not_found', detail: `no version ${fromId} on this work item` }
      if (!toV) return { ok: false, code: 'version_not_found', detail: `no version ${toId} on this work item` }
      const snapshot = (v: { id: string }) => listWorkItemParts(item.id, v.id === item.current_version_id ? null : v.id)
      const a = snapshot(fromV)
      const b = snapshot(toV)
      const sig = (p: { kind: string; text: string | null; asset_path: string | null; caption: string | null }) =>
        `${p.kind}|${p.text || ''}|${p.asset_path || ''}|${p.caption || ''}`
      // #406 bugkereses 9.: MULTISET-kulonbseg. Halmazkent egy [A, A] -> [A]
      // valtozas "semmi nem valtozott" lett; itt darabra szamolunk.
      const minus = <T extends Parameters<typeof sig>[0]>(from: T[], other: T[]): T[] => {
        const left = new Map<string, number>()
        for (const p of other) left.set(sig(p), (left.get(sig(p)) || 0) + 1)
        return from.filter((p) => {
          const k = sig(p)
          const n = left.get(k) || 0
          if (n > 0) { left.set(k, n - 1); return false }
          return true
        })
      }
      const added = minus(b, a)
      const removed = minus(a, b)
      return {
        ok: true,
        data: {
          from: { id: fromV.id, version_no: fromV.version_no, parts: a.length },
          to: { id: toV.id, version_no: toV.version_no, parts: b.length },
          added: added.map((p) => ({ kind: p.kind, text: p.text, path: p.asset_path, caption: p.caption })),
          removed: removed.map((p) => ({ kind: p.kind, text: p.text, path: p.asset_path, caption: p.caption })),
          // Ket azonos verzio nem hiba: kimondjuk, hogy NINCS kulonbseg.
          note: added.length || removed.length ? '' : 'the two versions hold exactly the same parts',
        },
      }
    }

    case 'kanban.create': {
      const title = asString(input.title)
      if (!title) return { ok: false, code: 'bad_input', detail: 'title is required' }
      // A KARTYA MINDIG EHHEZ A PROJEKTHEZ KOTODIK (Boss, 2026-09-21: "ha az
      // agenttol kanban kartyat kerunk egy projekt Munkapad-feluleten, a
      // kartyat MINDIG az ADOTT projekthez kell kotni"). Amit a modell a
      // `project` mezobe irna, azt szandekosan NEM vesszuk figyelembe.
      const out = createCardWithRules({
        title,
        description: asString(input.description) || undefined,
        priority: asString(input.priority) || undefined,
        status: 'planned',
        project: project.id,
        // #403: a modell altal adott cimke(k) -- id vagy nev. Ha nem ad, a
        // createCardWithRules a projekt alapertelmezett cimkejet veszi; ha
        // az sincs, label_error jon a valaszthato cimkek listajaval, es a
        // modell abbol valaszt. Beegetett cimke vagy "a leggyakoribb a
        // projektben" talalgatas NINCS: egy projektben vegyes cimkek allnak.
        labels: labelsInput(input.labels ?? input.label ?? input.tags),
        related: input.related,
        separate_project: input.separate_project,
      })
      if (!out.ok) {
        return {
          ok: false,
          code: out.code,
          detail: out.code === 'related_required'
            ? `${out.error} Candidates: ${out.similar.map((c) => `${c.id} (${c.title})`).join('; ')}`
            : out.error,
        }
      }
      return { ok: true, data: { id: out.id, project: project.id, projectName: project.name, labels: out.labels, linked: out.linked } }
    }

    // #404 H5: a projekt tobbi feluleve (Otletlada, Kutatas, meglevo kartyak).
    case 'idea.list': return ideaList(project)
    case 'idea.create': return ideaCreate(project, input)
    case 'research.save': return researchSave(project, input)
    case 'kanban.comment': return kanbanComment(project, input, ctx.actor || MAIN_AGENT_ID)
    case 'kanban.relate': return kanbanRelate(project, input)
    case 'decision.list': return decisionList(project)
    case 'decision.record': return decisionRecord(project, input)
    case 'workItem.addTodo': return todoAdd(project, input)

    default:
      return { ok: false, code: 'tool_unknown', detail: `there is no tool named ${name}` }
  }
}

/** A modell cimke-bemenete (lista, egyetlen szoveg, vagy vesszovel elvalasztott
 *  szoveg) -> tiszta lista. Ures -> undefined (a szerver dont a projekt-alapbol). */
export function labelsInput(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out = raw.map((x) => String(x ?? '').trim()).filter(Boolean)
  return out.length ? out : undefined
}

/** A projekt munkadarabjai -- a kontextus-epito hasznalja (nem tool). */
export function workItemsOf(projectId: string): WorkItemRow[] {
  return listWorkItems(projectId)
}
