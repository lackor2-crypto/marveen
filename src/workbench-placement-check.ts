// #758, 3A (Boss TG 4421): after a move, a finalisation or an upload the system MACHINE-CHECKS where the files of the
// work item lie, with the same judgement the tree shows (#698, workbench-misplaced.ts), and the assistant SAYS SO in the
// work item's chat. Nothing is moved: the owner decides. A soft note (a file in the Agent folder, an outside opinion in
// the Debate folder) is not a mistake and is not reported here.
import { getProject, type ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'
import { listWorkFolders } from './workbench-assets.js'
import { misplacedFor, roleOfFolderName, type MisplacedCode } from './workbench-misplaced.js'
import { addAgentMessageOnce, openSessionForWorkItem } from './workbench-agent/sessions.js'

export type PlacementEvent = 'upload' | 'finalize' | 'life_move'

export interface PlacementIssue {
  /** Where the file is now (project-relative folder for a project file, Life-tree path for a moved one). */
  folder: string
  name: string
  code: MisplacedCode
}

/** Shown at most this many files in one note (the tree marks all of them). */
export const PLACEMENT_NOTE_MAX = 10

const REASON: Record<MisplacedCode, { hu: string; en: string }> = {
  attachment_in_finished: { hu: 'mellékletnek látszik, de az Elkészített anyagok között áll; a Mellékletek mappába való', en: 'looks like an attachment but lies among the Finished materials; it belongs in Attachments' },
  finished_in_attachments: { hu: 'kész, végleges anyagnak látszik, de a Mellékletek között áll; az Elkészített anyagok közé való', en: 'looks like finished material but lies among the Attachments; it belongs in Finished materials' },
  loose_beside_item: { hu: 'közvetlenül a munkadarabok mellett áll, egyikhez sem tartozik', en: 'lies loose beside the work items and belongs to none of them' },
  in_agent_folder: { hu: 'az Agent mappában van', en: 'is in the Agent folder' },
  report_elsewhere: { hu: 'vitáztatás-jelentés, de nem a Vitáztatás mappa Jelentés almappájában áll', en: 'is a debate report but not in the Report subfolder of the Debate folder' },
  not_report_in_debate: { hu: 'a Vitáztatás mappában áll, de nem vitáztatás-jelentésnek látszik', en: 'lies in the Debate folder but does not look like a debate report' },
}

const EVENT: Record<PlacementEvent, { hu: string; en: string }> = {
  upload: { hu: 'a feltöltés', en: 'the upload' },
  finalize: { hu: 'a véglegesítés', en: 'the finalisation' },
  life_move: { hu: 'az Életfába költöztetés', en: 'the move into the Life tree' },
}

/** The hard verdicts for the files in the work item's own folder (and its subfolders), as the tree marks them. */
export function placementIssues(project: ProjectRow, item: Pick<WorkItemRow, 'folder'>): PlacementIssue[] {
  const own = String(item.folder ?? '').replace(/^\/+|\/+$/g, '')
  if (!own) return []
  const listed = listWorkFolders(project, { outside: false })
  const out: PlacementIssue[] = []
  for (const [folder, files] of Object.entries(listed.files)) {
    if (folder !== own && !folder.startsWith(own + '/')) continue
    for (const f of files) {
      if (f.misplaced && !f.misplaced.soft) out.push({ folder, name: f.name, code: f.misplaced.code })
    }
  }
  return out
}

/** The files a Life-tree move put into a folder of the wrong role (e.g. an attachment into "Elkészített anyagok"). */
export function lifeMoveIssues(moved: Array<{ newRel: string }>): PlacementIssue[] {
  const out: PlacementIssue[] = []
  for (const m of moved) {
    const parts = String(m.newRel || '').split('/').filter(Boolean)
    if (parts.length < 2) continue
    const name = parts[parts.length - 1]
    const role = roleOfFolderName(parts[parts.length - 2])
    if (!role || role === 'agent') continue
    const v = misplacedFor(role, name)
    if (v && !v.soft) out.push({ folder: parts.slice(0, -1).join('/'), name, code: v.code })
  }
  return out
}

export function placementNote(issues: PlacementIssue[], event: PlacementEvent, lang: 'hu' | 'en'): string {
  const shown = issues.slice(0, PLACEMENT_NOTE_MAX)
  const lines = shown.map((i) => `- ${i.name} (${i.folder}): ${REASON[i.code][lang]}`)
  const more = issues.length > shown.length
    ? [lang === 'hu' ? `... és még ${issues.length - shown.length}; a fában mindegyik meg van jelölve.` : `... and ${issues.length - shown.length} more; the tree marks all of them.`]
    : []
  const head = lang === 'hu'
    ? `Gépi önellenőrzés ${EVENT[event].hu} után: ${issues.length} fájl valószínűleg rossz helyen van.`
    : `Machine self-check after ${EVENT[event].en}: ${issues.length} file(s) probably lie in the wrong place.`
  const tail = lang === 'hu'
    ? 'Nem mozdítottam el semmit, te döntesz. A fában meg van jelölve; jobb klikkel áthelyezheted, vagy írd meg, és segítek.'
    : 'I did not move anything; you decide. The tree marks it; right-click it to move it, or tell me and I help.'
  return [head, ...lines, ...more, tail].join('\n')
}

export interface PlacementCheck { issues: number; note: string | null; item_id: string }

/**
 * Run the check and, when something is wrong, write the note into the work item's chat (once: the same note is not
 * written twice within an hour). Never throws: a check that cannot run says nothing rather than breaking the action
 * it follows; `issues: -1` tells the caller it could not look.
 */
export function checkPlacementAfter(item: WorkItemRow, event: PlacementEvent, lang: 'hu' | 'en', extra: PlacementIssue[] = []): PlacementCheck {
  try {
    const project = getProject(item.project_id)
    if (!project) return { issues: -1, note: null, item_id: item.id }
    const seen = new Set<string>()
    const issues = [...extra, ...placementIssues(project, item)].filter((i) => {
      const k = `${i.folder}/${i.name}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    if (!issues.length) return { issues: 0, note: null, item_id: item.id }
    const note = placementNote(issues, event, lang)
    const session = openSessionForWorkItem(project.id, item.id, lang)
    addAgentMessageOnce(session.id, 'assistant', note, Math.floor(Date.now() / 1000) - 3600)
    return { issues: issues.length, note, item_id: item.id }
  } catch {
    return { issues: -1, note: null, item_id: item.id }
  }
}
