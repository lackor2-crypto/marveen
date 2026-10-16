// A debate report (debate-export.ts) saved as a document work item of the project (#597, phase 6).
//
// From there the document does what every document does: the PDF and Word export, the page view, the history. The
// document gets its own folder in the project's work items box, the same way a work item made from the intake does,
// and is made by the owner's hand (the debate only fills it).

import { getProject } from './projects.js'
import { createWorkItem, getWorkItem, setWorkItemDeleted, type WorkItemRow } from './workbench.js'
import { replacePage, BLOCK_TEXT_MAX } from './workbench-docmodel.js'
import { scheduleOutlineMirror } from './workbench-docmirror.js'
import { assignWorkItemFolder, makeWorkFolder } from './workbench-assets.js'
import type { DebateReport } from './debate-export.js'

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
  return lang === 'en' ? 'Debate report' : 'Vitáztatás jelentés'
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
  const originFolder = origin && origin.project_id === project.id && origin.deleted_at == null && origin.folder ? origin.folder : ''
  const mf = makeWorkFolder(project, originFolder, reportFolderName(opts?.lang ?? 'hu'))
  const folder = mf.ok ? mf.folder : null
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
