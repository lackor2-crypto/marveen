// Card #536: a work item whose OWN file was deleted shows a note + Restore (in both the manual and the frame view),
// not an empty shell, and its document is reloaded after Delete / Restore / Undo.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const fnBody = (name: string) => {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('missing ' + name)
  return src.slice(i, i + 3500)
}

describe('own file in the trash (#536)', () => {
  it('both the preview and the frame document editor use the one note', () => {
    expect(fnBody('ownFileGoneHtml')).toContain('wb-own-file-gone')
    expect(fnBody('ownFileGoneHtml')).toContain('data-wb-act="file-restore"')
    expect(fnBody('previewHtml')).toContain('ownFileGoneHtml(gone)')
    expect(fnBody('docTabsHtml')).toContain('trashedOwnFile()')
    expect(fnBody('docTabsHtml')).toContain('ownFileGoneHtml(goneOwn)')
  })

  it('the open item is reloaded after a delete and after a restore', () => {
    expect(fnBody('reloadIfOwnFile')).toContain('loadDetail')
    expect(fnBody('deleteFilesNow')).toContain('reloadIfOwnFile')
    expect(fnBody('restoreFiles')).toContain('reloadIfOwnFile')
  })

  it('the sentence exists in Hungarian and English', () => {
    const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf8')
    expect(hu).toMatch(/workbench\.trash\.own_file_gone/)
    expect(en).toMatch(/workbench\.trash\.own_file_gone/)
  })
})
