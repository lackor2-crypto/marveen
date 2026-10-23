// #762: the browser can do what a user does -- tabs, upload, download, dialogs, clipboard -- safely.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeUploadName, safeDownloadName, parseTabIndex, parseDialogPolicy, sessionCookiesToKeep, SESSION_COOKIE_KEEP_SEC } from '../browser-logic.js'

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
describe('session cookies of the persistent profile', () => {
  const now = 1_000_000
  it('keeps only the cookies without an expiry and gives them one, so a login survives the browser closing', () => {
    const kept = sessionCookiesToKeep([
      { name: 'sess', value: 'a', expires: -1 },
      { name: 'pers', value: 'b', expires: now + 100 },
      { name: 'nov', value: 'c' },
    ], now)
    expect(kept.map(c => c.name)).toEqual(['sess', 'nov'])
    for (const c of kept) expect(c.expires).toBe(now + SESSION_COOKIE_KEEP_SEC)
  })
  it('ignores junk', () => {
    expect(sessionCookiesToKeep(null, now)).toEqual([])
    expect(sessionCookiesToKeep([null, 'x', 3], now)).toEqual([])
  })
  it('is wired: saved on every action and on stop, restored at start, and removed with the profile folder', () => {
    const svc = readFileSync(join(__dirname, '..', 'web', 'browser-service.ts'), 'utf8')
    expect(svc).toContain('await saveSessionCookies(r)')
    expect(svc).toContain('await saveSessionCookies(cur)')
    expect(svc).toContain('await restoreSessionCookies(context)')
    expect(svc).toContain("join(BROWSER_PROFILE_DIR, 'marveen-session-cookies.json')")
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
  it('#762 part 2: the default browser is a persistent profile under the backup-excluded store/browser folder, with a reset route', () => {
    expect(svc).toContain("join(STORE_DIR, 'browser', 'profile')")
    expect(svc).toContain('launchPersistentContext(BROWSER_PROFILE_DIR')
    expect(svc).toContain("'profile_in_use'")
    expect(svc).toContain('export async function clearBrowserProfile')
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'browser.ts'), 'utf8')
    expect(route).toContain("'/api/browser/profile'")
    expect(route).toContain('clearBrowserProfile')
  })
})
