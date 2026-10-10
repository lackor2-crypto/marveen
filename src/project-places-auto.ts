// THE PROJECT'S PLACES IN THE LIFE TREE, FOUND BY THE SYSTEM (#530, Boss TG 8544).
//
// "Miert nekem kellene kitallozni hol vannak a file-ok? [...] ha fel van toltve vagy csatolva vagy
// hivatkozva barmi is, akkor annak mar lehet tudni a helyet! az jelenjen meg itt automatikusan."
//
// COMPUTED, NOT STORED: every call derives the folders from the project's present links, so a
// rename or a move is followed (the documents are looked up by their document id, the work items
// by their folder, which life-follow keeps current). One folder appears once; `count` is how many
// documents/work items are there; `reasons` say which of them put the folder on the list.
// The places added by hand (project-places.ts) stay and are marked `manual`; an automatic one has
// no "remove" -- it goes away by itself when nothing of the project is there any more.

import { statSync } from 'node:fs'
import { getDb } from './db.js'
import { resolveLifePath } from './life-explorer.js'
import { getProject } from './projects.js'
import { listProjectPlaces } from './project-places.js'
import { listProjectDocs } from './workbench-doc-links.js'
import { listAnnexes } from './workbench-docannex.js'
import { ensureAssetTables } from './workbench-assets.js'

export type PlaceReasonKind = 'source' | 'reference' | 'related' | 'official' | 'attachment' | 'item' | 'annex'
/** `item_id` is set when the reason is a work item's (its folder, material, annex or a submission's attachment). */
export interface PlaceReason { kind: PlaceReasonKind; name: string; item_id?: string }
export interface ProjectPlaceView {
  rel: string
  /** The folder is there now (measured). */
  exists: boolean
  /** false: the Life tree itself is not reachable (detached disk) -- "not reachable now", never "no such place". */
  reachable: boolean
  /** Added by hand (it can be removed). */
  manual: boolean
  /** Found by the system from the project's documents / work items. */
  auto: boolean
  /** Documents and work items of the project that are in this folder. */
  count: number
  /** Why it is on the list (at most REASONS_SHOWN); `more` is how many are not listed. */
  reasons: PlaceReason[]
  more: number
  /** How many of the reasons belong to each work item (#539: the item view lists only its own places). A
   *  document linked to the project or a place added by hand belongs to no item and is not counted here. */
  item_counts: Record<string, number>
}

const REASONS_SHOWN = 5
const clean = (rel: string): string => String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
const dirOf = (rel: string): string => { const r = clean(rel); const i = r.lastIndexOf('/'); return i < 0 ? '' : r.slice(0, i) }
const nameOf = (rel: string): string => { const r = clean(rel); return r.slice(r.lastIndexOf('/') + 1) }

function treeReachable(): boolean {
  const abs = resolveLifePath('')
  if (!abs) return false
  try { return statSync(abs).isDirectory() } catch { return false }
}

export function projectPlacesView(projectId: string): ProjectPlaceView[] {
  const found = new Map<string, { reasons: PlaceReason[]; keys: Set<string> }>()
  const add = (folder: string, kind: PlaceReasonKind, name: string, key: string, itemId?: string): void => {
    const rel = clean(folder)
    if (!rel) return // the root of the tree is not a "place of a matter"
    let e = found.get(rel)
    if (!e) { e = { reasons: [], keys: new Set() }; found.set(rel, e) }
    if (e.keys.has(key)) return
    e.keys.add(key)
    e.reasons.push(itemId ? { kind, name, item_id: itemId } : { kind, name })
  }

  // (a) the documents linked to the project, any role, and (c) the filed official copies (role 'official').
  // (b) the Life-tree documents the project's submissions attach.
  const pd = listProjectDocs(projectId)
  for (const d of pd.docs) add(dirOf(d.life_rel), d.role, d.name, 'doc:' + d.id)
  for (const a of pd.attachments) add(dirOf(a.life_rel), 'attachment', a.name, 'att:' + a.item_id + ':' + a.life_rel, a.item_id)

  // (d) the folders of the project's work items, and (uploaded) annexes that live elsewhere in the tree.
  ensureAssetTables()
  const project = getProject(projectId)
  const base = clean(project?.folder_path || '')
  // A stored path is either project-relative or already a path of the Life tree: both are accepted.
  // A folder that was moved to another project's tree is stored as that tree's own path ("Család/..."): when the
  // project-relative reading is not a folder but the path itself is one, the path is the place.
  const isDir = (rel: string): boolean => { const a = resolveLifePath(rel); if (!a) return false; try { return statSync(a).isDirectory() } catch { return false } }
  const inTree = (p: string): string => {
    const c = clean(p)
    if (c === base || c.startsWith(base + '/')) return c
    const joined = base + '/' + c
    return !isDir(joined) && isDir(c) ? c : joined
  }
  if (base) {
    const items = getDb().prepare('SELECT id, title, folder FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as { id: string; title: string; folder: string | null }[]
    for (const it of items) {
      const f = clean(it.folder || '')
      if (f) add(inTree(f), 'item', it.title, 'item:' + it.id, it.id)
      // An item whose folder was never recorded still has its materials somewhere: those folders are its places.
      const mats = getDb().prepare('SELECT path FROM work_item_assets WHERE work_item_id = ? AND removed_at IS NULL').all(it.id) as { path: string }[]
      for (const m of mats) add(dirOf(inTree(m.path)), 'item', it.title, 'item:' + it.id, it.id)
      for (const a of listAnnexes(it.id)) {
        if (a.linked) continue
        add(dirOf(inTree(a.path)), 'annex', baseName(a.path), 'annex:' + it.id + ':' + a.path, it.id)
      }
    }
  }

  const manual = new Set(listProjectPlaces(projectId).map(clean))
  const reachable = treeReachable()
  const out: ProjectPlaceView[] = []
  for (const rel of new Set([...found.keys(), ...manual])) {
    const e = found.get(rel)
    let exists = false
    const abs = resolveLifePath(rel)
    if (abs) { try { exists = statSync(abs).isDirectory() } catch { exists = false } }
    const reasons = e ? e.reasons : []
    const itemCounts: Record<string, number> = {}
    for (const r of reasons) if (r.item_id) itemCounts[r.item_id] = (itemCounts[r.item_id] || 0) + 1
    out.push({ rel, exists, reachable, manual: manual.has(rel), auto: !!e, count: reasons.length, reasons: reasons.slice(0, REASONS_SHOWN), more: Math.max(0, reasons.length - REASONS_SHOWN), item_counts: itemCounts })
  }
  // The most documents first (the picker opens at the first one that is there), then the ones added by hand.
  return out.sort((x, y) => y.count - x.count || Number(y.manual) - Number(x.manual) || x.rel.localeCompare(y.rel))
}

function baseName(p: string): string { return nameOf(p) }

/** Where a work item's own folder is, as a path of the Life tree (a folder moved to another tree is its own path). */
export function projectItemFolders(projectId: string): { item_id: string; title: string; rel: string }[] {
  ensureAssetTables()
  const project = getProject(projectId)
  const base = clean(project?.folder_path || '')
  if (!base) return []
  const isDir = (rel: string): boolean => { const a = resolveLifePath(rel); if (!a) return false; try { return statSync(a).isDirectory() } catch { return false } }
  const items = getDb().prepare('SELECT id, title, folder FROM work_items WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as { id: string; title: string; folder: string | null }[]
  const out: { item_id: string; title: string; rel: string }[] = []
  for (const it of items) {
    const f = clean(it.folder || '')
    if (!f) continue
    const joined = base + '/' + f
    const rel = f === base || f.startsWith(base + '/') ? f : (!isDir(joined) && isDir(f) ? f : joined)
    out.push({ item_id: it.id, title: it.title, rel })
  }
  return out
}
