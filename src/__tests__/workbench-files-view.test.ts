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
  it('the select sits in the foot block above the trash and a change redraws', () => {
    expect(js).toContain('treeUploadHtml() + filesViewSelectHtml() + trashHtml()')
    expect(js).toContain("getAttribute('data-wb-files-view') !== null")
  })
  it('icon rows ask the server thumbnail, the list view draws nothing extra', () => {
    expect(js).toContain("if (filesView() === 'list') return ''")
    expect(js).toContain('/api/life/thumb?rel=')
  })
  it('has the labels in both languages', () => {
    for (const l of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, `../../web/lang/${l}.js`), 'utf8')
      for (const k of ['label', 'hint', 'list', 'small', 'medium', 'large']) expect(lang).toContain(`"workbench.filesview.${k}"`)
    }
  })
})
