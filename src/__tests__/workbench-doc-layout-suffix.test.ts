// #508: a picture or table block on a document page can carry a size/alignment suffix
// (`foto.jpg#w=50&a=l`, a table's last line `#w=50&a=l`). That suffix is storage, so every
// reader of the block text has to look past it: the content fingerprint (a replaced photo is
// new content), the translation (the model never sees it, the translated table keeps it), the
// Markdown mirror and the outline list in the classic view.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addSection, addBlock, updateBlock } from '../workbench-docmodel.js'
import { contentHash } from '../workbench-docfinal.js'
import { buildTranslatePrompt, parseTranslation } from '../workbench-doclang-translate.js'
import { outlineMarkdown } from '../workbench-docmirror.js'

function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(33 + pad)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

describe('size/alignment suffix on document blocks', () => {
  let depot = ''
  let itemId = ''
  const upl = () => join(depot, 'Projektek', 'Iroda', 'Feltöltések')
  const PIC = 'Projektek/Iroda/Feltöltések/a.png'

  beforeEach(() => {
    initDatabase(':memory:')
    depot = realpathSync(mkdtempSync(join(tmpdir(), 'marveen-doclayout-')))
    mkdirSync(upl(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Hianypotlas', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('a replaced photo changes the fingerprint, also after the picture was resized', () => {
    writeFileSync(join(upl(), 'a.png'), png(10, 20))
    const s = addSection(itemId, '1. Foto')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { kind: 'image', text: PIC, author: 'owner' })
    if (!b.ok) throw new Error('blokk')
    expect(updateBlock(itemId, b.block.id, { text: `${PIC}#w=50&a=l`, author: 'owner' }).ok).toBe(true)
    const before = contentHash(getWorkItem(itemId)!)
    expect(contentHash(getWorkItem(itemId)!)).toBe(before)
    writeFileSync(join(upl(), 'a.png'), png(10, 20, 500))
    expect(contentHash(getWorkItem(itemId)!)).not.toBe(before)
  })

  it('translation: the model never sees a table\'s size line, the translated table gets the original\'s back', () => {
    const src = [
      { id: 't1', kind: 'table', text: 'Tétel | Összeg\nBérleti díj | 100 000 Ft\n#w=50&a=r', claims: [] },
      { id: 't2', kind: 'table', text: 'A | B\n1 | 2', claims: [] },
    ]
    const p = buildTranslatePrompt({ targetLang: 'de', title: 'Költségek', blocks: src, glossary: [] })
    expect(p.user).not.toContain('#w=')
    expect(p.user).toContain('Bérleti díj | 100 000 Ft')

    // The model wrote no layout line (it never saw one): the original's goes back on.
    const r = parseTranslation(JSON.stringify({ title: 'Kosten', blocks: [
      { id: 't1', text: 'Posten | Betrag\nMiete | 100 000 Ft' },
      { id: 't2', text: 'A | B\n1 | 2' },
    ] }), src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.blocks[0]!.text).toBe('Posten | Betrag\nMiete | 100 000 Ft\n#w=50&a=r')
    expect(r.blocks[1]!.text).toBe('A | B\n1 | 2')

    // A layout line the model made up anyway does not survive: the original's stands.
    const r2 = parseTranslation(JSON.stringify({ title: 'Kosten', blocks: [
      { id: 't1', text: 'Posten | Betrag\nMiete | 100 000 Ft\n#w=90&a=l' },
      { id: 't2', text: 'A | B\n1 | 2\n#w=30&a=l' },
    ] }), src)
    expect(r2.ok && r2.blocks.map((b) => b.text)).toEqual(['Posten | Betrag\nMiete | 100 000 Ft\n#w=50&a=r', 'A | B\n1 | 2'])

    // An empty translated table stays an error: the original's layout line does not make it "not empty".
    const r3 = parseTranslation(JSON.stringify({ title: 'Kosten', blocks: [{ id: 't1', text: '' }, { id: 't2', text: 'A | B' }] }), src)
    expect(r3.ok).toBe(false)
  })

  it('Markdown mirror: a picture is a picture link, a table has no size line', () => {
    writeFileSync(join(upl(), 'a.png'), png(10, 20))
    const s = addSection(itemId, '1. Foto')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { kind: 'image', text: `${PIC}#w=40&a=r`, author: 'owner' })
    addBlock(itemId, s.section.id, { kind: 'table', text: 'A | B\n1 | 2\n#w=50&a=l', author: 'owner' })
    const item = getWorkItem(itemId)!
    const dir = join(depot, 'Projektek', 'Iroda', 'Hianypotlas')
    const md = outlineMarkdown(item, dir)
    expect(md).not.toContain('#w=')
    expect(md).toContain('![a.png](<../Feltöltések/a.png>)')
    expect(md).toContain('A | B\n1 | 2\n')
    // Without the target folder the link is the path under the Marveen folder.
    expect(outlineMarkdown(item)).toContain(`![a.png](<${PIC}>)`)
  })
})

describe('outline list in the classic view (frontend source)', () => {
  const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  it('shows a picture as a picture and a table without its size line; editing a table keeps its size', () => {
    expect(js).toContain("'<div class=\"wb-outline-text\">' + outlineBlockBodyHtml(b) + '</div>'")
    expect(js).not.toContain("'<div class=\"wb-outline-text\">' + blockTextHtml(b.text) + '</div>'\n          + (b.owner_edited_at")
    const edit = js.slice(js.indexOf("a === 'outline-block-edit'"), js.indexOf("a === 'outline-rewrite-ask'"))
    expect(edit).toContain('dpBlockShown(b)')
    expect(edit).toContain('dpTableText(')
  })
})
