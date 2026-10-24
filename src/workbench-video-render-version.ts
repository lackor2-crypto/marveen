// #786: a video work item's render, with the version it belongs to -- ONE road for the editor and the Workbench assistant.
//
// The mp4 is recorded on the version that holds exactly the timeline it was made from. That version is saved BEFORE the
// render starts (nothing awaits between saving it and reading the timeline that is rendered): edits made while ffmpeg runs
// go on in the working copy and never become the render's version. Before, the version was saved when the render ENDED,
// so it took the edits made meanwhile, and the mp4 stood next to a timeline it was not made from.

import type { ProjectRow } from './projects.js'
import { setWorkItemVersionMeta, type WorkItemRow } from './workbench.js'
import { renderTimeline, lastRenderOf, type LastRender } from './workbench-video-render.js'
import { timelineStore } from './workbench-video-timeline.js'

export type RenderVersionResult =
  | { ok: true; file: { rel: string; name: string; bytes: number }; seconds: number; version_id: string | null; last: LastRender | null; current: boolean }
  /** `store`: the timeline could not be read (its code is a store code); `render`: the render itself failed. */
  | { ok: false; from: 'store' | 'render'; code: string; detail: string | null }

export async function renderTimelineToVersion(
  project: ProjectRow, item: WorkItemRow, actor: string | null, onProgress?: (fraction: number) => void,
): Promise<RenderVersionResult> {
  const store = timelineStore()
  const v = store.saveVersion(item, { reason: 'export', actor, metadata: {} })
  const cur = store.read(item.id)
  if (!cur.ok) return { ok: false, from: 'store', code: cur.code, detail: cur.detail ?? null }
  const r = await renderTimeline(project, item.id, item.title, cur.doc, onProgress)
  if (!r.ok) return { ok: false, from: 'render', code: r.code, detail: ('detail' in r && r.detail) || null }
  const versionId = v.ok ? v.version.id : cur.version_id
  if (versionId) setWorkItemVersionMeta(versionId, { render: { rel: r.file.rel, name: r.file.name, seconds: r.seconds, bytes: r.file.bytes } })
  const last = lastRenderOf(item.id)
  // "current" only when nothing was edited while it rendered (the same rule as the timeline's GET).
  const now = store.read(item.id)
  const current = !!last && now.ok && !!now.version_id && last.version_id === now.version_id && !(now.draft && now.draft.since_version)
  return { ok: true, file: r.file, seconds: r.seconds, version_id: versionId ?? null, last, current }
}
