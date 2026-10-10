// #521 (Boss TG 8564): a file-list row (own, sub-folder, shared) dragged onto the document page carries its
// PATH -- before, the row wrote an empty path into 'text/wb-file' and the page drop silently did nothing.
import { describe, it, expect } from 'vitest'
import { workbenchHarness } from './helpers/workbench-harness.js'

function start(attrs: Record<string, string>) {
  const h = workbenchHarness()
  const set: Record<string, string> = {}
  const row = { getAttribute: (a: string) => attrs[a] ?? null }
  const dt = { setData: (k: string, v: string) => { set[k] = v }, effectAllowed: '' }
  h.fire('dragstart', { target: { closest: (s: string) => (s === '[data-wb-drag-file]' ? row : null) }, dataTransfer: dt })
  return { set, h }
}

describe('dragging a file row onto the page', () => {
  it('a list row carries its own path (value of data-wb-drag-file), not an empty string', () => {
    const { set } = start({ 'data-wb-drag-file': 'Projektek/Iroda/Közös anyagok/logo.png' })
    expect(set['text/wb-file']).toBe('Projektek/Iroda/Közös anyagok/logo.png')
  })

  it('a tile keeps working: the path comes from data-wb-src, the flag is "1"', () => {
    const { set } = start({ 'data-wb-drag-file': '1', 'data-wb-src': 'Projektek/Iroda/Munkadarabok/Beadvany/a.pdf' })
    expect(set['text/wb-file']).toBe('Projektek/Iroda/Munkadarabok/Beadvany/a.pdf')
  })

  it('a bare "1" flag without a source never becomes a path', () => {
    const { set } = start({ 'data-wb-drag-file': '1' })
    expect(set['text/wb-file']).toBe('')
  })
})
