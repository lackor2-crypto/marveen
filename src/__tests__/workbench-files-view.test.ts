import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #708: the files in the left tree have a list / small / medium / large icon view, one global choice kept in the browser.
describe('workbench files view (#708)', () => {
  const js = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')

  it('remembers one global choice in the browser', () => {
    expect(js).toContain("filesView: readPref('wb.files.view', 'list')")
    expect(js).toContain("writePref('wb.files.view', WB.filesView)")
  })
  it('is one row of four quick buttons (not a dropdown) in the button row, the current one highlighted', () => {
    expect(js).toContain('hideSw + filesViewSelectHtml()')
    expect(js).toContain("data-wb-act=\"files-view\" data-wb-fv=")
    expect(js).toContain("aria-pressed=\"' + (v === cur ? 'true' : 'false')")
    expect(js).toContain("a === 'files-view'")
    const fn = js.slice(js.indexOf('function filesViewSelectHtml'), js.indexOf('var THUMB_EXT'))
    expect(fn).not.toContain('<select')
  })
  it('every button has a title / aria-label and a big touch target on a phone', () => {
    expect(js).toContain("title=\"' + escA(t('workbench.filesview.tip_' + v))")
    expect(js).toContain("aria-label=\"' + escA(t('workbench.filesview.tip_' + v))")
    const css = readFileSync(join(__dirname, '../../web/workbench.css'), 'utf8')
    expect(css).toMatch(/max-width: 900px\) \{ \.wb-root \.wb-fv-btn \{ min-height: 44px/)
  })
  it('icon rows ask the server thumbnail, the list view draws nothing extra', () => {
    expect(js).toContain("if (filesView() === 'list') return ''")
    expect(js).toContain('/api/life/thumb?rel=')
  })
  it('has the labels in both languages', () => {
    for (const l of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, `../../web/lang/${l}.js`), 'utf8')
      for (const k of ['label', 'hint', 'list', 'small', 'medium', 'large', 'tip_list', 'tip_small', 'tip_medium', 'tip_large']) expect(lang).toContain(`"workbench.filesview.${k}"`)
    }
  })
})
