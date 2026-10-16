// #567 (Boss TG 8988: page numbers "alul kozepre, ilyen birosagi iratoknal oda szoktak tenni"): the page number stands
// at the bottom centre of EVERY page, in the draft, in the final PDF and in the Word file, also on a one-page letter.
// Measured 2026-10-11 on a 10-page document: draft "PISZKOZAT · n / 10 oldal", final "n / 10 oldal", Word footer
// PAGE / NUMPAGES centred -- so this pins what the pipeline already does, per language.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFodt, renderOutlineDocx, renderOutlinePdf } from '../workbench-docrender.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { rmTempDir } from './helpers/rm-temp-dir.js'

const doc = { sections: [{ title: '1.', status: 'done', blocks: [{ kind: 'paragraph', text: 'Szoveg.' }] }] } as never
const make = (draft: boolean, lang: 'hu' | 'en' | 'de', target?: 'docx'): string => buildFodt(doc, { title: 'T', author: null, draft, lang, ...(target ? { target } : {}) } as never)

describe('page number: bottom centre, every page', () => {
  it('the footer style is centred, and both master pages (first and following) carry the number and the page count', () => {
    for (const draft of [true, false]) {
      const x = make(draft, 'hu')
      expect(x).toMatch(/style:name="Footer" style:family="paragraph"[^>]*><style:paragraph-properties fo:text-align="center"\/>/)
      const masters = x.match(/<style:master-page [\s\S]*?<\/style:master-page>/g) || []
      expect(masters.length).toBe(2)
      for (const m of masters) {
        expect(m).toContain('<text:page-number text:select-page="current"/>')
        expect(m).toContain('<text:page-count/>')
        expect(m).toContain('<text:p text:style-name="Footer">')
      }
    }
  })
  it('the draft keeps its mark beside the number, the final and the Word file carry the number alone', () => {
    expect(make(true, 'hu')).toContain('PISZKOZAT · <text:page-number')
    expect(make(false, 'hu')).not.toContain('PISZKOZAT · <text:page-number')
    expect(make(false, 'hu', 'docx')).toContain('<text:p text:style-name="Footer"><text:page-number')
  })
  it('the wording follows the document language', () => {
    expect(make(false, 'hu')).toMatch(/page-count\/> oldal/)
    expect(make(false, 'en')).toMatch(/Page <text:page-number[^>]*\/> of <text:page-count\/>/)
    expect(make(false, 'de')).toMatch(/Seite <text:page-number[^>]*\/> von <text:page-count\/>/)
  })
})

// The tests above read the generated document SOURCE. This block measures what a reader gets: the real PDF of a
// multi-page document, page by page (pdftotext), and the footer of the real Word file. The final PDF and the
// German wording were not covered by any measurement before.
const HAS_TOOLS = spawnSync('soffice', ['--version'], { encoding: 'utf-8' }).status === 0
  && spawnSync('pdftotext', ['-v'], { encoding: 'utf-8' }).status === 0
  && spawnSync('unzip', ['-v'], { encoding: 'utf-8' }).status === 0

describe.skipIf(!HAS_TOOLS)('page number on the real rendered file', () => {
  const saved: Record<string, string | undefined> = {}
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marveen-pagenum-'))
    for (const k of ['MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    delete process.env['MARVEEN_SOFFICE']
    process.env['MARVEEN_RENDER_CACHE'] = join(dir, 'cache')
    resetLibreOfficeProbe()
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmTempDir(dir)
  })

  const longDoc = { sections: [{ title: '1. Tenyallas', status: 'done' as const, blocks: Array.from({ length: 14 }, () => ({ kind: 'paragraph' as const, text: 'Ez egy hosszu bekezdes a probahoz. '.repeat(60) })) }] }
  const wording = {
    hu: (n: number, all: number) => `${n} / ${all} oldal`,
    en: (n: number, all: number) => `Page ${n} of ${all}`,
    de: (n: number, all: number) => `Seite ${n} von ${all}`,
  }
  /** Per page: the last non-empty line of its text -- the footer line. */
  const footers = (pdf: Buffer, name: string): string[] => {
    const f = join(dir, name)
    writeFileSync(f, pdf)
    const pages = Number(/Pages:\s+(\d+)/.exec(spawnSync('pdfinfo', [f], { encoding: 'utf-8' }).stdout)?.[1])
    const out: string[] = []
    for (let p = 1; p <= pages; p++) {
      const t = spawnSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', f, '-'], { encoding: 'utf-8' }).stdout
      out.push(t.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '')
    }
    return out
  }

  it('every page of the draft and of the final PDF ends with its own number and the page count, in all three languages', async () => {
    for (const lang of ['hu', 'en', 'de'] as const) {
      for (const draft of [true, false]) {
        const r = await renderOutlinePdf(longDoc as never, { title: 'T', author: null, draft, lang })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        const f = footers(r.pdf, `${lang}-${draft ? 'draft' : 'final'}.pdf`)
        expect(f.length).toBeGreaterThan(2)
        const mark = draft ? { hu: 'PISZKOZAT · ', en: 'DRAFT · ', de: 'ENTWURF · ' }[lang] : ''
        f.forEach((line, i) => expect(line, `${lang} ${draft ? 'draft' : 'final'} page ${i + 1}`).toBe(mark + wording[lang](i + 1, f.length)))
      }
    }
  }, 240_000)

  it('the footer sits at the bottom centre of the page, not at a side', async () => {
    const r = await renderOutlinePdf(longDoc as never, { title: 'T', author: null, draft: false, lang: 'hu' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const f = join(dir, 'pos.pdf')
    writeFileSync(f, r.pdf)
    const bbox = spawnSync('pdftotext', ['-f', '2', '-l', '2', '-bbox', f, '-'], { encoding: 'utf-8' }).stdout
    const w = Number(/<page width="([\d.]+)"/.exec(bbox)?.[1])
    const h = Number(/<page width="[\d.]+" height="([\d.]+)"/.exec(bbox)?.[1])
    const words = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    const bottom = Math.max(...words.map((m) => Number(m[2])))
    const last = words.filter((m) => Math.abs(Number(m[2]) - bottom) < 1)
    expect(bottom).toBeGreaterThan(h * 0.9)
    expect(last.map((m) => m[5]).join(' ')).toMatch(/^2 \/ \d+ oldal$/)
    const x0 = Math.min(...last.map((m) => Number(m[1])))
    const x1 = Math.max(...last.map((m) => Number(m[3])))
    expect(Math.abs((x0 + x1) / 2 - w / 2)).toBeLessThan(w * 0.05)
  }, 180_000)

  it('the Word file has a centred PAGE / NUMPAGES footer that applies to the first page too', async () => {
    const r = await renderOutlineDocx(longDoc as never, { title: 'T', author: null, lang: 'hu' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = join(dir, 'o.docx')
    writeFileSync(p, r.docx)
    const part = (n: string): string => spawnSync('unzip', ['-p', p, n], { encoding: 'utf-8' }).stdout
    const footer = part('word/footer1.xml')
    expect(footer).toContain('<w:jc w:val="center"/>')
    expect(footer).toMatch(/instrText[^>]*> PAGE </)
    expect(footer).toMatch(/instrText[^>]*> NUMPAGES </)
    const doc = part('word/document.xml')
    expect(doc).toContain('<w:footerReference w:type="default"')
    expect(doc).not.toContain('<w:titlePg')
  }, 180_000)
})
