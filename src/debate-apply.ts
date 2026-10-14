// "Apply" of a finished review debate (#597, phase 4): the changes the defender agreed to, written into a document.
//
// Three rules keep it safe (Boss 2026-10-14):
//   1. Nothing is written by itself. The panel asks for a PREVIEW first (`previewChanges`): the old and the new text
//      of every change, and the owner ticks the ones to take over.
//   2. Only what is ticked is written, and only where the quoted words are found in exactly ONE place of the
//      document -- a quote found nowhere, or in several places, is shown as "not found" and left alone.
//   3. All of it is ONE new step of the document's history (workbench-dochistory.ts), so Undo gives it back at once.
//
// The matching and the preview are pure; `applyChanges` is the only part that touches the document.

import type { BoardItem } from './debate-board.js'
import type { ObjectionKind } from './debate-modes.js'
import { addBlock, listBlocks, listSections, updateBlock, type BlockKind } from './workbench-docmodel.js'
import { beginDocStep, settleDocStep } from './workbench-dochistory.js'

/** Blocks whose words the debate may change. Tables, signatures and pictures are not prose. */
export const EDITABLE_KINDS: readonly BlockKind[] = ['paragraph', 'list', 'footnote']
const CONTEXT_CHARS = 70

export interface ApplyChange {
  id: string
  kind: ObjectionKind | null
  quote: string
  rewrite: string
  status: 'accepted' | 'partial'
}

/** The board lines that can become an edit: the defender accepted (fully or in part), offered a wording, and the critic quoted the place. */
export function applicableChanges(board: readonly BoardItem[]): ApplyChange[] {
  const out: ApplyChange[] = []
  for (const it of board) {
    if ((it.status !== 'accepted' && it.status !== 'partial') || !it.rewrite.trim() || !it.quote.trim()) continue
    out.push({ id: it.id, kind: it.kind, quote: it.quote.trim(), rewrite: it.rewrite.trim(), status: it.status })
  }
  return out
}

export interface DocBlockIn { id: string; kind: string; text: string; section_id: string; position: number }

export type PreviewState = 'ready' | 'not_found' | 'ambiguous' | 'not_text'

export interface ChangePreview {
  id: string
  kind: ObjectionKind | null
  status: 'accepted' | 'partial'
  /** replace = the quoted words are replaced; insert = the wording is a new paragraph after the quoted place (a missing part). */
  action: 'replace' | 'insert'
  state: PreviewState
  blockId: string | null
  sectionTitle: string
  /** The words around the change, so the owner sees it in place. */
  ctxBefore: string
  old: string
  new: string
  ctxAfter: string
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The quote as a pattern: any run of white space matches any run, straight and curly quotes and the dash kinds are the same. */
export function quotePattern(quote: string): RegExp {
  const src = [...quote.trim()].map(ch => {
    if (/\s/.test(ch)) return '\\s+'
    if (/["“”„«»]/.test(ch)) return '["\\u201C\\u201D\\u201E\\u00AB\\u00BB]'
    if (/['‘’‚]/.test(ch)) return '[\'\\u2018\\u2019\\u201A]'
    if (/[-‐-―]/.test(ch)) return '[-\\u2010-\\u2015]'
    return escapeRe(ch)
  }).join('').replace(/(?:\\s\+)+/g, '\\s+')
  return new RegExp(src, 'g')
}

function occurrences(text: string, re: RegExp): { index: number; len: number }[] {
  const out: { index: number; len: number }[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue }
    out.push({ index: m.index, len: m[0].length })
  }
  return out
}

/** For every change: where it would land and what the text would be -- or why it cannot. */
export function previewChanges(blocks: readonly DocBlockIn[], sectionTitles: ReadonlyMap<string, string>, changes: readonly ApplyChange[]): ChangePreview[] {
  return changes.map(c => {
    const action: 'replace' | 'insert' = c.kind === 'missing' ? 'insert' : 'replace'
    const base: ChangePreview = {
      id: c.id, kind: c.kind, status: c.status, action, state: 'not_found', blockId: null, sectionTitle: '',
      ctxBefore: '', old: '', new: c.rewrite, ctxAfter: '',
    }
    const re = quotePattern(c.quote)
    const hits: { block: DocBlockIn; index: number; len: number }[] = []
    for (const b of blocks) for (const h of occurrences(b.text, re)) hits.push({ block: b, ...h })
    if (!hits.length) return base
    if (hits.length > 1) return { ...base, state: 'ambiguous' }
    const { block, index, len } = hits[0]
    const common = { blockId: block.id, sectionTitle: sectionTitles.get(block.section_id) ?? '' }
    if (!EDITABLE_KINDS.includes(block.kind as BlockKind)) return { ...base, ...common, state: 'not_text' }
    const ctxBefore = block.text.slice(Math.max(0, index - CONTEXT_CHARS), index)
    const ctxAfter = block.text.slice(index + len, index + len + CONTEXT_CHARS)
    const old = block.text.slice(index, index + len)
    return { ...base, ...common, state: 'ready', ctxBefore, old: action === 'replace' ? old : '', ctxAfter: action === 'replace' ? ctxAfter : '' }
  })
}

export interface ApplyResult {
  applied: string[]
  skipped: { id: string; reason: 'not_ticked' | PreviewState | 'failed' }[]
}

function currentView(itemId: string): { blocks: DocBlockIn[]; titles: Map<string, string> } {
  return {
    blocks: listBlocks(itemId).map(b => ({ id: b.id, kind: b.kind, text: b.text, section_id: b.section_id, position: b.position })),
    titles: new Map(listSections(itemId).map(s => [s.id, s.title])),
  }
}

/** The preview of a debate's changes against the document as it is now. */
export function previewForItem(itemId: string, changes: readonly ApplyChange[]): ChangePreview[] {
  const v = currentView(itemId)
  return previewChanges(v.blocks, v.titles, changes)
}

/**
 * Writes the ticked changes as one history step. Each one is looked up again against the document AS IT IS at that
 * moment (an earlier change of the same run may have touched the same paragraph), and is skipped when it no longer
 * lands in exactly one place.
 */
export function applyChanges(itemId: string, changes: readonly ApplyChange[], tickedIds: ReadonlySet<string>): ApplyResult {
  const result: ApplyResult = { applied: [], skipped: [] }
  const ticked = changes.filter(c => tickedIds.has(c.id))
  for (const c of changes) if (!tickedIds.has(c.id)) result.skipped.push({ id: c.id, reason: 'not_ticked' })
  if (!ticked.length) return result
  beginDocStep(itemId, 'debate_apply')
  try {
    for (const c of ticked) {
      const v = currentView(itemId)
      const p = previewChanges(v.blocks, v.titles, [c])[0]
      if (p.state !== 'ready' || !p.blockId) { result.skipped.push({ id: c.id, reason: p.state }); continue }
      const block = v.blocks.find(b => b.id === p.blockId)
      if (!block) { result.skipped.push({ id: c.id, reason: 'failed' }); continue }
      if (p.action === 'replace') {
        const re = quotePattern(c.quote)
        const next = block.text.replace(re, () => c.rewrite)
        const r = updateBlock(itemId, block.id, { text: next, author: 'owner' })
        if (r.ok) result.applied.push(c.id)
        else result.skipped.push({ id: c.id, reason: 'failed' })
      } else {
        const r = addBlock(itemId, block.section_id, { kind: 'paragraph', text: c.rewrite, position: block.position + 1, author: 'owner' })
        if (r.ok) result.applied.push(c.id)
        else result.skipped.push({ id: c.id, reason: 'failed' })
      }
    }
  } finally {
    settleDocStep(itemId)
  }
  return result
}
