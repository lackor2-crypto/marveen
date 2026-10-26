/**
 * LANGUAGE VERSIONS OF A TEXT-FILE WORK ITEM (kanban #671, Boss TG 9306/9320).
 *
 * A note (.md / .txt) has no outline, but it shares the language-version DATA MODEL of the document: a version is a sibling
 * work item in the same folder, tied to the original in `wb_doc_variants` (same table, same "EN – title" naming, same
 * `variantOf` / `listVariants`). Until now the Translation view's result lived only in the browser and was lost, so the
 * finalize panel had nothing to offer. Saving it as a version makes it a real, listed, re-usable thing.
 */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { getDb } from './db.js'
import { resolveLifePath } from './life-explorer.js'
import { getProject } from './projects.js'
import { projectFileTarget, writeProjectFile } from './project-files.js'
import { createWorkItem, createWorkItemVersion, getWorkItem, type WorkItemRow } from './workbench.js'
import { assignWorkItemFolder } from './workbench-assets.js'
import { ensureDocLangTables, listVariants, liveVariantFor, variantOf, variantTitle } from './workbench-doclang.js'
import { baseNameForNextVersion, saveTextSourceAsNewVersion, subFolderOf, TEXT_SOURCE_MAX } from './workbench-edit.js'
import { fileStem } from './workbench-docfinal.js'
import { hasDocModel } from './workbench-docmodel.js'
import { adoptVariantText, outlineTextOf } from './workbench-textdoc.js'

const now = (): number => Math.floor(Date.now() / 1000)

/** A language code as the translator knows it, lower-case two letters ("en", "de"); anything else is not a code. */
export function cleanLangCode(raw: unknown): string | null {
  const c = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return /^[a-z]{2}$/.test(c) ? c : null
}

export interface TextVariantView { item_id: string; lang: string; title: string }

/** The saved language versions of a text item (the live ones), and what it is itself a version of. */
export function textLangState(item: Pick<WorkItemRow, 'id'>): { variant_of: { item_id: string; lang: string } | null; variants: TextVariantView[] } {
  ensureDocLangTables()
  const own = variantOf(item.id)
  const variants: TextVariantView[] = []
  for (const v of listVariants(item.id)) {
    const w = getWorkItem(v.work_item_id)
    if (w && !w.deleted_at) variants.push({ item_id: w.id, lang: v.lang, title: w.title })
  }
  return { variant_of: own ? { item_id: own.source_item_id, lang: own.lang } : null, variants }
}

export type TextVariantResult =
  | { ok: true; item: WorkItemRow; existing: boolean }
  | { ok: false; code: 'bad_lang' | 'bad_text' | 'variant_of_variant' | 'project_gone' | 'save_failed'; detail: string | null }

/** Saves `text` as the `lang` version of the text item: a new sibling item, or a new version of the one that exists. */
export function saveTextVariant(source: WorkItemRow, rawLang: unknown, text: string, by: string | null): TextVariantResult {
  ensureDocLangTables()
  const lang = cleanLangCode(rawLang)
  if (!lang) return { ok: false, code: 'bad_lang', detail: null }
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_SOURCE_MAX) return { ok: false, code: 'bad_text', detail: null }
  if (!source.source_path) return { ok: false, code: 'bad_text', detail: null }
  if (variantOf(source.id)) return { ok: false, code: 'variant_of_variant', detail: null }
  const project = getProject(source.project_id)
  if (!project || project.archived_at != null) return { ok: false, code: 'project_gone', detail: null }

  const hadItem = liveVariantFor(source.id, lang)?.item ?? null
  if (hadItem && hadItem.source_path) {
    const r = saveTextSourceAsNewVersion(hadItem, project, hadItem.source_path, text, { created_by: by })
    if (!r.ok) return { ok: false, code: 'save_failed', detail: r.code }
    // #673: the original is on the document page: the saved text goes into the version's chapters too (paired by position).
    if (hasDocModel(source.id)) adoptVariantText(source, r.item, text, by)
    return { ok: true, item: r.item, existing: true }
  }

  const w = createWorkItem({ project_id: source.project_id, title: variantTitle(source.title, lang), type: 'note', created_by: by, container_folder: source.container_folder ?? null })
  if (!w.ok) return { ok: false, code: 'save_failed', detail: w.code }
  if (source.folder && projectFileTarget(project, source.folder).ok) assignWorkItemFolder(w.item.id, source.folder)
  const ext = extname(source.source_path) || '.md'
  const stem = fileStem(baseNameForNextVersion(basename(source.source_path)).replace(/\.[^.]+$/, ''))
  const out = writeProjectFile(project, subFolderOf(project, source.source_path), `${stem}.${lang}${ext}`, Buffer.from(text, 'utf-8'))
  if (!out.ok) return { ok: false, code: 'save_failed', detail: out.code }
  const v = createWorkItemVersion(w.item.id, { source_path: out.rel, created_by: by, metadata_json: JSON.stringify({ edit: 'text_variant' }) })
  if (!v.ok) return { ok: false, code: 'save_failed', detail: v.code }
  getDb().prepare('INSERT OR REPLACE INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(w.item.id, source.id, lang, now(), by)
  const made = getWorkItem(w.item.id) ?? v.item
  if (hasDocModel(source.id)) adoptVariantText(source, made, text, by)
  return { ok: true, item: made, existing: false }
}

/** The text of the saved `lang` version, or null when there is none (or its file cannot be read). */
export function readTextVariant(source: Pick<WorkItemRow, 'id'>, rawLang: unknown): string | null {
  const lang = cleanLangCode(rawLang)
  if (!lang) return null
  const w = liveVariantFor(source.id, lang)?.item ?? null
  if (!w) return null
  // #673: a version that is on the document page is read from its outline (the file mirror can be a moment behind).
  const fromPage = outlineTextOf(w)
  if (fromPage != null) return fromPage
  if (!w.source_path) return null
  try {
    const abs = resolveLifePath(w.source_path)
    return abs ? readFileSync(abs, 'utf-8') : null
  } catch { return null }
}
