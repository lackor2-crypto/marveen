// Boss TG 4675: every inserted picture (a signature too) has a delete button of its own.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const CSS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('picture delete button', () => {
  it('the court document picture toolbar has a delete button wired to the block delete', () => {
    const i = JS.indexOf('function dpImgFigureHtml')
    const body = JS.slice(i, i + 3500)
    expect(body).toContain('wb-dp-img-del')
    expect(body).toContain('data-wb-act="dp-del"')
    expect(JS).toContain("else if (a === 'dp-del') dpDeleteBlock(bid)")
  })
  it('a table has one too', () => {
    const i = JS.indexOf('data-wb-tbl-block="')
    expect(JS.slice(i, i + 4000)).toContain('wb-dp-img-del')
  })
  it('the toolbar sits above the free-move handle, so the delete button on a narrow table stays clickable', () => {
    const line = CSS.split('\n').find((l) => l.startsWith('.wb-dp-img-tools {')) || ''
    expect(line).toMatch(/z-index: 3/)
  })
  it('the Word-document picture frame has a delete button sharing the Delete key code', () => {
    expect(JS).toContain("dl.setAttribute('data-de-img-del', '1')")
    expect(JS).toContain('function deleteSelected()')
    expect(JS).toContain('deleteSelected() })')
  })
  it('the label exists in both languages', () => {
    for (const l of ['hu', 'en']) {
      const f = readFileSync(join(__dirname, '..', '..', 'web', 'lang', l + '.js'), 'utf8')
      expect(f).toContain('"workbench.tw.pic_del"')
      expect(f).toContain('"workbench.dp.del"')
    }
  })
})
