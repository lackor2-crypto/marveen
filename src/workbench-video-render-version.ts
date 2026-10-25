// #786: a video work item's render, with the version it belongs to -- ONE road for the editor and the Workbench assistant.
//
// The mp4 is recorded on the version that holds exactly the timeline it was made from. That version is saved BEFORE the
// render starts (nothing awaits between saving it and reading the timeline that is rendered): edits made while ffmpeg runs
// go on in the working copy and never become the render's version. Before, the version was saved when the render ENDED,
// so it took the edits made meanwhile, and the mp4 stood next to a timeline it was not made from.

import { statSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import type { ProjectRow } from './projects.js'
import { setWorkItemVersionMeta, type WorkItemRow } from './workbench.js'
import { renderTimeline, lastRenderOf, resolveMedia, type LastRender } from './workbench-video-render.js'
import { timelineStore, type TimelineDoc } from './workbench-video-timeline.js'

export type RenderVersionResult =
  | { ok: true; file: { rel: string; name: string; bytes: number }; seconds: number; version_id: string | null; last: LastRender | null; current: boolean
      /** #788: nothing changed since the last render: that video was given back, no second render, no "(2).mp4". */
      reused: boolean }
  /** `store`: the timeline could not be read (its code is a store code); `render`: the render itself failed. */
  | { ok: false; from: 'store' | 'render'; code: string; detail: string | null }

export async function renderTimelineToVersion(
  project: ProjectRow, item: WorkItemRow, actor: string | null, onProgress?: (fraction: number) => void,
): Promise<RenderVersionResult> {
  const store = timelineStore()
  const v = store.saveVersion(item, { reason: 'export', actor, metadata: {} })
  const cur = store.read(item.id)
  if (!cur.ok) return { ok: false, from: 'store', code: cur.code, detail: cur.detail ?? null }
  // #788: the same timeline was already rendered and that video still shows it: given back as it is (the owner's
  // #725 rule for finals: an unchanged source makes no "(2)", "(3)" copies). A changed timeline makes a new file, so the
  // earlier version's video is not lost.
  const before = lastRenderOf(item.id)
  if (before && cur.version_id && before.version_id === cur.version_id && !(cur.draft && cur.draft.since_version)) {
    const bytes = stillShows(project, before.rel, cur.doc)
    if (bytes !== null) {
      return { ok: true, file: { rel: before.rel, name: before.name, bytes }, seconds: before.seconds, version_id: cur.version_id, last: before, current: true, reused: true }
    }
  }
  const r = await renderTimeline(project, item.id, item.title, cur.doc, onProgress)
  if (!r.ok) return { ok: false, from: 'render', code: r.code, detail: ('detail' in r && r.detail) || null }
  const versionId = v.ok ? v.version.id : cur.version_id
  if (versionId) setWorkItemVersionMeta(versionId, { render: { rel: r.file.rel, name: r.file.name, seconds: r.seconds, bytes: r.file.bytes } })
  const last = lastRenderOf(item.id)
  // "current" only when nothing was edited while it rendered (the same rule as the timeline's GET).
  const now = store.read(item.id)
  const current = !!last && now.ok && !!now.version_id && last.version_id === now.version_id && !(now.draft && now.draft.since_version)
  return { ok: true, file: r.file, seconds: r.seconds, version_id: versionId ?? null, last, current, reused: false }
}

/** The size of the earlier video when it is still there and newer than every media file the timeline uses; else null. */
function stillShows(project: ProjectRow, rel: string, doc: TimelineDoc): number | null {
  const abs = resolveLifePath(rel)
  if (!abs) return null
  try {
    const out = statSync(abs)
    if (!out.isFile() || !out.size) return null
    const srcs = new Set<string>([...doc.clips.map((c) => c.src), ...doc.overlays.map((o) => o.src), ...(doc.music ? [doc.music.src] : []), ...(doc.voiceovers ?? []).map((v) => v.src)])
    for (const src of srcs) {
      const m = resolveMedia(project, src)
      if (!m.ok) return null
      if (statSync(m.abs).mtimeMs > out.mtimeMs) return null
    }
    return out.size
  } catch { return null }
}
