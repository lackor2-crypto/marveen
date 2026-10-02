/**
 * WORKBENCH BRAND TEMPLATES IN USE (v4 spec K-4.1): a drawing becomes a brand
 * template, a brand template becomes a new drawing.
 *
 * The templates themselves (the table, the list, the names) live in
 * workbench-brand.ts, which knows nothing about work items. This module is
 * the bridge to the work item and canvas stores, so the panel and the
 * Workbench agent take the same road.
 */
import type { ProjectRow } from './projects.js'
import {
  createWorkItem, getWorkItem, setWorkItemDeleted, purgeWorkItem, TITLE_MAX,
  type WorkItemRow, type WorkItemVersionRow,
} from './workbench.js'
import { readCanvas, commitCanvasChange, type CanvasStepSource } from './workbench-canvas-store.js'
import { saveBrandTemplate, getBrandTemplate, type BrandTemplate } from './workbench-brand.js'

export type BrandTemplateFromItem =
  | { ok: true; template: BrandTemplate; replaced: boolean }
  | { ok: false; code: string; detail: string | null }

/**
 * Saves the drawing of a work item as a brand template -- what is on the
 * canvas NOW, the working copy included. Without a name the work item's title
 * is the name. A work item without a drawing is said so, never saved as an
 * empty template.
 */
export function brandTemplateFromItem(
  item: WorkItemRow,
  name: unknown,
  opts: { replace?: boolean; createdBy?: string | null } = {},
): BrandTemplateFromItem {
  const c = readCanvas(item.id)
  if (!c.ok) return { ok: false, code: c.code, detail: c.detail }
  if (!c.exists) return { ok: false, code: 'template_no_canvas', detail: null }
  const given = typeof name === 'string' && name.trim() ? name : item.title
  const r = saveBrandTemplate(item.project_id, given, c.doc, opts)
  return r.ok ? r : { ok: false, code: r.code, detail: null }
}

export type FromBrandTemplate =
  | { ok: true; item: WorkItemRow; version: WorkItemVersionRow; template: BrandTemplate }
  | { ok: false; code: string; detail: string | null }

/**
 * A new drawing (work item) in the project, starting as a copy of the
 * template. The template is not touched. Without a title the template's name
 * is the title, so it really is one click.
 */
export function createFromBrandTemplate(
  project: Pick<ProjectRow, 'id'>,
  idOrName: unknown,
  opts: { title?: unknown; createdBy?: string | null; source?: CanvasStepSource } = {},
): FromBrandTemplate {
  const t = getBrandTemplate(project.id, idOrName)
  if (!t.ok) return { ok: false, code: t.code, detail: t.detail }
  const given = typeof opts.title === 'string' ? opts.title.trim() : ''
  const title = given || t.template.name
  if (title.length > TITLE_MAX) return { ok: false, code: 'title_too_long', detail: null }
  const made = createWorkItem({ project_id: project.id, type: 'graphic', title, created_by: opts.createdBy ?? null })
  if (!made.ok) return { ok: false, code: made.code, detail: null }
  // The first save of a canvas writes the file and its version (see commitCanvasChange).
  const saved = commitCanvasChange(made.item, t.doc, { source: opts.source ?? 'owner', label: 'replace', actor: opts.createdBy ?? null })
  if (!saved.ok || !saved.created) {
    // The drawing could not be written (no Depot, no project folder...): no
    // empty work item stays behind, and the real reason goes back to the caller.
    setWorkItemDeleted(made.item.id, true)
    purgeWorkItem(made.item.id)
    return saved.ok ? { ok: false, code: 'template_failed', detail: null } : { ok: false, code: saved.code, detail: saved.detail }
  }
  return { ok: true, item: getWorkItem(made.item.id) ?? made.item, version: saved.created.version, template: t.template }
}
