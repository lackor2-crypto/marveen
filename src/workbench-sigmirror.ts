// A signature picture is mirrored both ways between a document and its language versions (Boss TG 3975: "if I put it
// on the Hungarian, it goes on the translation too, and the other way round"). The side the owner just edited wins:
// its signature pictures (which picture, size, place) are copied over those of the linked section on the other side.
//
// A change is detected against what each section held when it was last mirrored (`wb_doc_sig_state`), so an edit of
// plain text never touches the other side's signature. A section never seen before counts as "unchanged" while it
// holds no signature, and as "changed" once it does -- a signature that was there before this existed is mirrored
// the first time its side is edited.
import { getDb } from './db.js'
import { addBlock, ensureDocModelTables, listBlocks, listSections, removeBlock, type BlockRow } from './workbench-docmodel.js'
import { ensureDocLangTables, isSignatureImage, listVariants, variantOf } from './workbench-doclang.js'

interface SigPiece { text: string; pos: number; align: string | null }

function ensureTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS wb_doc_sig_state (section_id TEXT PRIMARY KEY, sig TEXT NOT NULL)')
}

function sigOf(blocks: BlockRow[]): SigPiece[] {
  const out: SigPiece[] = []
  blocks.forEach((b, i) => { if (isSignatureImage(b)) out.push({ text: b.text, pos: i, align: b.align ?? null }) })
  return out
}

/** Makes the signatures of `toSection` equal to `pieces`; returns the section's signatures as they now stand. */
function applyTo(toItem: string, toSection: string, pieces: SigPiece[]): SigPiece[] {
  for (const b of listBlocks(toItem).filter((x) => x.section_id === toSection && isSignatureImage(x))) removeBlock(toItem, b.id)
  for (const p of pieces) addBlock(toItem, toSection, { kind: 'image', text: p.text, align: p.align, position: p.pos, author: 'owner' })
  return sigOf(listBlocks(toItem).filter((x) => x.section_id === toSection))
}

interface Pair { mine: string; otherItem: string; otherSection: string }

function pairsOf(itemId: string): Pair[] {
  const db = getDb()
  const v = variantOf(itemId)
  const out: Pair[] = []
  if (v) {
    for (const l of db.prepare('SELECT section_id, source_section_id FROM wb_doc_section_links WHERE work_item_id = ?').all(itemId) as { section_id: string; source_section_id: string }[]) {
      out.push({ mine: l.section_id, otherItem: v.source_item_id, otherSection: l.source_section_id })
    }
  } else {
    for (const vr of listVariants(itemId)) {
      for (const l of db.prepare('SELECT section_id, source_section_id FROM wb_doc_section_links WHERE work_item_id = ?').all(vr.work_item_id) as { section_id: string; source_section_id: string }[]) {
        out.push({ mine: l.source_section_id, otherItem: vr.work_item_id, otherSection: l.section_id })
      }
    }
  }
  return out
}

/** Call after the owner edited `itemId` (original or language version). Never throws: a mirror must not break a save. */
export function mirrorSignaturesFrom(itemId: string): void {
  try {
    ensureDocModelTables(); ensureDocLangTables(); ensureTable()
    const db = getDb()
    const mineBlocks = listBlocks(itemId)
    const sectionIds = new Set(listSections(itemId).map((s) => s.id))
    for (const pr of pairsOf(itemId)) {
      if (!sectionIds.has(pr.mine)) continue
      const cur = sigOf(mineBlocks.filter((b) => b.section_id === pr.mine))
      const curJson = JSON.stringify(cur)
      const prev = db.prepare('SELECT sig FROM wb_doc_sig_state WHERE section_id = ?').get(pr.mine) as { sig: string } | undefined
      if (prev ? prev.sig === curJson : cur.length === 0) {
        if (!prev) db.prepare('INSERT OR REPLACE INTO wb_doc_sig_state (section_id, sig) VALUES (?, ?)').run(pr.mine, curJson)
        continue
      }
      const after = applyTo(pr.otherItem, pr.otherSection, cur)
      db.prepare('INSERT OR REPLACE INTO wb_doc_sig_state (section_id, sig) VALUES (?, ?)').run(pr.mine, curJson)
      db.prepare('INSERT OR REPLACE INTO wb_doc_sig_state (section_id, sig) VALUES (?, ?)').run(pr.otherSection, JSON.stringify(after))
      // A language version's change reaches the original, and the other language versions follow the original.
      const v = variantOf(itemId)
      if (v) {
        for (const sib of listVariants(v.source_item_id)) {
          if (sib.work_item_id === itemId) continue
          const l = db.prepare('SELECT section_id FROM wb_doc_section_links WHERE work_item_id = ? AND source_section_id = ?').get(sib.work_item_id, pr.otherSection) as { section_id: string } | undefined
          if (!l) continue
          db.prepare('INSERT OR REPLACE INTO wb_doc_sig_state (section_id, sig) VALUES (?, ?)').run(l.section_id, JSON.stringify(applyTo(sib.work_item_id, l.section_id, cur)))
        }
      }
    }
  } catch { /* the save itself already succeeded */ }
}
