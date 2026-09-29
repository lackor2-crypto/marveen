// #441 (v4 spec 1/A, K-1.25): a beadvany es a mellekletei egy PDF-ben vagy kulon
// fajlokban, mindegyik melleklet elott boritolappal ("K1. melleklet").
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { addAnnex, annexPdfKind, setDocSettings } from '../workbench-docannex.js'
import { contentHash } from '../workbench-docfinal.js'
import { annexContentPdf, coverText, mergePdfs } from '../workbench-docpackage.js'
import { buildCoverFodt, buildTextFodt } from '../workbench-docrender.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

/** Hamis LibreOffice: a PDF-be beirja a forras nevet (igy latszik, mi hova kerult). */
const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""; src=""; filter=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  if [ "$prev" = "--convert-to" ]; then filter="$a"; fi
  prev="$a"; src="$a"
done
case "$src" in *.fodt) body=$(grep -o 'CoverLabel">[^<]*' "$src" | head -1; grep -o 'Heading_20_1" text:outline-level="1">[^<]*' "$src" | head -1) ;; *) body=$(basename "$src") ;; esac
printf '%%PDF-1.4 [%s] %s\\n' "$body" "$filter" > "$out/doc.pdf"
exit 0
`
/** Hamis pdfunite: a bemeneteket egymas utan irja a kimenetbe. */
const FAKE_PDFUNITE = `#!/bin/sh
out=""; for a in "$@"; do out="$a"; done
: > "$out"
for a in "$@"; do [ "$a" = "$out" ] || { cat "$a" >> "$out"; printf '\\n--\\n' >> "$out"; }; done
exit 0
`

describe('mellekletek a PDF-ben', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const resolve = (p: string) => resolveProjectFile(project, p)
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docpkg-'))
    mkdirSync(join(projDir(), 'Iratok'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE', 'MARVEEN_PDFUNITE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    for (const [name, body, env] of [['soffice.sh', FAKE_SOFFICE, 'MARVEEN_SOFFICE'], ['pdfunite.sh', FAKE_PDFUNITE, 'MARVEEN_PDFUNITE']] as const) {
      const f = join(depot, name)
      writeFileSync(f, body, 'utf-8')
      chmodSync(f, 0o755)
      process.env[env] = f
    }
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Iratok', 'szerzodes.pdf'), '%PDF-1.4 SZERZODES-TARTALOM')
    writeFileSync(join(projDir(), 'Iratok', 'foto.jpg'), 'JPEG')
    writeFileSync(join(projDir(), 'Iratok', 'jegyzet.txt'), 'Első sor\nMásodik sor <&>')
    writeFileSync(join(projDir(), 'Iratok', 'level.eml'), 'From: x')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  function readyWithAnnexes(): void {
    const s = addSection(itemId, '1. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'A szerződés K1, a fénykép K2 alatt csatolva.', author: 'agent' })
    for (const [path, title] of [['Iratok/szerzodes.pdf', 'Bérleti szerződés'], ['Iratok/foto.jpg', 'Fénykép a lakásról']]) {
      const r = addAnnex(itemId, { path, title }, resolve, 'teszt')
      if (!r.ok) throw new Error(r.detail)
    }
  }

  it('melyik fajlbol lehet mellekleti PDF', () => {
    expect(['a.pdf', 'b.docx', 'c.JPG', 'd.png', 'e.txt', 'f.md', 'g.eml', 'h.heic', 'i.mp3'].map(annexPdfKind))
      .toEqual(['pdf', 'office', 'image', 'image', 'text', 'text', null, null, null])
    expect(coverText('k', 'K1')).toBe('K1. melléklet')
    expect(coverText('anlage', 'Anlage K1')).toBe('Anlage K1')
    expect(coverText('exhibit', 'Exhibit A')).toBe('Exhibit A')
    expect(buildCoverFodt('K1. melléklet', 'Bérleti <szerződés>', 'hu')).toContain('<text:p text:style-name="CoverTitle">Bérleti &lt;szerződés&gt;</text:p>')
    expect(buildTextFodt('a\r\nb  c', 'x.txt')).toContain('<text:p text:style-name="Plain">b <text:s text:c="1"/>c</text:p>')
  })

  it('a melleklet tartalma: PDF valtozatlanul, kep es irodai fajl a LibreOffice-on at, szoveg a sajat keszitonkkel', async () => {
    const pdf = await annexContentPdf(join(projDir(), 'Iratok', 'szerzodes.pdf'), 'szerzodes.pdf')
    expect(pdf.ok && pdf.pdf.toString()).toBe('%PDF-1.4 SZERZODES-TARTALOM')
    const img = await annexContentPdf(join(projDir(), 'Iratok', 'foto.jpg'), 'foto.jpg')
    expect(img.ok && img.pdf.toString()).toContain('[foto.jpg]')
    const txt = await annexContentPdf(join(projDir(), 'Iratok', 'jegyzet.txt'), 'jegyzet.txt')
    expect(txt.ok).toBe(true)
    const eml = await annexContentPdf(join(projDir(), 'Iratok', 'level.eml'), 'level.eml')
    expect(eml).toMatchObject({ ok: false, code: 'annex_unsupported' })
  })

  it('piszkozat: a beadvany utan minden melleklet boritolappal, egy PDF-ben', async () => {
    readyWithAnnexes()
    const r = await callWorkbench(`/api/workbench/items/${itemId}/outline/pdf`, 'GET')
    expect(r.status).toBe(200)
    const body = r.raw.toString('utf-8')
    const order = ['1. Tényállás', 'K1. melléklet', 'SZERZODES-TARTALOM', 'K2. melléklet', '[foto.jpg]'].map((x) => body.indexOf(x))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('vegleges, kulon mod: a beadvany PDF/A + mellekletenkent egy PDF a mappaban; kozos mod: egy PDF', async () => {
    readyWithAnnexes()
    const base = `/api/workbench/items/${itemId}/outline`
    const hash = (await callWorkbench(base, 'GET')).body.outline.content_hash
    await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin.status).toBe(200)
    const files = fin.body.final.files as { path: string; name: string; role: string; label?: string }[]
    expect(files.map((f) => [f.role, f.label ?? null])).toEqual([['main', null], ['annex', 'K1'], ['annex', 'K2']])
    expect(files[1]!.name).toBe('K1 – Bérleti szerződés.pdf')
    expect(fin.body.final.annex_mode).toBe('separate')
    expect(fin.body.final.pdfa).toBe(true)
    const main = readFileSync(join(depot, files[0]!.path), 'utf-8')
    expect(main).toContain('SelectPdfVersion')
    expect(main).not.toContain('SZERZODES-TARTALOM')
    const k1 = readFileSync(join(depot, files[1]!.path), 'utf-8')
    expect(k1.indexOf('K1. melléklet')).toBeLessThan(k1.indexOf('SZERZODES-TARTALOM'))

    // Kozos mod: a beallitas a tartalmat nem valtoztatja, de a kovetkezo veglegesites egy fajlt ad.
    setDocSettings(itemId, { annex_mode: 'combined' })
    const hash2 = (await callWorkbench(base, 'GET')).body.outline.content_hash
    expect(hash2).toBe(hash)
    const fin2 = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin2.status).toBe(200)
    expect(fin2.body.final.files.map((f: { role: string }) => f.role)).toEqual(['bundle'])
    expect(fin2.body.final.pdfa).toBe(false)
    const all = readFileSync(join(depot, fin2.body.final.files[0].path), 'utf-8')
    expect(all.indexOf('1. Tényállás')).toBeLessThan(all.indexOf('K2. melléklet'))
  })

  it('kicserelt mellekletfajl: uj ujjlenyomat, ujra at kell nezni', () => {
    readyWithAnnexes()
    const item = getWorkItem(itemId)
    if (!item) throw new Error('munkadarab')
    const h1 = contentHash(item)
    const f = join(projDir(), 'Iratok', 'szerzodes.pdf')
    writeFileSync(f, '%PDF-1.4 MASIK SZERZODES, HOSSZABB')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect(contentHash(item)).not.toBe(h1)
  })

  it('nem atalakithato melleklet: az ellenorzes megallit, a piszkozat megnevezi a mellekletet', async () => {
    readyWithAnnexes()
    const r = addAnnex(itemId, { path: 'Iratok/level.eml', title: 'Levél' }, resolve, 'teszt')
    expect(r.ok).toBe(true)
    const o = await callWorkbench(`/api/workbench/items/${itemId}/outline`, 'GET')
    expect(o.body.outline.check.items.find((i: { key: string }) => i.key === 'annex_unsupported')).toMatchObject({ ok: false, detail: ['K3'] })
    const d = await callWorkbench(`/api/workbench/items/${itemId}/outline/pdf`, 'GET')
    expect(d.status).toBe(409)
    expect(d.body.error).toBe('docpdf_annex_unsupported')
    expect(d.body.message).toContain('K3')
  })

  it('pdfunite nelkul: emberi mondat a telepitessel; mellekletek nelkul a PDF enelkul is elkeszul', async () => {
    process.env['MARVEEN_PDFUNITE'] = join(depot, 'nincs-ilyen-pdfunite')
    const s = addSection(itemId, 'Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Szöveg.', author: 'agent' })
    const plain = await callWorkbench(`/api/workbench/items/${itemId}/outline/pdf`, 'GET')
    expect(plain.status).toBe(200)
    addAnnex(itemId, { path: 'Iratok/szerzodes.pdf', title: 'Szerződés' }, resolve, 'teszt')
    const d = await callWorkbench(`/api/workbench/items/${itemId}/outline/pdf`, 'GET')
    expect(d.status).toBe(501)
    expect(d.body.error).toBe('docpdf_merge_not_installed')
    expect(d.body.message).toContain('poppler-utils')
  })
})

const HAS_TOOLS = ['soffice', 'pdfunite', 'pdfinfo', 'pdftotext'].every((c) => spawnSync(c, [c === 'soffice' ? '--version' : '-v'], { encoding: 'utf-8' }).error === undefined)

describe.skipIf(!HAS_TOOLS)('valodi LibreOffice-szal es pdfunite-tal', () => {
  const saved: Record<string, string | undefined> = {}
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marveen-docpkg-real-'))
    for (const k of ['MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE', 'MARVEEN_PDFUNITE']) saved[k] = process.env[k]
    delete process.env['MARVEEN_SOFFICE']
    delete process.env['MARVEEN_PDFUNITE']
    process.env['MARVEEN_RENDER_CACHE'] = join(dir, 'cache')
    resetLibreOfficeProbe()
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(dir, { recursive: true, force: true })
  })

  it('szoveges melleklet + boritolap egyesitve: a lapszam es a szoveg a helyen', async () => {
    const txt = join(dir, 'jegyzet.txt')
    writeFileSync(txt, 'Ez a melléklet szövege.\nMásodik sor.')
    const content = await annexContentPdf(txt, 'jegyzet.txt')
    expect(content.ok).toBe(true)
    if (!content.ok) return
    const { renderFodtPdf, PDF_FILTER_DRAFT } = await import('../workbench-docrender.js')
    const cover = await renderFodtPdf(buildCoverFodt('K1. melléklet', 'Jegyzet', 'hu'), PDF_FILTER_DRAFT)
    expect(cover.ok).toBe(true)
    if (!cover.ok) return
    const merged = await mergePdfs([cover.pdf, content.pdf])
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    const out = join(dir, 'k1.pdf')
    writeFileSync(out, merged.pdf)
    expect(spawnSync('pdfinfo', [out], { encoding: 'utf-8' }).stdout).toMatch(/Pages:\s+2/)
    const text = spawnSync('pdftotext', ['-layout', out, '-'], { encoding: 'utf-8' }).stdout
    expect(text.indexOf('K1. melléklet')).toBeLessThan(text.indexOf('Ez a melléklet szövege.'))
  }, 180_000)
})
