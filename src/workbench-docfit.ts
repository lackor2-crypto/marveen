/**
 * #856 (Boss, TG 4844/4848): a language version must fit in as many pages as the original ("ha az eredeti munkadarab
 * haromoldalas, akkor a forditast is haromoldalban kelljen megoldani"). The text of the translation is NEVER changed for
 * that: the tightening happens when the document is drawn (preview, page lines, draft, final PDF), in steps, the gentlest
 * first, until the page count of the original is reached:
 *   1  runs of more than two blank lines are cut to two
 *   2  blank lines are drawn at half height
 *   3  the body text is a little smaller (11.5 pt), 4 (11 pt), 5 (10.5 pt)
 * The step that fits is stored per language version (`wb_doc_fit`), so every drawing of that version uses the same one.
 */
import { getDb } from './db.js'
import { isBlankLine } from './workbench-docmodel.js'
import type { RenderOutline } from './workbench-docrender.js'

export const FIT_MAX_LEVEL = 5
/** Body font size per step (the default is 12 pt). */
export const FIT_BODY_PT: Record<number, number> = { 3: 11.5, 4: 11, 5: 10.5 }

export interface FitRow { work_item_id: string; hash: string; level: number; source_pages: number; pages: number; fits: number; updated_at: number }

// Per database handle, not per process: a test (or a restored backup) opens a fresh database under the same module.
const ready = new WeakSet<object>()
function ensure(): void {
  const db = getDb()
  if (ready.has(db)) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_fit (
      work_item_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      level INTEGER NOT NULL,
      source_pages INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      fits INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  ready.add(db)
}

/** The stored fit of a language version, or null when none was measured. */
export function fitOf(itemId: string): FitRow | null {
  ensure()
  return (getDb().prepare('SELECT * FROM wb_doc_fit WHERE work_item_id = ?').get(itemId) as FitRow | undefined) ?? null
}

export function fitLevelFor(itemId: string): number {
  const r = fitOf(itemId)
  return r && r.level > 0 && r.level <= FIT_MAX_LEVEL ? r.level : 0
}

export function saveFit(itemId: string, v: { hash: string; level: number; source_pages: number; pages: number; fits: boolean }): void {
  ensure()
  getDb().prepare(`INSERT INTO wb_doc_fit (work_item_id, hash, level, source_pages, pages, fits, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET hash = excluded.hash, level = excluded.level, source_pages = excluded.source_pages, pages = excluded.pages, fits = excluded.fits, updated_at = excluded.updated_at`)
    .run(itemId, v.hash, v.level, v.source_pages, v.pages, v.fits ? 1 : 0, Date.now())
}

/** Pure: the outline drawn at a tightening step (0 = as written). The blocks and their text are never touched, only how they are drawn. */
export function tightenOutline(outline: RenderOutline, level: number): RenderOutline {
  if (!(level > 0)) return outline
  const sections = outline.sections.map((s) => {
    let run = 0
    const blocks = s.blocks.flatMap((b) => {
      const blank = b.kind === 'paragraph' && isBlankLine(b.text)
      run = blank ? run + 1 : 0
      if (!blank) return [b]
      if (run > 2) return []
      return level >= 2 ? [{ ...b, pfmt: { ...(b.pfmt ?? {}), ls: 0.5 } }] : [b]
    })
    return { ...s, blocks }
  })
  const pt = FIT_BODY_PT[level]
  return { ...outline, sections, ...(pt ? { bodyPt: pt } : {}) }
}
