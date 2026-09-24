/**
 * Friss telepitesen a Google-bekotes VEGIG megy a feluletrol (kanban f97acc32).
 *
 * Ket res volt:
 *   1. A varazslo 5. lepese azt kerte, hogy a Google-tol letoltott engedely-
 *      fajlt kezzel masoljuk a store/google-oauth-client.json helyre -- terminal
 *      vagy fajlkezelo nelkul ez nem ment, es enelkul se level, se naptar, se
 *      Drive, se Fotok.
 *   2. A varazslo nem mondta, hogy a Google-projektben be kell kapcsolni a
 *      Drive/Gmail/Naptar/Fotok API-t. Ha kimaradt, a Drive minden kerest 403
 *      SERVICE_DISABLED-del utasitott el -- es ez a besorolatlan elutasitasok
 *      koze esett, azaz az onellenorzes HALLGATOTT, mikozben semmi nem
 *      szinkronizalt (a NULLA-elv sertese).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkOauthClientText, saveOauthClient, googleOauthClientPath } from '../google-oauth-client.js'
import { driveApiEnableUrl, driveErrorKind, driveVeglegesenElutasitva } from '../drive-error-kind.js'
import { driveSyncRows, utolsoFutasAkadasai } from '../web/system-health.js'
import { SETUP_ITEMS } from '../web/setup-wizard-registry.js'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const DESKTOP = JSON.stringify({
  installed: {
    client_id: '1234567890-abcdef.apps.googleusercontent.com',
    project_id: 'marveen-teszt',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: 'GOCSPX-teszt',
    redirect_uris: ['http://localhost'],
  },
})

describe('az engedely-fajl ellenorzese', () => {
  it('az asztali kliens atmegy, a projekt-azonositoval', () => {
    const r = checkOauthClientText(DESKTOP)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.projectId).toBe('marveen-teszt')
      expect(JSON.parse(r.clientJson).installed.client_secret).toBe('GOCSPX-teszt')
    }
  })

  it('a webes kliens kulon hibat kap (a bejelentkezes a vegen bukna)', () => {
    const web = DESKTOP.replace('"installed"', '"web"')
    expect(checkOauthClientText(web)).toEqual({ ok: false, error: 'web_client' })
  })

  it('a rossz fajlok emberi hibakodot kapnak, nem kivetelt', () => {
    expect(checkOauthClientText('nem json')).toEqual({ ok: false, error: 'not_json' })
    expect(checkOauthClientText('[]')).toEqual({ ok: false, error: 'no_client' })
    expect(checkOauthClientText('{"type":"service_account"}')).toEqual({ ok: false, error: 'no_client' })
    expect(checkOauthClientText(JSON.stringify({ installed: { client_id: 'x', client_secret: 's' } })))
      .toEqual({ ok: false, error: 'no_client_id' })
    expect(checkOauthClientText(JSON.stringify({ installed: { client_id: '1-a.apps.googleusercontent.com' } })))
      .toEqual({ ok: false, error: 'no_client_secret' })
    expect(checkOauthClientText('x'.repeat(70 * 1024))).toEqual({ ok: false, error: 'too_big' })
  })
})

describe('mentes', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gclient-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('friss telepitesen letrehozza, 0600 joggal', () => {
    const r = saveOauthClient(DESKTOP, { storeDir: dir })
    expect(r).toEqual({ ok: true, projectId: 'marveen-teszt', replaced: false })
    const p = googleOauthClientPath(dir)
    expect(JSON.parse(readFileSync(p, 'utf-8')).installed.client_id).toMatch(/apps\.googleusercontent\.com$/)
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('meglevot csak kimondott csereve ir felul', () => {
    const p = googleOauthClientPath(dir)
    writeFileSync(p, '{"installed":{"client_id":"regi"}}')
    expect(saveOauthClient(DESKTOP, { storeDir: dir })).toEqual({ ok: false, error: 'exists' })
    expect(readFileSync(p, 'utf-8')).toContain('regi')
    expect(saveOauthClient(DESKTOP, { storeDir: dir, replace: true })).toMatchObject({ ok: true, replaced: true })
    expect(readFileSync(p, 'utf-8')).not.toContain('regi')
  })

  it('hibas fajlnal semmit nem ir', () => {
    expect(saveOauthClient('nem json', { storeDir: dir }).ok).toBe(false)
    expect(existsSync(googleOauthClientPath(dir))).toBe(false)
  })
})

describe('a varazslo a feluletrol vezet vegig', () => {
  const item = SETUP_ITEMS.find((i) => i.id === 'google-oauth')!

  it('a lepes feltolto folyamat, es a negy API-t is bekapcsoltatja', () => {
    expect(item.flowId).toBe('google-oauth-client')
    expect(item.stepKeys).toContain('wizard.item.google_oauth_step_apis')
    expect(item.stepKeys).toContain('wizard.item.google_oauth_step_consent')
    const urls = (item.links || []).map((l) => l.url).join(' ')
    for (const api of ['gmail.googleapis.com', 'drive.googleapis.com', 'calendar-json.googleapis.com', 'photospicker.googleapis.com']) {
      expect(urls).toContain(api)
    }
  })

  it('egyik nyelven sem kéri, hogy kezzel masoljuk a store/ ala', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const src = read(f)
      const sor = src.split('\n').filter((l) => /'wizard\.item\.google_oauth_(step5|desc)'/.test(l)).join('\n')
      expect(sor).not.toContain('store/google-oauth-client.json')
    }
  })

  it('minden uj kulcs megvan mindket nyelven', () => {
    const keys = [
      'wizard.item.google_oauth_step_consent', 'wizard.item.google_oauth_step_apis',
      'wizard.link.google_consent', 'wizard.link.api_gmail', 'wizard.link.api_drive',
      'wizard.link.api_calendar', 'wizard.link.api_photos',
      'wizard.gclient.pick', 'wizard.gclient.saved', 'wizard.gclient.confirm_replace',
      'wizard.gclient.err_not_json', 'wizard.gclient.err_web_client', 'wizard.gclient.err_no_client',
      'wizard.gclient.err_no_client_id', 'wizard.gclient.err_no_client_secret',
      'wizard.gclient.err_too_big', 'wizard.gclient.err_exists', 'wizard.gclient.err_network',
      'health.drive_sync_api_disabled', 'health.drive_sync_api_disabled_action', 'selfcheck_info.open_link',
    ]
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const src = read(f)
      for (const k of keys) expect(src, `${f}: ${k}`).toContain(`'${k}'`)
    }
  })

  it('a felulet a feltolto vegpontot hivja, es a flow be van kotve', () => {
    const app = read('web/app.js')
    expect(app).toContain("item.flowId === 'google-oauth-client' ? wizardGoogleClientHtml(item)")
    expect(app).toContain("if (item.flowId === 'google-oauth-client') wireWizardGoogleClient()")
    expect(app).toContain("fetch('/api/google-oauth-client'")
    expect(read('src/web/routes/setup-wizard.ts')).toContain("path === '/api/google-oauth-client' && method === 'POST'")
  })
})

// A Google valasza, ahogy a naplo tarolja (a `Drive 403: ` elotag + csonkolt torzs).
const KIKAPCSOLT = 'Drive 403: {\n  "error": {\n    "code": 403,\n    "message": "Google Drive API has not been used in project 987654321012 before or it is disabled. Enable it by visiting https://evil.example/x then retry.",\n    "status": "PERMISSION_DENIED",\n    "details": [{"reason": "SERVICE_DISABLED"'

describe('a kikapcsolt Drive API sajat sort kap', () => {
  it('nem auth, nem "Google nem adja ki", es nem kerul a kihagyando-listara', () => {
    expect(driveErrorKind(KIKAPCSOLT)).toBe('api_disabled')
    expect(driveVeglegesenElutasitva(KIKAPCSOLT)).toBe(false)
  })

  it('a link a Google Console-ra mutat, a hibauzenet cimet NEM veszi at', () => {
    const url = driveApiEnableUrl(KIKAPCSOLT)
    expect(url).toBe('https://console.cloud.google.com/apis/library/drive.googleapis.com?project=987654321012')
    expect(url).not.toContain('evil')
    expect(driveApiEnableUrl('')).toBe('https://console.cloud.google.com/apis/library/drive.googleapis.com')
  })

  it('a legutobbi futas akadasai kozott megjelenik, linkkel', () => {
    const a = utolsoFutasAkadasai(
      [{ runId: 'r1', at: new Date().toISOString(), count: 1 }],
      () => [{ account: 'friss', phase: 'mappa', reason: `a mappát nem tudtam kiolvasni – ${KIKAPCSOLT}`, driveName: 'a Drive gyökere' }],
    )
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ kind: 'api_disabled', account: 'friss' })
    expect(a[0].url).toContain('project=987654321012')
  })

  it('az onellenorzes PIROS sort ad, es a varakozo szamot nem mondja "magatol halad"-nak', () => {
    const most = Date.now()
    const r = driveSyncRows(most, { fajta: 'rendben', parok: [
      { account: 'friss', lastRunAt: new Date(most).toISOString(), lastPending: 12 },
    ] } as any, { letezik: true, bekapcsolva: true }, true, [
      { kind: 'api_disabled' as const, account: 'friss', files: 1, names: '', message: '', at: new Date(most).toISOString(), url: driveApiEnableUrl(KIKAPCSOLT) },
    ])
    const sor = r.find((x) => x.id === 'drive_sync_api_disabled')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ account: 'friss' })
    expect(String(sor?.params?.url)).toMatch(/^https:\/\/console\.cloud\.google\.com\//)
    expect(r.some((x) => x.id === 'drive_sync_incomplete')).toBe(false)
    expect(r.some((x) => x.id === 'drive_sync_auth_stuck')).toBe(false)
  })

  it('az info-ablak csak Google Console-linket tesz kattinthatova', () => {
    const app = read('web/app.js')
    expect(app).toContain("url.startsWith('https://console.cloud.google.com/')")
  })
})
