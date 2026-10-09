/**
 * The Workbench agent's presentation tools (v4 spec phase 5): read, edit and export a
 * deck. They use the same operations and the same working copy / undo / version store
 * as the owner's slide editor, so everything the agent does is one undo step for the owner.
 */
import type { ProjectRow } from '../projects.js'
import { getWorkItem, setWorkItemVersionMeta } from '../workbench.js'
import { deckStore, applyDeckOps, deckSummary, DECK_SIZES, DECK_LAYOUTS, type DeckDoc } from '../workbench-deck.js'
import { exportDeck, DECK_EXPORT_FORMATS, type DeckExportFormat } from '../workbench-deck-export.js'
import { opsLabel } from '../workbench-draft-store.js'
import type { ToolContext, ToolResult } from './execute.js'

function deckItem(project: ProjectRow, id: string): { ok: true; item: NonNullable<ReturnType<typeof getWorkItem>> } | Extract<ToolResult, { ok: false }> {
  if (!id) return { ok: false, code: 'bad_input', detail: 'id is required' }
  const item = getWorkItem(id)
  if (!item || item.project_id !== project.id) return { ok: false, code: 'not_found', detail: 'no work item with this id in this project' }
  if (item.type !== 'presentation') return { ok: false, code: 'bad_input', detail: 'only a work item of type presentation has a slide deck' }
  return { ok: true, item }
}

function view(doc: DeckDoc): Record<string, unknown> {
  return {
    size: doc.size, summary: deckSummary(doc),
    slides: doc.slides.map((s, i) => ({ position: i + 1, id: s.id, notes: s.notes, canvas: s.canvas })),
  }
}

export function deckGet(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const v = deckItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const r = deckStore().read(v.item.id)
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail || r.code }
  return {
    ok: true,
    data: {
      ...view(r.doc), exists: r.exists, sizes: DECK_SIZES, layouts: DECK_LAYOUTS,
      note: r.exists ? '' : 'there is no slide deck yet on this work item; this is an empty one to start from. Add slides with deck.edit addSlide.',
    },
  }
}

export function deckEdit(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const v = deckItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const store = deckStore()
  const current = store.read(v.item.id)
  if (!current.ok) return { ok: false, code: current.code, detail: current.detail || current.code }
  const applied = applyDeckOps(current.doc, input.ops)
  if (!applied.ok) return { ok: false, code: applied.code, detail: applied.detail }
  const saved = store.commit(v.item, applied.doc, {
    source: 'agent', grp: ctx.turnId ? `agent:${ctx.turnId}` : null, label: opsLabel(input.ops),
    actor: 'workbench-agent', name: current.name, versionBeforeBig: true,
  })
  if (!saved.ok) return { ok: false, code: saved.code, detail: saved.detail || saved.code }
  const notes: string[] = []
  if (saved.versioned) notes.push(`this was a big change, so the unsaved work before it was first kept as version ${saved.versioned.version_no}`)
  notes.push(saved.created ? 'the deck was created as a new version' : 'saved to the working copy (no new version); the owner can undo this whole request in one step')
  return { ok: true, data: { ...view(applied.doc), applied: applied.applied, note: notes.join('; ') } }
}

export async function deckExport(project: ProjectRow, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const v = deckItem(project, String(input.id ?? '').trim() || ctx.workItemId || '')
  if (!v.ok) return v
  const format = String(input.format ?? 'pptx') as DeckExportFormat
  if (!DECK_EXPORT_FORMATS.includes(format)) return { ok: false, code: 'bad_input', detail: `format must be one of ${DECK_EXPORT_FORMATS.join(', ')}` }
  const store = deckStore()
  const cur = store.read(v.item.id)
  if (!cur.ok) return { ok: false, code: cur.code, detail: cur.detail || cur.code }
  const r = await exportDeck(project, v.item, cur.rel, cur.doc, format)
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail || r.code }
  const ver = store.saveVersion(v.item, { reason: 'export', actor: 'workbench-agent', metadata: {} })
  const versionId = ver.ok ? ver.version.id : cur.version_id
  if (versionId) setWorkItemVersionMeta(versionId, { export: { rel: r.file.rel, name: r.file.name, format: r.format, slides: r.slides, bytes: r.file.bytes } })
  return { ok: true, data: { path: r.file.rel, name: r.file.name, format: r.format, slides: r.slides, warnings: r.warnings, note: 'a NEW file was made in the project folder; nothing was overwritten' } }
}
