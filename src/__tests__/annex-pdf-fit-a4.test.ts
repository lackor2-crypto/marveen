import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fitPdfToA4, pageFitsA4, parsePdfPageSizes } from '../workbench-docpackage.js'

function hasPoppler(): boolean {
  try { execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); execFileSync('pdftocairo', ['-v'], { stdio: 'ignore' }); return true } catch { return false }
}

/** A minimal PDF with the given page sizes (points). */
function makePdf(sizes: Array<[number, number]>): Buffer {
  const objs: string[] = []
  const kids = sizes.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${sizes.length} >>`)
  sizes.forEach(([w, h], i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${4 + i * 2} 0 R >>`)
    const body = `0 0 ${w} ${h} re S`
    objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('#882 PDF annex pages are fitted to A4', () => {
  it('pageFitsA4: A4 and A5 fit, A3 does not, in both orientations', () => {
    expect(pageFitsA4(595.3, 841.9)).toBe(true)
    expect(pageFitsA4(841.9, 595.3)).toBe(true)
    expect(pageFitsA4(420, 595)).toBe(true)
    expect(pageFitsA4(841.92, 1191.12)).toBe(false)
  })
  it('parsePdfPageSizes reads the pdfinfo page lines in order', () => {
    const s = parsePdfPageSizes('Pages: 2\nPage    1 size: 595.304 x 841.89 pts (A4)\nPage    2 size: 841.92 x 1191.12 pts (A3)\n')
    expect(s).toEqual([{ w: 595.304, h: 841.89 }, { w: 841.92, h: 1191.12 }])
  })
  it.skipIf(!hasPoppler())('scales A3 pages onto A4, keeps A4 pages, keeps the page count', async () => {
    const src = makePdf([[595, 842], [842, 1191], [1191, 842]])
    const r = await fitPdfToA4(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = mkdtempSync(join(tmpdir(), 'fit-test-'))
    try {
      const f = join(dir, 'o.pdf'); writeFileSync(f, r.pdf)
      const sizes = parsePdfPageSizes(execFileSync('pdfinfo', ['-f', '1', '-l', '9', f]).toString())
      expect(sizes.length).toBe(3)
      for (const z of sizes) expect(pageFitsA4(z.w, z.h)).toBe(true)
      expect(sizes[2]!.w).toBeGreaterThan(sizes[2]!.h) // landscape stays landscape
      expect(readFileSync(f).length).toBeGreaterThan(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it.skipIf(!hasPoppler())('a PDF that is already A4 comes back untouched', async () => {
    const src = makePdf([[595, 842]])
    const r = await fitPdfToA4(src)
    expect(r.ok && r.pdf === src).toBe(true)
  })

  it('leaves a file whose page sizes cannot be read unchanged (the package is not failed by the size check)', async () => {
    const odd = Buffer.from('%PDF-1.4 not a real pdf')
    const r = await fitPdfToA4(odd)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.pdf.equals(odd)).toBe(true)
  })
})
