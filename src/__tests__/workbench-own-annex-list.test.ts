// #794: a letter imported from Word already carries its own annex list ("Anlagen:" + a line per annex). The generated
// list must not be appended after it -- the Berlin letter printed its annexes twice on its last page.
import { describe, it, expect } from 'vitest'
import { buildFodt, hasOwnAnnexList, type RenderOutline } from '../workbench-docrender.js'

const OPTS = { title: 'T', author: null, draft: false, lang: 'de' as const }
const ANNEXES = [{ label: 'K1', title: 'Bescheid Blindenhilfe' }, { label: 'K2', title: 'Bescheid Grundsicherung' }]

function outline(lines: string[]): RenderOutline {
  return { sections: [{ title: 'A', status: 'draft', blocks: lines.map((text) => ({ kind: 'paragraph', text })) }], annexes: ANNEXES, annexTitle: 'Anlagen' } as RenderOutline
}

const generatedHeadings = (fodt: string): number => (fodt.match(/<text:h [^>]*>Anlagen<\/text:h>/g) || []).length

describe('a document with its own annex list', () => {
  it('gets no second, generated list', () => {
    const o = outline(['Mit freundlichen Grüßen', 'Anlagen:', 'Anlage K1: Bescheid über Blindenhilfe', 'Anlage K2: Bescheid über Grundsicherung'])
    expect(hasOwnAnnexList(o)).toBe(true)
    const fodt = buildFodt(o, OPTS)
    expect(generatedHeadings(fodt)).toBe(0)
    expect(fodt).not.toContain('K1 – Bescheid Blindenhilfe')
  })

  it('is recognised in Hungarian too', () => {
    expect(hasOwnAnnexList(outline(['Mellékletek:', 'K1. melléklet: határozat']))).toBe(true)
  })

  it('keeps the generated list when the text only mentions an annex in passing', () => {
    const o = outline(['Ich füge den Bescheid bei (Anlage K1).', 'Mit freundlichen Grüßen'])
    expect(hasOwnAnnexList(o)).toBe(false)
    expect(generatedHeadings(buildFodt(o, OPTS))).toBe(1)
  })

  it('keeps the generated list when a heading is not followed by any annex label', () => {
    expect(hasOwnAnnexList(outline(['Anlagen:', 'keine']))).toBe(false)
  })

  it('does not take "K10" for "K1"', () => {
    const o = { ...outline(['Anlagen:', 'K10: etwas anderes']), annexes: [ANNEXES[0]] } as RenderOutline
    expect(hasOwnAnnexList(o)).toBe(false)
  })
})
