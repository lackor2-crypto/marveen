// #455: a document work item's outline is mirrored into a real file in its
// folder, so Windows Explorer shows it. The file is a mirror: a hand-edited copy
// is never overwritten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { mirrorOutlineToFile, outlineMarkdown } from '../workbench-docmirror.js'
import { getWorkItem } from '../workbench.js'

let pid = ''
let dir = ''

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-mirror-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Robotok' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Robotok' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Robotok'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function docItem(): string {
  const r = createWorkItem({ project_id: pid, title: 'Box szignal optimalizalasa', type: 'note' })
  if (!r.ok) throw new Error('create: ' + r.code)
  return r.item.id
}
function fill(id: string, text: string): void {
  const s = addSection(id, 'Bevezeto')
  if (!s.ok) throw new Error('section')
  const b = addBlock(id, s.section.id, { kind: 'paragraph', text, author: 'owner' })
  if (!b.ok) throw new Error('block')
}
function filesIn(folderRel: string): string[] {
  // files only: the item folder always has its (empty) Mellekletek subfolder (#618)
  return readdirSync(join(dir, 'Projektek', 'Robotok', ...folderRel.split('/')), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
}

/** The PDF twin: inside the item folder's finished-documents subfolder (named after the app language). */
function pdfOf(folder: string): string {
  const base = join(dir, 'Projektek', 'Robotok', ...folder.split('/'))
  const sub = ['Elk\u00e9sz\u00edtett anyagok', 'Finished materials'].find((n) => existsSync(join(base, n))) ?? 'Elk\u00e9sz\u00edtett anyagok'
  return join(base, sub, 'Box szignal optimalizalasa.pdf')
}

describe('outline mirror file', () => {
  it('an empty outline writes nothing and creates no folder', async () => {
    const id = docItem()
    expect(await mirrorOutlineToFile(id)).toMatchObject({ ok: false, code: 'empty' })
    expect(getWorkItem(id)!.folder ?? null).toBeNull()
  })

  it('a plain document writes NO copy into the item folder (Boss 2026-11-01: only Kontextus / Teendo may live there)', async () => {
    const id = docItem()
    fill(id, 'Elso szoveg')
    const r = await mirrorOutlineToFile(id)
    expect(r).toMatchObject({ ok: true, written: false })
    expect(getWorkItem(id)!.folder ?? null).toBeNull()
    expect(existsSync(join(dir, 'Projektek', 'Robotok', 'Box szignal optimalizalasa.docx'))).toBe(false)
  })

  it('markdown fallback carries title, section and text', () => {
    const id = docItem()
    fill(id, 'Elso szoveg')
    const md = outlineMarkdown(getWorkItem(id)!)
    expect(md).toContain('# Box szignal optimalizalasa')
    expect(md).toContain('## Bevezeto')
    expect(md).toContain('Elso szoveg')
  })
})
