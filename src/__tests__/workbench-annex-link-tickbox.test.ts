// Boss TG 4476: the attachment / upload link rows of the Workbench tree have a tick box like every other file.
// A bulk delete takes only the LINK off (never the original in the Life tree); move/copy skips them.
// Source contract; the rendered result was clicked through in a browser (see the card).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web/workbench.js'), 'utf8')

describe('annex link rows are tickable', () => {
  const row = js.slice(js.indexOf('function plainFileRowHtml'), js.indexOf('// #691 (Boss TG 9610)'))
  it('the annex row draws the same tick box as a real file, unless the project is archived', () => {
    expect(row).toContain("(archived() ? '' : '<input type=\"checkbox\" class=\"wb-file-sel\"")
    expect(row).toContain('WB.annexLinks[f.rel]')
  })
  it('a bulk delete removes ticked links through their own DELETE and sends only real files to files-delete', () => {
    const fn = js.slice(js.indexOf('function deleteFiles('), js.indexOf('function unlinkAnnexFile'))
    expect(fn).toContain("'/outline/annexes/'")
    expect(fn).toContain('deleteFilesNow(rels, pid)')
    expect(fn).toContain("api('POST', '/api/workbench/files-delete'")
  })
  it('the selection bar offers no move list while a link is ticked, and a link is never a deck picture', () => {
    expect(js).toContain("sel.outside || sel.annex ? '' : moveFilesSelectHtml('*')")
    expect(js).toContain('if (f.annex) { annex++; other++; return }')
  })
})
