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
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getProject, type ProjectRow } from '../projects.js'
import { projectContext } from '../project-context.js'
import { projectFileTarget, writeProjectFile, safeFileName } from '../project-files.js'
import { recentFiles, buildProjectOverview } from '../project-overview.js'
import { moveLife, renameLife, trashLife } from '../life-explorer.js'
import { fileKind } from '../file-kind.js'
import { convertOfficeToPdf, isOfficeConvertible } from '../office-convert.js'
import {
  createWorkItem, getWorkItem, listWorkItems, listWorkItemVersions, isWorkItemStatus,
  listWorkItemParts, addWorkItemPart, type WorkItemRow,
  createWorkItemVersion, restoreWorkItemVersion, listWorkItemVersionsView,
} from '../workbench.js'
import { createCardWithRules } from '../kanban-create.js'
import { getDb } from '../db.js'
import { ensureWorkbenchTables } from '../workbench.js'

/** Egy fajlbol ennyit adunk at a modellnek. A kontextus meretkorlatos (spec 16). */
export const FILE_READ_MAX_CHARS = 8000
/** Ennyi fajlt sorolunk fel. */
export const LIST_FILES_MAX = 60

export interface ToolContext {
  projectId: string
  workItemId: string | null
  lang: 'hu' | 'en'
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; detail: string }

function asString(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
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
  return { ok: true, dirAbs: target.dirAbs, dirRel: target.dirRel, name, abs, rel: `${target.dirRel}/${name}` }
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
  if (name !== 'document.toPdf') return executeTool(name, input, ctx)

  const project = getProject(ctx.projectId)
  if (!project) return { ok: false, code: 'project_not_found', detail: 'the project was not found (it may have been deleted)' }
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

export function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const project = getProject(ctx.projectId)
  if (!project) return { ok: false, code: 'project_not_found', detail: 'the project was not found (it may have been deleted)' }

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

    case 'file.read': {
      const ref = projectFileRef(project, input.path)
      if (!ref.ok) return { ok: false, code: ref.code, detail: ref.detail }
      const st = mustBeFile(ref.abs)
      if (!st.ok) return { ok: false, code: st.code, detail: st.detail }
      let text: string
      try {
        text = readFileSync(ref.abs, 'utf-8')
      } catch (e) {
        // SOSE talalgatjuk az okot: a tenyleges hibauzenet megy tovabb.
        return { ok: false, code: 'unreadable', detail: e instanceof Error ? e.message : String(e) }
      }
      const truncated = text.length > FILE_READ_MAX_CHARS
      return { ok: true, data: { path: asString(input.path), size: st.size, truncated, text: truncated ? text.slice(0, FILE_READ_MAX_CHARS) : text } }
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
      return { ok: true, data: getWorkItem(item.id) as WorkItemRow }
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
      const aSigs = a.map(sig)
      const bSigs = b.map(sig)
      const added = b.filter((_, i) => !aSigs.includes(bSigs[i]))
      const removed = a.filter((_, i) => !bSigs.includes(aSigs[i]))
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
        related: input.related,
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

    default:
      return { ok: false, code: 'tool_unknown', detail: `there is no tool named ${name}` }
  }
}

/** A projekt munkadarabjai -- a kontextus-epito hasznalja (nem tool). */
export function workItemsOf(projectId: string): WorkItemRow[] {
  return listWorkItems(projectId)
}
