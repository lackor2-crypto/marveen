/**
 * #396 Phase 3 -- the Settings -> Backup page (web/backup.js), run for real in a
 * small DOM stand-in: it renders every section from the status, the buttons
 * bind to the backup routes, every word goes through t() (HU+EN), and the page
 * is reachable (Settings tab + the Overview backup line).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { scanJs } from './helpers/i18n-scan.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'backup.js'), 'utf8')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

function langKeys(file: string): Set<string> {
  const src = readFileSync(join(ROOT, 'web', 'lang', file), 'utf8')
  return new Set([...src.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)].map((m) => m[1]))
}
const HU = langKeys('hu.js')
const EN = langKeys('en.js')

function harness(responses: Record<string, unknown>) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const toasts: string[] = []
  const listeners: Record<string, (e: any) => void> = {}
  const host: any = { innerHTML: '', addEventListener: (ev: string, fn: any) => { listeners[ev] = fn } }
  const win: any = {
    _lang: 'en',
    t: (k: string, p: Record<string, unknown> = {}) => `[${k}${Object.keys(p).length ? ' ' + Object.values(p).join('|') : ''}]`,
    escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeAttr: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    showToast: (m: string) => { toasts.push(m) },
    switchPage: () => {},
    confirm: () => true,
    setTimeout: (fn: () => void) => { void fn },
    document: { getElementById: () => null, body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) },
    fetch: async (url: string, init: any = {}) => {
      const path = url.split('?')[0]
      calls.push({ method: init.method || 'GET', url: path, body: init.body ? JSON.parse(init.body) : undefined })
      const key = `${init.method || 'GET'} ${path}`
      const body = responses[key] ?? { ok: true }
      return { ok: true, status: 200, json: async () => body }
    },
  }
  win.window = win
  vm.runInNewContext(SRC, win)
  return { win, host, calls, toasts, click: (attrs: Record<string, string>) => listeners.click?.({
    target: { closest: (sel: string) => (sel === '[data-bk]' ? { getAttribute: (a: string) => attrs[a] ?? null, checked: attrs.checked === '1' } : null) },
    preventDefault() {},
  }) }
}

const STATUS = {
  health: { id: 'backup_none_yet', status: 'ok', params: { time: '03:30' } },
  loginOn: true,
  state: { lastRun: null, lastSuccessAt: null, lastSuccessName: null, replicas: {}, lastVerify: null },
  config: { depot: { enabled: null }, cloud: { kind: null, account: null, folderName: null }, schedule: { enabled: true, time: '03:30' }, includeLogs: false },
  destinations: [
    { id: 'local', kind: 'local', enabled: true, where: '/x/store/backups' },
    { id: 'depot', kind: 'depot', enabled: true, where: '/mnt/f/Marveen/Rendszer/Marveen/Mentések' },
    { id: 'cloud', kind: 'gdrive', enabled: false, where: null, off: 'not_configured' },
  ],
  defaultCloudFolder: 'Marveen backups',
  key: { exists: false },
  running: null,
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Settings -> Backup page', () => {
  it('parses, and has no hand-written Hungarian', () => {
    execFileSync(process.execPath, ['--check', join(ROOT, 'web', 'backup.js')])
    expect(scanJs(join(ROOT, 'web', 'backup.js'))).toEqual([])
  })

  it('every fbk.* key it uses exists in both languages', () => {
    const used = new Set([...SRC.matchAll(/'(fbk\.[a-z0-9_.]+[a-z0-9_])'/g)].map((m) => m[1]))
    // dynamic families: stage / dest / reason
    for (const s of ['starting', 'collecting', 'database', 'encrypting', 'copying', 'done']) used.add(`fbk.stage.${s}`)
    for (const d of ['local', 'depot', 'cloud']) { used.add(`fbk.dest.${d}`); used.add(`fbk.dest.${d}_why`); used.add(`fbk.dest.${d}_off`) }
    for (const r of ['depot_unreachable', 'copy_failed', 'cloud_auth', 'cloud_offline', 'cloud_failed', 'cloud_unavailable', 'list_failed', 'failed', 'not_configured', 'disabled']) used.add(`fbk.reason.${r}`)
    for (const k of ['1', '2', '3', '4']) used.add(`fbk.kittxt.how${k}`)
    used.delete('fbk.dest.')
    used.delete('fbk.reason.')
    used.delete('fbk.stage.')
    const missing = [...used].filter((k) => !HU.has(k) || !EN.has(k))
    expect(missing).toEqual([])
    expect(used.size).toBeGreaterThan(60)
  })

  it('renders every section, with the depot path in Windows form', async () => {
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
    })
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    const html = H.host.innerHTML
    expect(html).toContain('data-bk="run"')
    expect(html).toContain('[fbk.kit.title]')
    expect(html).toContain('id="bkKitPw"') // login on -> password field
    expect(html).toContain('F:\\Marveen\\Rendszer')
    expect(html).toContain('[fbk.cloud.no_accounts]')
    expect(html).toContain('[fbk.list.empty]')
    expect(html).toContain('id="bkTime"')
    expect(H.calls.map((c) => c.url)).toEqual(['/api/backup/status', '/api/backup/list', '/api/backup/cloud-accounts'])
  })

  it('Back up now posts /api/backup/run and polls the job', async () => {
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'POST /api/backup/run': { jobId: 'abcdef0123456789' },
    })
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    await H.click({ 'data-bk': 'run' })
    await flush()
    expect(H.calls.some((c) => c.method === 'POST' && c.url === '/api/backup/run')).toBe(true)
    expect(H.host.innerHTML).toContain('[fbk.stage.starting]')
  })

  it('is reachable: Settings tab, script tag, Overview line', () => {
    expect(APP).toMatch(/const allModules = \[[^\]]*'backup'/)
    expect(APP).toContain("window.renderBackupPanel(body)")
    expect(APP).toMatch(/h\.id\.startsWith\('backup_'\)\s*\n\s*\? 'openBackupSettings\(\)'/)
    expect(HTML.indexOf('/backup.js')).toBeGreaterThan(HTML.indexOf('/app.js'))
    expect(HU.has('settings.module.backup') && EN.has('settings.module.backup')).toBe(true)
  })
})
