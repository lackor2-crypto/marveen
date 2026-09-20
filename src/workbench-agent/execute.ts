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
import { getProject } from '../projects.js'
import { projectContext } from '../project-context.js'
import { projectFileTarget } from '../project-files.js'
import { recentFiles } from '../project-overview.js'
import { createWorkItem, getWorkItem, listWorkItems, listWorkItemVersions, isWorkItemStatus, type WorkItemRow } from '../workbench.js'
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
      const rel = asString(input.path)
      if (!rel) return { ok: false, code: 'bad_input', detail: 'path is required' }
      // Az utolso szegmens a fajlnev, a tobbi az almappa -- a mappa-resz a
      // meglevo, projektmappan beluli ellenorzesen megy at.
      const parts = rel.split('/').filter(Boolean)
      const fileName = parts.pop() || ''
      if (!fileName || fileName === '.' || fileName === '..') return { ok: false, code: 'bad_input', detail: 'path does not name a file' }
      const target = projectFileTarget(project, parts.join('/'))
      if (!target.ok) return { ok: false, code: target.code, detail: folderStateDetail(target.code) }
      const abs = join(target.dirAbs, fileName)
      // A join utan is ellenorizzuk: egy `..`-t tartalmazo fajlnev nem vihet ki.
      if (!abs.startsWith(target.dirAbs)) return { ok: false, code: 'bad_input', detail: 'path leads outside the project folder' }
      let size = 0
      try {
        const st = statSync(abs)
        if (st.isDirectory()) return { ok: false, code: 'not_a_file', detail: 'this is a folder, not a file' }
        size = st.size
      } catch (e) {
        // SOSE talalgatjuk az okot: a tenyleges hibauzenet megy tovabb.
        return { ok: false, code: 'not_found', detail: e instanceof Error ? e.message : String(e) }
      }
      let text: string
      try {
        text = readFileSync(abs, 'utf-8')
      } catch (e) {
        return { ok: false, code: 'unreadable', detail: e instanceof Error ? e.message : String(e) }
      }
      const truncated = text.length > FILE_READ_MAX_CHARS
      return { ok: true, data: { path: rel, size, truncated, text: truncated ? text.slice(0, FILE_READ_MAX_CHARS) : text } }
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

    default:
      return { ok: false, code: 'tool_unknown', detail: `there is no tool named ${name}` }
  }
}

/** A projekt munkadarabjai -- a kontextus-epito hasznalja (nem tool). */
export function workItemsOf(projectId: string): WorkItemRow[] {
  return listWorkItems(projectId)
}
