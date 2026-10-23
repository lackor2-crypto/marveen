// #762: the browser can do what a user does -- tabs, upload, download, dialogs, clipboard -- safely.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeUploadName, safeDownloadName, parseTabIndex, parseDialogPolicy } from '../browser-logic.js'

describe('upload name', () => {
  it('accepts a plain file name only', () => {
    expect(safeUploadName('szamla.pdf')).toBe('szamla.pdf')
    for (const bad of ['../../.env', '/etc/passwd', 'a/b.txt', 'a\\b.txt', '.env', '..', '', '  ']) expect(safeUploadName(bad), bad).toBeNull()
  })
})
describe('download name', () => {
  it('strips path parts and bad characters, never returns empty', () => {
    expect(safeDownloadName('../../x/evil.sh')).toBe('evil.sh')
    expect(safeDownloadName('a:b?.pdf')).toBe('a_b_.pdf')
    expect(safeDownloadName('')).toBe('letoltes')
    expect(safeDownloadName('...')).toBe('letoltes')
  })
})
describe('tab index', () => {
  it('whole numbers inside the list only', () => {
    expect(parseTabIndex('1', 3)).toBe(1)
    expect(parseTabIndex(0, 1)).toBe(0)
    for (const bad of [-1, 3, 1.5, 'x', '', undefined]) expect(parseTabIndex(bad, 3), String(bad)).toBeNull()
  })
})
describe('dialog policy', () => {
  it('accept / dismiss only', () => {
    expect(parseDialogPolicy(' Accept ')).toBe('accept')
    expect(parseDialogPolicy('dismiss')).toBe('dismiss')
    expect(parseDialogPolicy('yes')).toBeNull()
  })
})
describe('wiring', () => {
  const svc = readFileSync(join(__dirname, '..', 'web', 'browser-service.ts'), 'utf8')
  it('lists the new actions, dismisses dialogs by default and keeps files under store/', () => {
    for (const a of ['tabs', 'tab_new', 'tab_switch', 'tab_close', 'upload', 'downloads', 'dialogs', 'dialog_policy', 'clipboard_write', 'clipboard_read']) expect(svc).toContain(`'${a}'`)
    expect(svc).toContain("dialogPolicy: 'dismiss'")
    expect(svc).toContain("join(STORE_DIR, 'browser', 'uploads')")
    expect(svc).toContain("join(STORE_DIR, 'browser', 'downloads')")
  })
})
