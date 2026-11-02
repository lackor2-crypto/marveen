// Boss TG 4571: in the Workbench tree the standard folders of a work item stay together in one block; a moved folder
// (or letter folder) never lands BETWEEN them, it comes after them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

function build(): (names: string[]) => string[] {
  const map = /var STD_FOLDERS = \{[\s\S]*?\}\n/.exec(src)![0]
  const rank = /function stdFolderRank[^\n]*\n/.exec(src)![0]
  const nameCmp = /function nameCmp[^\n]*\n/.exec(src)![0]
  const cmp = /function folderCmp[^\n]*\n/.exec(src)![0]
  // eslint-disable-next-line no-new-func
  return new Function(`${map}\n${nameCmp}\n${rank}\n${cmp}\nreturn function (names) { return names.map(function (n) { return { name: n } }).sort(folderCmp).map(function (x) { return x.name }) }`)()
}

describe('tree folder order', () => {
  it('standard folders first, in one block; the moved folder after them', () => {
    const sort = build()
    expect(sort(['Vitáztatás', 'Kérés a DRV Bund Clearingstelle', 'Mellékletek', 'Agent', 'Kiváltó irat', 'Feltöltések', 'Elkészített anyagok']))
      .toEqual(['Agent', 'Elkészített anyagok', 'Feltöltések', 'Kiváltó irat', 'Mellékletek', 'Vitáztatás', 'Kérés a DRV Bund Clearingstelle'])
  })
  it('English names too', () => {
    const sort = build()
    expect(sort(['Debate', 'Letter 2', 'Attachments', 'Agent', 'Trigger document', 'Uploads', 'Finished materials']))
      .toEqual(['Agent', 'Attachments', 'Debate', 'Finished materials', 'Trigger document', 'Uploads', 'Letter 2'])
  })
  it('all three folder sorts of the tree use it', () => {
    expect(src).toContain('kids[k].sort(function (x, y) { return folderCmp(')
    expect(src).toContain('outKids[k].sort(function (x, y) { return folderCmp(')
    expect(src).toContain('kidsHere.sort(folderCmp)')
  })
})
