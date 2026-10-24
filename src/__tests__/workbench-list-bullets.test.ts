// #791: a bullet list block on the document page shows one bullet per line, as its PDF does (workbench-docrender.ts
// listBlock); before, the block had ONE bullet in front of its first line. The page is measured in a real browser on an
// isolated instance; this pins the line split itself and the styles.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const src = readFileSync(join(root, 'workbench.js'), 'utf8')
const css = readFileSync(join(root, 'workbench.css'), 'utf8')

function listLines(): (html: string) => string | null {
  const at = src.indexOf('function dpListLinesHtml(html) {')
  expect(at).toBeGreaterThan(0)
  let depth = 0
  let end = at
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(at, end) + '\nreturn dpListLinesHtml')() as (html: string) => string | null
}

describe('#791 one bullet per list line', () => {
  const f = listLines()

  it('every line of a plain list block gets its own line element', () => {
    expect(f('[1. tétel]\n[2. tétel]\n[3. tétel]')).toBe('<div class="wb-dp-li">[1. tétel]</div><div class="wb-dp-li">[2. tétel]</div><div class="wb-dp-li">[3. tétel]</div>')
  })

  it('a formatted line (its marks closed on the line) is split too; a <br> counts as a line end', () => {
    expect(f('<b>Első</b> pont<br>Második')).toBe('<div class="wb-dp-li"><b>Első</b> pont</div><div class="wb-dp-li">Második</div>')
  })

  it('a one-line block, and a mark running across a line end, stay as they were (null: no split)', () => {
    expect(f('egy sor')).toBeNull()
    expect(f('<b>Első\nMásodik</b>')).toBeNull()
  })

  it('only a bullet list is split (a numbered list keeps its own "1." markers); the block-wide bullet is off then', () => {
    const at = src.indexOf('function dpEditHtml(cls, id, attrs, text, ph, label, ro, rich) {')
    const body = src.slice(at, at + 900)
    expect(body).toContain("/(^| )wb-outline-kind-list( |$)/.test(cls) && !/(^| )wb-dp-numbered( |$)/.test(cls)")
    expect(body).toContain("cls += ' wb-dp-lines'")
    expect(css).toContain('.wb-dp-block.wb-outline-kind-list.wb-dp-lines::after { content: none; }')
    expect(css).toContain('.wb-dp-block.wb-dp-lines .wb-dp-li::before { content: "\\2022";')
  })

  it('the editor reads a <div> line back as a new line, so the stored text does not change', () => {
    // dpFmtOf: a block-level child starts a new line; dpText uses innerText (a <div> is a line of its own)
    expect(src).toContain("var blockTag = tag === 'div' || tag === 'p'")
    expect(src).toContain('if (blockTag && !lastNl()) push(\'\\n\', m)')
  })
})
