// #912 (the owner, TG 5986: "ha nyomok egy Entert, az maradjon is ott ... az ures sorokat is vegye siman sornak"): an empty line
// is a LINE wherever it stands in a block. This is the rule itself (one function on the server, its copy in the browser) and the
// proof that every writer of a block's text goes through it -- the recipient of a letter must never slide up beside the sender.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { blockText, canonLineParts, BLANK_LINE_CHAR as Z } from '../workbench-blanklines.js'
import { richMatches, richToPlain, sanitizeRich } from '../workbench-docrich.js'
import { enforceRecipientWindow } from '../workbench-letterhead.js'
import { buildFodt, type RenderOutline } from '../workbench-docrender.js'

const SRC = join(__dirname, '..')
const WEB = readFileSync(join(SRC, '..', 'web', 'workbench.js'), 'utf8')

describe('an empty line is a line (#912)', () => {
  it('the empty lines above, inside and below the text stay', () => {
    expect(blockText('\n\n\n\nCímzett:\nR & M GmbH\n\n\n')).toBe(`${Z}\n${Z}\n${Z}\n${Z}\nCímzett:\nR & M GmbH\n${Z}\n${Z}`)
    expect(blockText('a\n\nb')).toBe(`a\n${Z}\nb`)
    expect(blockText('a\n \t \nb')).toBe(`a\n${Z}\nb`)
    expect(blockText(`${Z}\n${Z}\nCímzett:`)).toBe(`${Z}\n${Z}\nCímzett:`)
  })

  it('a text with no empty line is what it was: outer spaces go, one closing line break is not a line', () => {
    expect(blockText('  abc  ')).toBe('abc')
    expect(blockText('abc\n')).toBe('abc')
    expect(blockText('abc\r\ndef\r\n')).toBe('abc\ndef')
    expect(blockText('a b\n  c')).toBe('a b\n  c')
  })

  it('no text at all is still no text; an empty line on purpose is one empty line', () => {
    expect(blockText('')).toBe('')
    expect(blockText('  \n \n')).toBe('')
    expect(blockText(Z)).toBe(Z)
    expect(blockText(`${Z}\n${Z}`)).toBe(Z)
  })

  it('the canonical form is stable (saving twice changes nothing)', () => {
    for (const t of ['\n\nA\n\nB\n\n', `${Z}\nA`, 'A', ` A \n${Z}${Z}\n B `]) expect(blockText(blockText(t))).toBe(blockText(t))
  })

  it('a formatted text keeps its empty lines too, and still matches its plain text', () => {
    const rich = sanitizeRich('<br><br><b>Címzett:</b><br>R &amp; M<br><br>')
    expect(richToPlain(rich)).toBe(`${Z}\n${Z}\nCímzett:\nR & M\n${Z}\n${Z}`)
    expect(richMatches(rich, blockText(richToPlain(rich)))).toBe(true)
    expect(richMatches('<b>Címzett:</b>', `${Z}\nCímzett:`)).toBe(false)
  })

  it('the recipient window is not undone by the rule (4 lines above stay 4)', () => {
    const t = blockText(enforceRecipientWindow(blockText('Címzett:\nR & M GmbH\n01097 Dresden')))
    expect(t.split('\n').slice(0, 5)).toEqual([Z, Z, Z, Z, 'Címzett:'])
  })

  it('the PDF / Word source prints the empty lines of a block as empty lines', () => {
    const o = { sections: [{ title: 'Új fejezet', status: 'draft', blocks: [
      { kind: 'paragraph', text: `${Z}\n${Z}\nCímzett:\nR & M\n${Z}` },
      { kind: 'paragraph', text: 'Chemnitz' },
    ] }] } as unknown as RenderOutline
    const x = buildFodt(o, { title: 'T', author: null, draft: true, lang: 'hu' })
    const body = x.slice(x.indexOf('<office:text'))
    const before = body.slice(0, body.indexOf('Címzett:'))
    const between = body.slice(body.indexOf('R &amp; M'), body.indexOf('Chemnitz'))
    expect((before.match(/<text:line-break\/>|<text:p [^>]*><\/text:p>|<text:p [^>]*>\u200b?<\/text:p>/g) || []).length).toBeGreaterThanOrEqual(2)
    expect((between.match(/<text:line-break\/>|<text:p [^>]*>\u200b?<\/text:p>/g) || []).length).toBeGreaterThanOrEqual(1)
  })

  it('the browser reads a field with the SAME rule as the server', () => {
    const at = WEB.indexOf('function dpCanonParts(parts)')
    const end = WEB.indexOf('function dpLinesText(el)')
    expect(at).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mk = new Function('DP_BLANK', `${WEB.slice(at, end)}; return { parts: dpCanonParts, text: dpCanonText }`)
    const web = mk(Z) as { parts: (p: string[]) => string[] | null; text: (s: string) => string }
    const cases = [['\n\n\n\nCímzett:\nR & M\n\n'], ['a\n\nb'], [' a ', '\n \n', 'b '], ['', '\n', 'x', '\n'], ['  '], [`${Z}\n`, 'x'], ['a', ' ', '\n', ' ', 'b']]
    for (const c of cases) expect(web.parts(c)).toEqual(canonLineParts(c))
    for (const t of ['\n\nA\n\nB\n\n', 'abc\n', ' x ', '', '\n']) expect(web.text(t)).toBe(blockText(t))
  })

  it('the page and the translation page read a paragraph line for line (no strip of the empty-line mark before saving)', () => {
    expect(WEB).toContain('text = fm.rich ? fm.plain : dpLinesText(n)')
    expect(WEB).not.toContain("text = String(text || '').replace(/\\u200B/g, '')")
    expect(WEB).toMatch(/var txt = \(role !== 'title' && tl == null\)\s*\n\s*\? dpCanonText\(/)
  })

  it('no writer of a block text trims it by hand any more (every one goes through blockText)', () => {
    const offenders: string[] = []
    for (const f of readdirSync(SRC).filter((n) => /^workbench-doc(model|lang|rich)\.ts$/.test(n))) {
      readFileSync(join(SRC, f), 'utf8').split('\n').forEach((l, i) => {
        if (/replace\(\/\\r\\n\/g, '\\n'\)\.trim\(\)/.test(l) && !/rawText|back-translation/.test(l)) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
