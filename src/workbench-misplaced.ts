// #698 (Boss TG 9710/9714/9719/9731): the Workbench tree SAYS when a file is probably in the wrong place. It never moves
// or deletes anything: the owner decides. The judgement goes by the ROLE of the folder the file lies in (the standard
// subfolders of a work item, found by their names in project-files.ts, so a renamed or old-named folder keeps its role),
// not by a hard-wired path, and by what the file's NAME looks like.
//
// The same guess of "what kind of file is this" (`fileKindGuess`) is what the upload suggestion (#700) uses.
import {
  AGENT_REFS_FOLDER_NAMES, AGENT_REFS_FOLDER_OLD_NAMES, DEBATE_FOLDER_NAMES, DEBATE_FOLDER_OLD_NAMES,
  FINISHED_FOLDER_NAMES, FINISHED_FOLDER_OLD_NAMES,
} from './project-files.js'

export type FolderRole = 'box' | 'finished' | 'attachments' | 'uploads' | 'agent' | 'debate'
export type FileKind = 'attachment' | 'finished' | 'debate_report' | 'external_opinion'
export type MisplacedCode =
  | 'attachment_in_finished'
  | 'finished_in_attachments'
  | 'loose_beside_item'
  | 'in_agent_folder'
  | 'report_elsewhere'
  | 'not_report_in_debate'
/** `soft`: a gentle note only (an uploaded outside opinion, a file in the Agent folder), not a "this is wrong". */
export type Misplaced = { code: MisplacedCode; soft?: true }

const ROLE_NAMES: Record<Exclude<FolderRole, 'box'>, readonly string[]> = {
  finished: [FINISHED_FOLDER_NAMES.hu, FINISHED_FOLDER_NAMES.en, ...FINISHED_FOLDER_OLD_NAMES],
  attachments: ['Mellékletek', 'Attachments'],
  uploads: ['Feltöltések', 'Uploads'],
  agent: [AGENT_REFS_FOLDER_NAMES.hu, AGENT_REFS_FOLDER_NAMES.en, ...AGENT_REFS_FOLDER_OLD_NAMES],
  debate: [DEBATE_FOLDER_NAMES.hu, DEBATE_FOLDER_NAMES.en, ...DEBATE_FOLDER_OLD_NAMES],
}

/** The role of a standard subfolder by its name; null for any other name. */
export function roleOfFolderName(name: string): Exclude<FolderRole, 'box'> | null {
  const n = String(name ?? '').trim()
  for (const role of Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[]) if (ROLE_NAMES[role].includes(n)) return role
  return null
}

const ATTACHMENT_NAME = /^(k|mell[eé]klet|anlage|att(?:achment)?)[\s_.-]*\d+|mell[eé]klet|attachment|anlage|^(img|dsc|pxl)[_-]?\d{3,}|k[eé]perny[oő]k[eé]p|^screenshot|szkenn|scan/i
const FINISHED_NAME = /v[eé]gleges|(^|[\s_.-])final([\s_.-]|$)|elk[eé]sz[ií]tett|finished|(^|[\s_.-])k[eé]sz([\s_.-]|$)/i
/** The finished annex PDFs that finalising a document writes ("K1 \u2013 Title.pdf", workbench-docfinal.ts) belong in the
 *  Finished materials on purpose, next to the submission (Boss, 2026-10-16): they are NOT attachments lying in the wrong place. */
const GENERATED_ANNEX_FINAL = /^[A-Za-z]{1,3}\d+ \u2013 /
const DEBATE_REPORT_NAME = /^(vit[aá]ztat[aá]s|debate)[\s∕/_-]*(jelent[eé]s|report)/i
const EXTERNAL_OPINION_NAME = /gpt|gemini|claude|grok|copilot|llm|v[eé]lem[eé]ny|opinion|áttekint[eé]s|attekintes|v[aá]lasz|answer/i

/** What a file of this name probably is. The debate report wins over the rest; an outside opinion is told from a report. */
export function fileKindGuess(name: string): FileKind | null {
  const n = String(name ?? '')
  if (DEBATE_REPORT_NAME.test(n)) return 'debate_report'
  if (EXTERNAL_OPINION_NAME.test(n)) return 'external_opinion'
  if (ATTACHMENT_NAME.test(n)) return 'attachment'
  if (FINISHED_NAME.test(n)) return 'finished'
  return null
}

/** The verdict for one file lying in a folder of this role; null when it looks right (or nothing can be said). */
export function misplacedFor(role: FolderRole | null, name: string): Misplaced | null {
  if (!role) return null
  const kind = fileKindGuess(name)
  if (role === 'box') return { code: 'loose_beside_item' }
  if (role === 'agent') return { code: 'in_agent_folder', soft: true }
  if (role === 'debate') {
    if (kind === 'debate_report') return null
    return kind === 'external_opinion' ? { code: 'not_report_in_debate', soft: true } : { code: 'not_report_in_debate' }
  }
  if (kind === 'debate_report') return { code: 'report_elsewhere' }
  if (role === 'finished' && kind === 'attachment' && !GENERATED_ANNEX_FINAL.test(name)) return { code: 'attachment_in_finished' }
  if (role === 'attachments' && kind === 'finished') return { code: 'finished_in_attachments' }
  return null
}

type FileLike = { name: string; item?: true; linked?: true; annex?: true; version?: true; misplaced?: Misplaced }

/**
 * Mark the files of the work-items box. `files` is keyed by the box-relative folder, `itemFolders` is the set of live item
 * folders in the same notation. A file in a standard subfolder of an item folder is judged by that subfolder's role; one
 * lying directly in the box (beside the items) is "loose". Links and saved versions are never judged.
 */
export function annotateMisplaced(box: string, files: Record<string, FileLike[]>, itemFolders: ReadonlySet<string>): void {
  for (const [folder, list] of Object.entries(files)) {
    let role: FolderRole | null = null
    if (folder === box) role = 'box'
    else {
      const cut = folder.lastIndexOf('/')
      if (cut > 0 && itemFolders.has(folder.slice(0, cut))) role = roleOfFolderName(folder.slice(cut + 1))
    }
    if (!role) continue
    for (const f of list) {
      if (f.linked || f.annex || f.version) continue
      const m = misplacedFor(role, f.name)
      if (m) f.misplaced = m
    }
  }
}
