// A debate report (debate-export.ts) saved as a document work item of the project (#597, phase 6).
//
// From there the document does what every document does: the PDF and Word export, the page view, the history. The
// document gets its own folder in the project's work items box, the same way a work item made from the intake does,
// and is made by the owner's hand (the debate only fills it).

import { readdirSync, rmdirSync } from 'node:fs'
import { getDb } from './db.js'
import { getProject, type ProjectRow } from './projects.js'
import { debateFolderFor, DEBATE_FOLDER_NAMES, DEBATE_REPORT_SUB_NAMES, DEBATE_FOLDER_OLD_NAMES, FINISHED_FOLDER_NAMES, FINISHED_FOLDER_OLD_NAMES, AGENT_REFS_FOLDER_NAMES, AGENT_REFS_FOLDER_OLD_NAMES, folderWasMade, noteFolderMade, projectFileTarget } from './project-files.js'
import { logger } from './logger.js'
import { createWorkItem, getWorkItem, setWorkItemDeleted, type WorkItemRow } from './workbench.js'
import { replacePage, BLOCK_TEXT_MAX } from './workbench-docmodel.js'
import { scheduleOutlineMirror } from './workbench-docmirror.js'
import { assignWorkItemFolder, ensureWorkItemFolder, findWorkItemsBox, makeWorkFolder, moveWorkItemToFolder } from './workbench-assets.js'
import { reportTitle, type DebateReport } from './debate-export.js'
import { listDebateOrigins } from './debate-run.js'

export type ReportDocResult =
  | { ok: true; item: WorkItemRow }
  | { ok: false; code: 'project_not_found' | 'project_archived' | 'create_failed' | 'page_failed'; detail?: string }

/** A paragraph longer than the block limit is cut at a line or sentence end, never in the middle of a word. */
export function splitLong(text: string, max: number = BLOCK_TEXT_MAX): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '))
    const at = cut > max / 2 ? cut + 1 : max
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

/** The folder every debate report goes into: inside the folder of the work item the debate was started from. */
export function reportFolderName(lang: string): string {
  return lang === 'en' ? DEBATE_FOLDER_NAMES.en : DEBATE_FOLDER_NAMES.hu
}

/** The first name of the folder (before #676): old reports sit in folders called so, and a work item folder that has one
 *  keeps it (no second folder next to it). */
function legacyReportFolderName(lang: string): string {
  return lang === 'en' ? 'Debate report' : 'Vitáztatás jelentés'
}

/** The name of the debate folder inside `parent`: the one that already exists there (either generation), else the current name. */
function reportFolderIn(project: ProjectRow, parent: string, lang: string): string {
  if (parent) {
    const have = debateFolderFor(project, parent, lang)
    if (have) return have.slice(parent.length + 1)
  }
  return reportFolderName(lang)
}

/** #699 (Boss TG 9746): the folder a report is filed into: the "jelentés" / "report" subfolder of the Debate folder.
 *  An existing one (either language) is reused; when the owner deleted it on purpose it is not made again and the report
 *  lands in the Debate folder itself (#681 rule). */
function reportSubFolder(project: ProjectRow, debateFolder: string, lang: string): string {
  const names = [DEBATE_REPORT_SUB_NAMES.hu, DEBATE_REPORT_SUB_NAMES.en]
  for (const n of names) if (projectFileTarget(project, `${debateFolder}/${n}`).ok) { noteFolderMade(project, `${debateFolder}/${n}`); return `${debateFolder}/${n}` }
  if (names.some((n) => folderWasMade(project, `${debateFolder}/${n}`))) return debateFolder
  // An old-name folder ("Vitáztatás jelentés" / "Debate report") already IS the report folder by its name: no "jelentés" inside it.
  if ((DEBATE_FOLDER_OLD_NAMES as readonly string[]).includes(debateFolder.split('/').pop() ?? '')) return debateFolder
  const sub = makeWorkFolder(project, debateFolder, lang === 'en' ? DEBATE_REPORT_SUB_NAMES.en : DEBATE_REPORT_SUB_NAMES.hu)
  if (!sub.ok) return debateFolder
  noteFolderMade(project, sub.folder)
  return sub.folder
}

export function createReportDocument(projectId: string, report: DebateReport, by: string | null, opts?: { originItem?: string | null; lang?: string }): ReportDocResult {
  const project = getProject(projectId)
  if (!project) return { ok: false, code: 'project_not_found' }
  if (project.archived_at != null) return { ok: false, code: 'project_archived' }
  const title = report.title.slice(0, 200)
  // Boss (TG 3623): the report never lands loose among the work items. It goes into a "Debate report" folder inside the
  // folder of the work item the debate was started from; a debate with no known origin gets one shared "Debate report"
  // folder of the box (never a folder of its own at the box level).
  const origin = opts?.originItem ? getWorkItem(opts.originItem) : null
  // An origin item whose folder is not made yet (it is made lazily, with the first file) gets it now: the report must
  // still land under that item, not in the shared folder of the box.
  let originFolder = ''
  if (origin && origin.project_id === project.id && origin.deleted_at == null) {
    const of = ensureWorkItemFolder(origin)
    if (of.ok) originFolder = of.folder
  }
  // #681 (Boss TG 9548): the debate folder is made once; when the owner deleted it the report lands in the item's own
  // folder (or the box) instead of the folder coming back.
  const lang = opts?.lang ?? 'hu'
  const box = originFolder ? '' : (findWorkItemsBox(project) ?? '')
  const parent = originFolder || box
  const known = [DEBATE_FOLDER_NAMES.hu, DEBATE_FOLDER_NAMES.en, ...DEBATE_FOLDER_OLD_NAMES].map((n) => `${parent}/${n}`)
  const gone = !!parent && known.every((r) => !projectFileTarget(project, r).ok) && known.some((r) => folderWasMade(project, r))
  let folder: string | null = null
  if (gone) folder = parent
  else {
    const mf = makeWorkFolder(project, originFolder, reportFolderIn(project, originFolder, lang))
    folder = mf.ok ? reportSubFolder(project, mf.folder, lang) : null
    if (mf.ok) noteFolderMade(project, mf.folder)
  }
  const made = createWorkItem({ project_id: project.id, type: 'document', title, container_folder: folder, created_by: by })
  if (!made.ok) return { ok: false, code: 'create_failed', detail: made.code }
  if (folder) assignWorkItemFolder(made.item.id, folder)
  const sections = report.sections.map(s => ({
    title: s.title.slice(0, 200),
    blocks: s.paragraphs.flatMap(p => splitLong(p)).map(text => ({ kind: 'paragraph', text })),
  })).filter(s => s.blocks.length)
  const page = replacePage(made.item.id, sections, [], 'owner')
  if (!page.ok) {
    // Not left behind half-made: the empty document goes to the trash.
    setWorkItemDeleted(made.item.id, true)
    return { ok: false, code: 'page_failed', detail: page.detail }
  }
  scheduleOutlineMirror(made.item.id)
  return { ok: true, item: getWorkItem(made.item.id) ?? made.item }
}

function itemsTitled(projectId: string, title: string, exceptId: string): string[] {
  const rows = getDb().prepare('SELECT id FROM work_items WHERE project_id = ? AND deleted_at IS NULL AND title = ? AND id != ?').all(projectId, title, exceptId) as { id: string }[]
  return rows.map(r => r.id)
}

/**
 * Boss TG 3636: a report saved BEFORE the folder fix (#1144) still sat in a folder of its own at the box level. Each
 * such report moves into the "Debate report" folder of the work item its debate was started from (found again from the
 * debate log: same project, same question -> same title). Nothing is guessed: a report whose debate is not in the log,
 * or whose origin has no folder, stays where it is. Returns how many reports moved.
 */
export function relocateLegacyReports(): number {
  const db = getDb()
  const rows = db.prepare("SELECT id, project_id, title, folder FROM work_items WHERE deleted_at IS NULL AND folder IS NOT NULL AND (title LIKE 'Vitáztatás jelentés: %' OR title LIKE 'Debate report: %')").all() as { id: string; project_id: string; title: string; folder: string }[]
  if (!rows.length) return 0
  const origins = listDebateOrigins()
  let moved = 0
  for (const row of rows) {
    try {
      const project = getProject(row.project_id)
      if (!project || project.archived_at != null) continue
      const box = findWorkItemsBox(project) ?? ''
      const slash = row.folder.lastIndexOf('/')
      if ((slash < 0 ? '' : row.folder.slice(0, slash)) !== box) continue
      const base = row.folder.slice(slash + 1)
      const legacy = ['hu', 'en'].some(l => base.startsWith(legacyReportFolderName(l) + ' '))
      if (!legacy) continue
      const ids = new Set<string>()
      for (const o of origins) {
        if (o.project !== row.project_id || (reportTitle(o.question, 'hu') !== row.title && reportTitle(o.question, 'en') !== row.title)) continue
        // A debate from before the origin was recorded: the work item it attached is the one whose title is a file name.
        if (o.workItem) ids.add(o.workItem)
        else for (const name of o.files) for (const hit of itemsTitled(row.project_id, name, row.id)) ids.add(hit)
      }
      if (ids.size !== 1) continue
      const origin = getWorkItem([...ids][0])
      if (!origin || origin.project_id !== project.id || origin.deleted_at != null || !origin.folder) continue
      const item = getWorkItem(row.id)
      if (!item) continue
      const lang = row.title.startsWith('Debate report') ? 'en' : 'hu'
      const mf = makeWorkFolder(project, origin.folder, reportFolderIn(project, origin.folder, lang))
      if (!mf.ok) continue
      const r = moveWorkItemToFolder(item, reportSubFolder(project, mf.folder, lang))
      if (r.ok && r.moved) moved++
    } catch (err) {
      logger.warn({ item: row.id, err: String((err as Error)?.message || err) }, '[debate-report] legacy relocation skipped')
    }
  }
  if (moved) logger.info({ moved }, '[debate-report] legacy reports moved into their work item folder')
  return moved
}

/** The names of the five standard subfolders of a work item folder (every generation of the names). */
const STANDARD_SUBFOLDER_NAMES: string[] = [
  FINISHED_FOLDER_NAMES.hu, FINISHED_FOLDER_NAMES.en, ...FINISHED_FOLDER_OLD_NAMES,
  'Mellékletek', 'Attachments', 'Feltöltések', 'Uploads',
  AGENT_REFS_FOLDER_NAMES.hu, ...AGENT_REFS_FOLDER_OLD_NAMES,
  DEBATE_FOLDER_NAMES.hu, DEBATE_FOLDER_NAMES.en, ...DEBATE_FOLDER_OLD_NAMES,
]

/**
 * #656: a debate report made before the fix may sit in a folder that holds EMPTY standard subfolders (Finished, Attachments,
 * Uploads ...) it never needed. Each one is removed, and only while it is really empty (rmdir refuses anything with even a
 * hidden file in it). Only a report's own debate / report folder is touched: a report that fell back into its origin item's
 * folder shares the item's real subfolders, which stay. Returns how many folders were removed.
 */
export function removeEmptyReportScaffoldFolders(): number {
  const db = getDb()
  const rows = db.prepare("SELECT id, project_id, folder FROM work_items WHERE deleted_at IS NULL AND folder IS NOT NULL AND folder != '' AND (title LIKE 'Vitáztatás jelentés: %' OR title LIKE 'Debate report: %')").all() as { id: string; project_id: string; folder: string }[]
  const own = new Set<string>([DEBATE_FOLDER_NAMES.hu, DEBATE_FOLDER_NAMES.en, ...DEBATE_FOLDER_OLD_NAMES, DEBATE_REPORT_SUB_NAMES.hu, DEBATE_REPORT_SUB_NAMES.en])
  const seen = new Set<string>()
  let removed = 0
  for (const row of rows) {
    try {
      if (!own.has(row.folder.split('/').pop() ?? '')) continue
      const project = getProject(row.project_id)
      if (!project || project.archived_at != null) continue
      const key = `${row.project_id}|${row.folder}`
      if (seen.has(key)) continue
      seen.add(key)
      const t = projectFileTarget(project, row.folder)
      if (!t.ok) continue
      for (const name of STANDARD_SUBFOLDER_NAMES) {
        const sub = projectFileTarget(project, `${row.folder}/${name}`)
        if (!sub.ok || readdirSync(sub.dirAbs).length > 0) continue
        try { rmdirSync(sub.dirAbs); removed++ } catch { /* not empty after all, or in use: left alone */ }
      }
    } catch (err) {
      logger.warn({ item: row.id, err: String((err as Error)?.message || err) }, '[debate-report] empty scaffold folder cleanup skipped')
    }
  }
  if (removed) logger.info({ removed }, '[debate-report] empty standard subfolders of debate reports removed')
  return removed
}

/** Runs once shortly after start-up (the dashboard restarts on every deploy), so no report waits for the next debate. */
export function startLegacyReportRelocation(): void {
  if (process.env['VITEST']) return
  setTimeout(() => { try { relocateLegacyReports(); removeEmptyReportScaffoldFolders() } catch { /* retried at the next start */ } }, 30_000).unref?.()
}
