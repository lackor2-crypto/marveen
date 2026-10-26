// #794 (Boss TG 10480, 10482): every file that arrives at a work item is read out and its content lands in the item's
// context file -- a picture (OCR), a PDF, a Word file, a plain text file. A file that cannot be read is NAMED as unread.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder } from '../workbench-assets.js'
import { tesseractAvailable } from '../life-inbox-systools.js'
import { extractFile, extractionBlockLines, isOwnOutputPath, isReadableKind, readNewMaterials, splitExtraction, EXTRACT_BEGIN, EXTRACT_END } from '../workbench-upload-extract.js'
import { ensureItemContext, readItemContext, readItemMaterials } from '../workbench-item-context.js'
import { getProject } from '../projects.js'

const py = (code: string, ...args: string[]): void => {
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8', cwd: tmpdir() })
  if (r.status !== 0) throw new Error('python: ' + r.stderr)
}

// The OCR picture is drawn with Pillow; a machine without it (the CI runner) skips that one test.
const havePillow = spawnSync('python3', ['-c', 'import PIL'], { cwd: tmpdir() }).status === 0

describe('#794 uploads are read out into the context', () => {
  let depot = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-upx-'))
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => {
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']; else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  it('which files count: our own finished outputs and non-text kinds do not', () => {
    expect(isReadableKind('a.PNG')).toBe(true)
    expect(isReadableKind('a.docx')).toBe(true)
    expect(isReadableKind('a.mp4')).toBe(false)
    expect(isOwnOutputPath('Elkészített anyagok/x.pdf')).toBe(true)
    expect(isOwnOutputPath('Finished materials/x.pdf')).toBe(true)
    expect(isOwnOutputPath('Mellékletek/x.pdf')).toBe(false)
  })

  it('reads text and a Word file; an empty one is reported, never silently skipped', async () => {
    writeFileSync(join(depot, 'note.md'), '# Bescheid\n\nZeit: 13:30-13:50\n')
    const t = await extractFile(join(depot, 'note.md'))
    expect(t).toMatchObject({ ok: true, method: 'text' })
    expect((t as { text: string }).text).toContain('13:30-13:50')
    py('import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("word/document.xml","<w:document><w:body><w:p><w:r><w:t>Sehr geehrte &amp; Frau</w:t></w:r></w:p><w:p><w:r><w:t>Betrag 120,00 EUR</w:t></w:r></w:p></w:body></w:document>")\nz.close()', join(depot, 'brief.docx'))
    const w = await extractFile(join(depot, 'brief.docx'))
    expect(w).toMatchObject({ ok: true, method: 'word' })
    expect((w as { text: string }).text).toBe('Sehr geehrte & Frau\nBetrag 120,00 EUR')
    writeFileSync(join(depot, 'leer.txt'), '  \n')
    expect(await extractFile(join(depot, 'leer.txt'))).toMatchObject({ ok: false })
  })

  it.runIf(tesseractAvailable() && havePillow)('reads a picture by OCR (the fine of the Berlin letter)', async () => {
    py('import sys\nfrom PIL import Image, ImageDraw, ImageFont\nim=Image.new("RGB",(1400,200),"white")\nd=ImageDraw.Draw(im)\nd.text((30,60),"Tatzeit 13:30 bis 13:50 Uhr",fill="black",font=ImageFont.load_default(size=64))\nim.save(sys.argv[1])', join(depot, 'bussgeld.png'))
    const r = await extractFile(join(depot, 'bussgeld.png'))
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, method: 'ocr' })
    expect((r as { text: string }).text.replace(/\s+/g, ' ')).toMatch(/13:30/)
  })

  it('the block names a file that could not be read, and says what is still waiting', async () => {
    const abs = join(depot, 'kaputt.pdf')
    writeFileSync(abs, 'this is not a pdf')
    writeFileSync(join(depot, 'ok.txt'), 'Aktenzeichen 4711')
    initDatabase(':memory:')
    const files = [{ rel: 'kaputt.pdf', abs }, { rel: 'ok.txt', abs: join(depot, 'ok.txt') }]
    const before = extractionBlockLines('item-x', files)
    expect(before.join('\n')).toMatch(/2 (fájl|file)/)
    expect(await readNewMaterials('item-x', files)).toBe(2)
    const block = extractionBlockLines('item-x', files).join('\n')
    expect(block).toContain('### ok.txt')
    expect(block).toContain('Aktenzeichen 4711')
    expect(block).toMatch(/### kaputt\.pdf\n⚠ (Nem sikerült kiolvasni|Could not be read out)/)
    // read once: a second call does nothing until the file changes
    expect(await readNewMaterials('item-x', files)).toBe(0)
    writeFileSync(join(depot, 'ok.txt'), 'Aktenzeichen 4712 geaendert')
    expect(await readNewMaterials('item-x', files)).toBe(1)
    expect(extractionBlockLines('item-x', files).join('\n')).toContain('4712')
    const s = splitExtraction(`notes\n${extractionBlockLines('item-x', files).join('\n')}\nmore`)
    expect(s.rest).toBe('notes\n\nmore')
    expect(s.extraction).toContain('4712')
  })

  it('end to end: an upload next to the item lands in its context file; the file the pass made is never read back', async () => {
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Levél Berlin', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    const project = getProject(p.project.id)!
    const made = ensureWorkItemFolder(w.item)
    expect(made.ok).toBe(true)
    const item = getWorkItem(w.item.id)!
    const ctx = ensureItemContext(item, project)
    expect(ctx.rel).toBeTruthy()
    const dir = join(depot, ctx.rel!.split('/').slice(0, -1).join('/'))
    mkdirSync(join(dir, 'Mellékletek'), { recursive: true })
    writeFileSync(join(dir, 'Mellékletek', 'bescheid.txt'), 'Tatzeit: 13:30-13:50')
    expect(await readItemMaterials(item, project)).toBe(1)
    const cf = readItemContext(item)!
    expect(cf.text).toContain(EXTRACT_BEGIN)
    expect(cf.text).toContain(EXTRACT_END)
    expect(cf.text).toContain('Mellékletek/bescheid.txt')
    expect(cf.text).toContain('Tatzeit: 13:30-13:50')
    // the pass writes the context file itself: it is not one of the materials, so the second call reads nothing
    expect(await readItemMaterials(item, project)).toBe(0)
    expect(readFileSync(join(depot, ctx.rel!), 'utf8')).not.toMatch(/### Kontextus/)
  })
})
