// #462 -- "Sync now" on the Drive page (Boss TG 2184/2188). The button reuses
// the depot card's /api/drive/sync/run; the toast at the end must tell the
// real result: the emergency brake and a stopped run never read as a plain
// "Done", failed files say where to look, and a fresh install (no Drive folder
// linked) gets a sentence and a button that lead to the place to link one.
// Source checks plus running the pure result function: the browser file
// cannot be loaded as a module.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const app = readFileSync('web/app.js', 'utf8')
const hu = readFileSync('web/lang/hu.js', 'utf8')
const en = readFileSync('web/lang/en.js', 'utf8')
const server = readFileSync('src/web/routes/drive-sync.ts', 'utf8')

const fnSrc = app.slice(app.indexOf('function _driveSyncResult(job) {'), app.indexOf('function _driveSyncToast('))
const nowSrc = app.slice(app.indexOf('async function _driveSyncNow() {'), app.indexOf("addEventListener('click', _driveSyncNow)"))

type Result = { text: string; type: string; toSettings: boolean }
// t() stub: key + params, so the test sees which sentence was picked with what.
const t = (k: string, p: Record<string, unknown> = {}) => `${k}${JSON.stringify(p)}`
// eslint-disable-next-line no-new-func
const result = new Function('t', `${fnSrc}\nreturn _driveSyncResult`)(t) as (job: object) => Result

describe('Drive page Sync now (#462)', () => {
  it('the button sits in the Drive page header, with HU+EN label and title', () => {
    const page = html.slice(html.indexOf('id="drivePage"'), html.indexOf('id="drivePage"') + 8000)
    expect(page).toContain('id="driveSyncNowBtn"')
    expect(page).toContain('data-i18n="drive.sync_now_btn"')
    expect(page).toContain('data-i18n-title="drive.sync_now_title"')
  })

  it('starts the same run as the depot card and waits for its end', () => {
    expect(nowSrc).toContain("_depoPost('/api/drive/sync/run', {})")
    expect(nowSrc).toContain("_depoGet('/api/drive/sync')")
    expect(nowSrc).toContain("e.data.code === 'already_running'")
  })

  it('a clean run is a plain Done toast with no button', () => {
    const r = result({ running: false, downloaded: 3, uploaded: 1, upToDate: 40, failed: 0 })
    expect(r.text).toBe('drive.sync_done{"down":3,"up":1,"ok":40,"failed":0}')
    expect(r.type).toBe('')
    expect(r.toSettings).toBe(false)
    expect(r.text).not.toContain('drive.sync_where')
  })

  it('the emergency brake is said out loud, as a warning with the way to the depot card', () => {
    const r = result({ running: false, downloaded: 0, uploaded: 0, upToDate: 10, failed: 0, deleteBrake: { wouldDelete: 900, tracked: 1000 } })
    expect(r.text).toContain('dsync.brake_warn{"n":900,"tracked":1000}')
    expect(r.text).toContain('drive.sync_where')
    expect(r.type).toBe('warn')
    expect(r.toSettings).toBe(true)
  })

  it('failed files and waiting deletions say where to look', () => {
    const r = result({ running: false, downloaded: 2, uploaded: 0, upToDate: 5, failed: 7, pendingDeletes: 3 })
    expect(r.text).toContain('drive.sync_pending_deletes{"n":3}')
    // The place is said once, not once per problem.
    expect(r.text.split('drive.sync_where').length - 1).toBe(1)
    expect(r.type).toBe('warn')
    expect(r.toSettings).toBe(true)
  })

  it('a stopped run is an error with the reason, never "Done"', () => {
    const r = result({ running: false, downloaded: 4, uploaded: 0, upToDate: 0, failed: 0, fatal: 'disk gone' })
    expect(r.text).toContain('drive.sync_stopped')
    expect(r.text).toContain('"reason":"disk gone"')
    expect(r.text).not.toContain('drive.sync_done')
    expect(r.type).toBe('error')
  })

  it('the server marks a stopped run, so the page can tell it from a clean one', () => {
    expect(server).toMatch(/fatal\?: string/)
    expect(server).toMatch(/runSync\(pairs\)\.catch\(\(err\) => \{[\s\S]{0,300}job\.fatal = String\(err\?\.message \|\| err\)/)
  })

  it('fresh install (no Drive folder linked): own sentence and a button to the settings', () => {
    expect(nowSrc).toContain("if (code === 'no_pairs') _driveSyncToast(t('drive.sync_no_pairs'), 'error', true)")
    expect(app).toMatch(/function _driveSyncToast\([\s\S]{0,300}onClick: _driveSyncOpenDepotCard/)
    // The button lands ON the card (far down the depot settings), after the page loaded.
    const open = app.slice(app.indexOf('async function _driveSyncOpenDepotCard() {'), app.indexOf('async function _driveSyncNow() {'))
    expect(open).toContain("switchPage('irodaSettings')")
    expect(open).toContain('await openIrodaDepotSettings()')
    expect(open).toContain('h2[data-i18n="dsync.title"]')
    expect(open).toContain("document.querySelector('.mobile-topbar')")
    expect(open).toContain("title.scrollIntoView({ block: 'start' })")
    expect(app).toMatch(/function openIrodaDepotSettings\(\) \{[\s\S]{0,400}return loadDepoPage\(\)/)
  })

  it('a long toast may use the phone screen, not half of it', () => {
    const css = readFileSync('web/style.css', 'utf8')
    const rule = css.slice(css.indexOf('.toast {'), css.indexOf('.toast.visible'))
    expect(rule).toContain('width: max-content;')
    expect(rule).toContain('max-width: min(92vw, 560px);')
  })

  it('every sentence exists in both languages', () => {
    for (const k of ['drive.sync_now_btn', 'drive.sync_now_title', 'drive.sync_running', 'drive.sync_started',
      'drive.sync_already', 'drive.sync_done', 'drive.sync_failed', 'drive.sync_stopped', 'drive.sync_pending_deletes',
      'drive.sync_where', 'drive.sync_no_pairs', 'drive.sync_open_settings', 'dsync.brake_warn']) {
      expect(hu).toContain("'" + k + "'")
      expect(en).toContain("'" + k + "'")
    }
  })
})
