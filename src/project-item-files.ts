// THE FILES IN THE PROJECT'S WORK ITEM FOLDERS, LISTED AS ITS DOCUMENTS (#530, Boss TG 2833/2845).
//
// "az Iratok alatt nem latom [...] pedig az ujbirosagi beadvany mappa alatt van, ez mind": a file that lies in a
// work item's folder (the .docx, the translated variant, the generated PDF, the uploaded annexes) belongs to the
// matter even when nobody linked it. COMPUTED on every call from the disk, not stored; a file that is also a
// linked document or attachment is not listed twice.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLifePath } from './life-explorer.js'
import { listProjectDocs } from './workbench-doc-links.js'
import { projectItemFolders } from './project-places-auto.js'

export interface ProjectItemFile {
  rel: string
  name: string
  item_id: string
  item: string
  /** The sub-folder inside the item folder ('' = directly in it), e.g. the uploaded annexes. */
  sub: string
  size: number
  /** Seconds since the epoch. */
  mtime: number
}

const MAX_FILES = 300
const MAX_DEPTH = 2

export function projectItemFiles(projectId: string): { files: ProjectItemFile[]; truncated: boolean } {
  const pd = listProjectDocs(projectId)
  const linked = new Set<string>([...pd.docs.map((d) => d.life_rel), ...pd.attachments.map((a) => a.life_rel)])
  const seen = new Set<string>()
  const files: ProjectItemFile[] = []
  let truncated = false
  for (const f of projectItemFolders(projectId)) {
    const root = resolveLifePath(f.rel)
    if (!root) continue
    const walk = (dirAbs: string, dirRel: string, depth: number): void => {
      let names: string[] = []
      try { names = readdirSync(dirAbs).sort((a, b) => a.localeCompare(b)) } catch { return }
      for (const n of names) {
        if (n.startsWith('.')) continue
        const abs = join(dirAbs, n)
        const rel = dirRel + '/' + n
        let st
        try { st = statSync(abs) } catch { continue }
        if (st.isDirectory()) { if (depth < MAX_DEPTH) walk(abs, rel, depth + 1); continue }
        if (!st.isFile() || linked.has(rel) || seen.has(rel)) continue
        if (files.length >= MAX_FILES) { truncated = true; return }
        seen.add(rel)
        files.push({ rel, name: n, item_id: f.item_id, item: f.title, sub: dirRel === f.rel ? '' : dirRel.slice(f.rel.length + 1), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
      }
    }
    walk(root, f.rel, 0)
  }
  return { files, truncated }
}
