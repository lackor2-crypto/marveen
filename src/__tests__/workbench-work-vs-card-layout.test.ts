import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..', '..', 'web')
const WBJS = readFileSync(join(WEB, 'workbench.js'), 'utf8')
const CSS = readFileSync(join(WEB, 'workbench.css'), 'utf8')
const HU = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

describe('Munkadarab ranezesre elvalik a kanban-kartyatol (TG 1815)', () => {
  it('az attekinto sav munkadarabja sajat keretet, cimket es gombot kap', () => {
    const fn = WBJS.slice(WBJS.indexOf('function ovItemsHtml'), WBJS.indexOf('function ovTile'))
    expect(fn).toContain('<li class="wb-ov-work"><span class="wb-ov-work-tag">')
    expect(fn).toContain("t('workbench.ov.work_tag')")
    expect(fn).toContain('class="wb-ov-work-btn" data-wb-item=')
    expect(fn).not.toContain('wb-linklike')
    expect(CSS).toMatch(/\.wb-ov-work \{[^}]*border: 2px solid var\(--wb-work/)
    expect(CSS).toMatch(/\[data-theme="dark"\] \{ --wb-work:/)
    expect(HU).toContain('"workbench.ov.work_tag": "Munkadarab"')
    expect(EN).toContain('"workbench.ov.work_tag": "Work item"')
  })
})

describe('Verziok blokk fontossagi sorrendben (TG 1817)', () => {
  it('magyarazat -> Mentes uj verziokent -> ket Megnyitas egymas mellett -> lista', () => {
    const start = WBJS.indexOf("t('workbench.context.versions')")
    const block = WBJS.slice(start, WBJS.indexOf("t('workbench.versions.upload_document')", start))
    const hint = block.indexOf("t('workbench.versions.hint')")
    const save = block.indexOf('data-wb-act="version-new"')
    const open = block.indexOf("folderBtnsHtml('versions', null, 'short')")
    const list = block.indexOf('<ul class="wb-versions">')
    expect(hint).toBeGreaterThan(0)
    expect(save).toBeGreaterThan(hint)
    expect(open).toBeGreaterThan(save)
    expect(list).toBeGreaterThan(open)
    expect(block.split("t('workbench.versions.hint')").length).toBe(2)
  })

  it("a 'short' gombon csak 'Megnyitas' all, a teljes jelentes a tooltipben", () => {
    const fn = WBJS.slice(WBJS.indexOf('function folderBtnsHtml'), WBJS.indexOf('function loadFileManagerKind'))
    expect(fn).toContain("short ? t('workbench.folder.open_short') : full")
    expect(fn).toContain('title="\' + escA(tIn) + \'"')
    expect(HU).toContain('"workbench.folder.open_short": "Megnyitás"')
    expect(EN).toContain('"workbench.folder.open_short": "Open"')
  })
})
