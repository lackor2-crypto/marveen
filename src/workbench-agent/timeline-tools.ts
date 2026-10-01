/**
 * The Workbench agent's video timeline tools (v4 spec phase 5): read, edit and render.
 * They use the same operations and the same working copy / undo / version store as
 * the owner's timeline editor, so everything the agent does is one undo step for the owner.
 */
import type { ProjectRow } from '../projects.js'
import { getWorkItem, setWorkItemVersionMeta } from '../workbench.js'
import {
  timelineStore, applyTimelineOps, timelineSummary, timelineDuration, clipOffsets, TIMELINE_ASPECTS,
  type TimelineDoc,
} from '../workbench-video-timeline.js'
import { opsLabel } from '../workbench-draft-store.js'
import { renderTimeline, lastRenderOf, fillClipEnds } from '../workbench-video-render.js'
import type { ToolContext, ToolResult } from './execute.js'

function videoItem(project: ProjectRow, id: string): { ok: true; item: NonNullable<ReturnType<typeof getWorkItem>> } | Extract<ToolResult, { ok: false }> {
  if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
  const item = getWorkItem(id)
  if (!item || item.project_id !== project.id) return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
  if (item.type !== 'video') return { ok: false, code: 'bad_input', detail: 'only a work item of type video has a timeline' }
  return { ok: true, item }
}

function view(doc: TimelineDoc): Record<string, unknown> {
  return { timeline: doc, summary: timelineSummary(doc), duration: timelineDuration(doc), clipStartsOnTimeline: clipOffsets(doc) }
}

export function timelineGet(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const v = videoItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const r = timelineStore().read(v.item.id)
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail || r.code }
  const last = lastRenderOf(v.item.id)
  return {
    ok: true,
    data: {
      ...view(r.doc), exists: r.exists, aspects: TIMELINE_ASPECTS,
      lastRender: last ? { path: last.rel, seconds: last.seconds, upToDate: last.version_id === r.version_id && !(r.draft && r.draft.since_version) } : null,
      note: r.exists ? '' : 'there is no timeline yet on this work item; this is an empty one to start from. Clips are video files of the project folder: use file.list to find their paths (the path starts with the project folder).',
    },
  }
}

export async function timelineEdit(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const v = videoItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const store = timelineStore()
  const current = store.read(v.item.id)
  if (!current.ok) return { ok: false, code: current.code, detail: current.detail || current.code }
  // An addClip without `end` runs to the end of the file; the length is read from the file.
  const filled = await fillClipEnds(project, input.ops)
  if (!filled.ok) return { ok: false, code: filled.code, detail: ('detail' in filled && filled.detail) || filled.code }
  const applied = applyTimelineOps(current.doc, filled.ops)
  if (!applied.ok) return { ok: false, code: applied.code, detail: applied.detail }
  const saved = store.commit(v.item, applied.doc, {
    source: 'agent', grp: ctx.turnId ? `agent:${ctx.turnId}` : null, label: opsLabel(input.ops),
    actor: 'workbench-agent', name: current.name, versionBeforeBig: true,
  })
  if (!saved.ok) return { ok: false, code: saved.code, detail: saved.detail || saved.code }
  const notes: string[] = []
  if (saved.versioned) notes.push(`this was a big change, so the unsaved work before it was first kept as version ${saved.versioned.version_no}`)
  notes.push(saved.created ? 'the timeline was created as a new version' : 'saved to the working copy (no new version); the owner can undo this whole request in one step')
  return { ok: true, data: { ...view(applied.doc), applied: applied.applied, note: notes.join('; ') } }
}

export async function timelineRender(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const v = videoItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const store = timelineStore()
  const cur = store.read(v.item.id)
  if (!cur.ok) return { ok: false, code: cur.code, detail: cur.detail || cur.code }
  const r = await renderTimeline(project, v.item.id, v.item.title, cur.doc)
  if (!r.ok) return { ok: false, code: r.code, detail: ('detail' in r && r.detail) || r.code }
  const ver = store.saveVersion(v.item, { reason: 'export', actor: 'workbench-agent', metadata: {} })
  const versionId = ver.ok ? ver.version.id : cur.version_id
  if (versionId) setWorkItemVersionMeta(versionId, { render: { rel: r.file.rel, name: r.file.name, seconds: r.seconds, bytes: r.file.bytes } })
  return { ok: true, data: { path: r.file.rel, name: r.file.name, seconds: r.seconds, bytes: r.file.bytes, note: 'a NEW mp4 file was made in the project folder; nothing was overwritten' } }
}
