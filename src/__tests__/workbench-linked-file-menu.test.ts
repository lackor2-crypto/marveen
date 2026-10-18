// #697 (Boss TG 9674, 9670): a linked file (🔗) in the Workbench tree has a right-click / "..." menu whose one real entry
// removes the LINK (never the original), and it wears its group colour, paler than a real file.
// Source contract; the rendered result was clicked through in a browser (see the card).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web/workbench.js'), 'utf8')
const css = readFileSync(join(root, 'web/workbench.css'), 'utf8')
const assets = readFileSync(join(root, 'src/workbench-assets.ts'), 'utf8')

describe('linked file rows', () => {
  it('the server hands the link id and owner item to the page', () => {
    expect(assets).toContain("link: { kind: 'annex', item: r.item, id: r.id }")
    expect(assets).toContain("link: { kind: 'asset', item: r.item, id: r.id }")
    expect(assets).toContain('a.id AS id, a.work_item_id AS item')
  })
  it('the annex row is a context-menu row with the group colour and the paler class', () => {
    const fn = js.slice(js.indexOf('function plainFileRowHtml'), js.indexOf('// #691 (Boss TG 9610)'))
    expect(fn).toContain('wb-linked-row')
    expect(fn).toContain('grpVars(grp)')
    expect(fn).toContain('data-wb-ctx-link')
    expect(fn).toContain('data-wb-act="link-ctx"')
  })
  it('the menu offers Open and Remove only, and Remove deletes the link, not the file', () => {
    const menu = js.slice(js.indexOf('function linkMenuHtml'), js.indexOf('/** The loose file'))
    expect(menu).toContain('file-unlink-annex')
    expect(menu).not.toContain('file-delete')
    const fn = js.slice(js.indexOf('function unlinkAnnexFile'), js.indexOf('/** #529: deleted files back'))
    expect(fn).toContain("api('DELETE', url)")
    expect(fn).not.toContain('files-delete')
    expect(js).toContain("a === 'file-unlink-annex'")
  })
  it('the paler colour is in the css and both languages have the strings', () => {
    expect(css).toMatch(/\.wb-grp\.wb-linked-row \{ background: color-mix\(in srgb, var\(--wb-grp\) calc\(var\(--wb-grp-a, 22%\) \* 0\.45\)/)
    for (const l of ['hu', 'en']) {
      const f = readFileSync(join(root, `web/lang/${l}.js`), 'utf8')
      expect(f).toMatch(/"workbench\.filelink\.remove": "[^"]+"/)
      expect(f).toMatch(/"workbench\.filelink\.removed": "[^"]*\{name\}[^"]*"/)
    }
  })
})
