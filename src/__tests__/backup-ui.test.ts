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
  const created: any[] = []
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
    document: {
      getElementById: () => null,
      body: { appendChild(el: any) { created.push(el) } },
      createElement: () => {
        const el: any = { innerHTML: '', className: '', ls: {} as Record<string, (e: any) => void>, click() {}, remove() { el.removed = true } }
        el.addEventListener = (ev: string, fn: any) => { el.ls[ev] = fn }
        return el
      },
    },
    fetch: async (url: string, init: any = {}) => {
      const path = url.split('?')[0]
      calls.push({ method: init.method || 'GET', url: path, body: init.body ? JSON.parse(init.body) : undefined })
      const key = `${init.method || 'GET'} ${path}`
      const r: any = responses[key] ?? { ok: true }
      if (r && r.__status) return { ok: false, status: r.__status, json: async () => r.body }
      return { ok: true, status: 200, json: async () => r }
    },
  }
  win.window = win
  vm.runInNewContext(SRC, win)
  return { win, host, calls, toasts, created, click: (attrs: Record<string, string>) => listeners.click?.({
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
    for (const c of ['database', 'secrets', 'settings', 'knowledge', 'agents', 'memory', 'skills', 'schedules', 'depot-config', 'git']) used.add(`fbk.cat.${c}`)
    for (const t of ['kanban_cards', 'memories', 'projects', 'approvals']) used.add(`fbk.r.t.${t}`)
    for (const w of ['old_paths', 'backup_had_missing', 'disk_space']) used.add(`fbk.r.warn.${w}`)
    for (const c of ['backup_newer', 'format_unknown']) used.add(`fbk.r.compat.${c}`)
    for (const c of ['failed', 'interrupted', 'busy', 'stop_failed', 'never_started']) used.add(`fbk.r.code.${c}`)
    for (const k of ['fbk.cat.', 'fbk.r.t.', 'fbk.r.warn.', 'fbk.r.compat.', 'fbk.r.code.']) used.delete(k)
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
    expect(H.calls.map((c) => c.url)).toEqual(['/api/backup/status', '/api/backup/list', '/api/backup/cloud-accounts', '/api/backup/restore/status'])
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

  it('restore: a list row opens the preview, the preview offers the start', async () => {
    const name = 'marveen-backup-20260925-212011-host.mbk'
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [{ name, size: 10, time: 1, where: ['local'], kind: 'manual', verified: null }], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'GET /api/backup/restore/status': { running: false, result: null, channelsHeld: false },
      'POST /api/backup/restore/open': {
        previewId: 'p1', createdAt: '2026-09-25T21:20:11+02:00', appVersion: '1.29.0', compat: { ok: true, needsMigration: false },
        categories: [{ id: 'database', files: 1, willOverwrite: 1, willAdd: 0, held: 0 }, { id: 'skills', files: 3, willOverwrite: 1, willAdd: 2, held: 0 }],
        optional: ['skills'], dbCounts: { backup: { kanban_cards: 412 }, current: { kanban_cards: 0 } }, warnings: [],
        needsLogin: ['main', 'alpha'], freshInstall: true, bytes: { payload: 1, free: 10, enough: true }, pathMoved: true, agents: ['alpha'], keyId: 'ab12cd34',
      },
    })
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    const restoreHost: any = { innerHTML: '' }
    // the panel mounts the flow into #bkRestoreHost; stand in for it
    H.win.document.getElementById = (id: string) => (id === 'bkRestoreHost' ? restoreHost : null)
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    expect(restoreHost.innerHTML).toContain('data-bk="r-file"')
    await H.click({ 'data-bk': 'r-open', 'data-source': 'local', 'data-name': name })
    await flush()
    const open = H.calls.find((c) => c.url === '/api/backup/restore/open')!
    expect(open.body).toMatchObject({ source: 'local', name })
    expect(restoreHost.innerHTML).toContain('data-bk="r-start"')
    expect(restoreHost.innerHTML).toContain('[fbk.r.count [fbk.r.t.kanban_cards]|0|412]')
    expect(restoreHost.innerHTML).toContain('data-cat="skills"')
    expect(restoreHost.innerHTML).toContain('[fbk.r.fresh]')
  })

  it('restore: a missing key asks for it, naming the key id', async () => {
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [{ name: 'marveen-backup-20260925-212011-host.mbk', size: 1, time: 1, where: ['local'] }], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'GET /api/backup/restore/status': { running: false, result: null, channelsHeld: false },
      'POST /api/backup/restore/open': { __status: 400, body: { error: 'key_needed', message: 'kulcs kell', keyId: 'ab12cd34' } },
    })
    const restoreHost: any = { innerHTML: '' }
    H.win.document.getElementById = (id: string) => (id === 'bkRestoreHost' ? restoreHost : null)
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    await H.click({ 'data-bk': 'r-open', 'data-source': 'local', 'data-name': 'marveen-backup-20260925-212011-host.mbk' })
    await flush()
    expect(H.toasts).toContain('kulcs kell')
    expect(restoreHost.innerHTML).toContain('[fbk.r.key_for ab12cd34]')
  })

  it('restore with a dashboard login: the start sends the typed user name + password', async () => {
    const name = 'marveen-backup-20260925-212011-host.mbk'
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [{ name, size: 10, time: 1, where: ['local'], kind: 'manual', verified: null }], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'GET /api/backup/restore/status': { running: false, result: null, channelsHeld: false },
      'POST /api/backup/restore/open': {
        previewId: 'p1', confirm: 'user_password', createdAt: 'x', appVersion: '1.29.0', compat: { ok: true }, categories: [], optional: [],
        dbCounts: { backup: {}, current: {} }, warnings: [], needsLogin: [], freshInstall: false, bytes: { enough: true }, agents: [], keyId: 'ab12cd34',
      },
      'POST /api/backup/restore/start': { ok: true, planId: 'p1', preBackup: 'made' },
    })
    const restoreHost: any = { innerHTML: '' }
    const fields: Record<string, any> = { bkRestoreHost: restoreHost, bkRestoreUser: { value: ' owner ' }, bkRestorePw: { value: 'secret pw' } }
    H.win.document.getElementById = (id: string) => fields[id] ?? null
    H.win.renderBackupPanel(H.host)
    await flush(); await flush()
    await H.click({ 'data-bk': 'r-open', 'data-source': 'local', 'data-name': name })
    await flush()
    expect(restoreHost.innerHTML).toContain('id="bkRestoreUser"')
    expect(restoreHost.innerHTML).toContain('id="bkRestorePw"')
    expect(restoreHost.innerHTML).toContain('[fbk.r.pw_why]')
    await H.click({ 'data-bk': 'r-start' })
    await flush()
    const start = H.calls.find((c) => c.url === '/api/backup/restore/start')!
    expect(start.body).toEqual({ previewId: 'p1', exclude: [], username: 'owner', password: 'secret pw' })
    expect(restoreHost.innerHTML).toContain('[fbk.r.running]')
  })

  it('an outcome not read yet is shown again (after the restart / a new login), and closing marks it read', async () => {
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'GET /api/backup/restore/status': { running: false, result: { ok: false, code: 'never_started', reason: 'spawn systemd-run ENOENT', finishedAt: 1, planId: 'p' }, channelsHeld: false },
      'POST /api/backup/restore/ack': { ok: true, changed: true },
    })
    const restoreHost: any = { innerHTML: '' }
    H.win.document.getElementById = (id: string) => (id === 'bkRestoreHost' ? restoreHost : null)
    H.win.renderBackupPanel(H.host)
    await flush(); await flush(); await flush()
    expect(restoreHost.innerHTML).toContain('[fbk.r.failed]')
    expect(restoreHost.innerHTML).toContain('[fbk.r.code.never_started]')
    expect(restoreHost.innerHTML).toContain('spawn systemd-run ENOENT')
    await H.click({ 'data-bk': 'r-reset' })
    await flush()
    expect(H.calls.some((c) => c.method === 'POST' && c.url === '/api/backup/restore/ack')).toBe(true)
    expect(restoreHost.innerHTML).toContain('data-bk="r-file"')
  })

  it('the first screen: a finished restore whose outcome was not read comes before everything else', async () => {
    const H = harness({
      'GET /api/backup/restore/status': { running: false, result: { ok: true, code: 'done', finishedAt: 1, planId: 'p' }, channelsHeld: true },
    })
    const wizardHost: any = { innerHTML: '' }
    H.win.document.getElementById = (id: string) => (id === 'bkWizardRestore' ? wizardHost : null)
    expect(await H.win.maybeAskRestoreFirst()).toBe(true)
    await flush(); await flush()
    expect(H.created.find((e) => e.className === 'bk-wizard')).toBeTruthy()
    expect(wizardHost.innerHTML).toContain('[fbk.r.done]')
    expect(wizardHost.innerHTML).toContain('data-bk="r-release"')
    expect(H.calls.some((c) => c.url === '/api/backup/onboarding')).toBe(false)
  })

  it('held channels: the page shows the "old machine is off" button', async () => {
    const H = harness({
      'GET /api/backup/status': STATUS,
      'GET /api/backup/list': { backups: [], sources: {} },
      'GET /api/backup/cloud-accounts': { accounts: [] },
      'GET /api/backup/restore/status': { running: false, result: null, channelsHeld: true },
    })
    const restoreHost: any = { innerHTML: '' }
    H.win.document.getElementById = (id: string) => (id === 'bkRestoreHost' ? restoreHost : null)
    H.win.renderBackupPanel(H.host)
    await flush(); await flush(); await flush()
    expect(restoreHost.innerHTML).toContain('data-bk="r-release"')
    expect(restoreHost.innerHTML).toContain('[fbk.channels.paused]')
  })

  it('fresh install: asks once; "start fresh" records the choice and lets onboarding go on', async () => {
    const H = harness({ 'GET /api/backup/onboarding': { ask: true } })
    const p = H.win.maybeAskRestoreFirst()
    await flush(); await flush()
    const overlay = H.created.find((e) => e.className === 'bk-wizard')
    expect(overlay.innerHTML).toContain('[fbk.wizard.q]')
    overlay.ls.click({ target: { closest: () => ({ getAttribute: (x: string) => (x === 'data-bk' ? 'w-fresh' : null) }) }, preventDefault() {} })
    expect(await p).toBe(false)
    expect(H.calls.find((c) => c.method === 'POST' && c.url === '/api/backup/onboarding')!.body).toEqual({ choice: 'fresh' })
    expect(overlay.removed).toBe(true)
  })

  it('not a fresh install: no question at all', async () => {
    const H = harness({ 'GET /api/backup/onboarding': { ask: false } })
    expect(await H.win.maybeAskRestoreFirst()).toBe(false)
    expect(H.created).toEqual([])
  })

  it('is reachable: Settings tab, script tag, Overview line', () => {
    expect(APP).toMatch(/const allModules = \[[^\]]*'backup'/)
    expect(APP).toContain("window.renderBackupPanel(body)")
    expect(APP).toMatch(/h\.id\.startsWith\('backup_'\)\s*\n\s*\? 'openBackupSettings\(\)'/)
    expect(HTML.indexOf('/backup.js')).toBeGreaterThan(HTML.indexOf('/app.js'))
    expect(HU.has('settings.module.backup') && EN.has('settings.module.backup')).toBe(true)
    expect(APP).toContain("await window.maybeAskRestoreFirst()")
  })
})
