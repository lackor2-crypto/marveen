/**
 * Kikapcsolt Gmail / Naptar / Drive API a Google-projektben (kanban #358,
 * friss-telepitesi audit).
 *
 * Friss telepitesen, ha a varazslo "kapcsold be a negy API-t" lepese kimarad,
 * a fiok belep, de a Google minden Gmail/Naptar-keresre 403 SERVICE_DISABLED-et
 * ad. Eddig:
 *   - a `google-auth.py test` az elso hibanal egy nyers
 *     "HTTP Error 403: Forbidden" tracebackkel allt meg -- a torzs, amiben a
 *     SERVICE_DISABLED all, elveszett, es a Naptar/Drive meg sem lett kerdezve;
 *   - az onellenorzes "a Google elutasitja a fiokot, csatlakoztasd ujra"-t
 *     mondott, ami semmit nem old meg, es a sor orokre piros maradt;
 *   - a `google.py` (az agensek eszkoze) 120 karakterre vagta a torzset, pont
 *     a lenyeg elott.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProbeOutput, parseDisabledApis, googleApiEnableUrl } from '../web/google-accounts.js'
import { googleLiveRows } from '../web/system-health.js'
import { GOOGLE_LIVE_FILE, markGoogleLiveOk, readGoogleLiveCheck, recordGoogleLiveProbe } from '../web/google-live-check.js'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
const NOW = Date.now()

describe('a probe kimenetenek ertelmezese', () => {
  it('kikapcsolt Gmail + Naptar: sajat fajta, a mukodo Drive latszik, a link szamjegyekbol epul', () => {
    const out = [
      'API-KIKAPCSOLVA: gmail project=987654321012',
      'API-KIKAPCSOLVA: calendar project=987654321012',
      'Drive fajlok (minta): 3',
    ].join('\n')
    const r = parseProbeOutput(out, '', 1)
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('api-disabled')
    expect(r.disabledApis).toEqual(['gmail', 'calendar'])
    expect(r.services).toEqual({ gmail: false, calendar: false, drive: true })
    expect(r.apiEnableUrl).toBe('https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=987654321012')
    expect(r.error).toContain('Gmail API')
  })

  it('csak a Naptar van kikapcsolva: a Gmail el, a fiok megis jelolve van', () => {
    const r = parseProbeOutput('[x] Gmail: a@b.hu - 5 uzenet\nAPI-KIKAPCSOLVA: calendar project=\nDrive fajlok (minta): 1', '', 1)
    expect(r.services.gmail).toBe(true)
    expect(r.kind).toBe('api-disabled')
    expect(r.apiEnableUrl).toBe('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com')
  })

  it('a lejart hozzaferes elsobbseget kap (azt kell elobb megoldani)', () => {
    const r = parseProbeOutput('API-KIKAPCSOLVA: gmail project=123456', 'invalid_grant', 1)
    expect(r.kind).toBe('expired')
  })

  it('nem-szamjegyes projekt nem kerul a linkbe', () => {
    expect(parseDisabledApis('API-KIKAPCSOLVA: drive project=evil.example').project).toBeNull()
    expect(googleApiEnableUrl('drive', 'evil')).toBe('https://console.cloud.google.com/apis/library/drive.googleapis.com')
  })

  it('a sikeres probe nem kap api-disabled jelzest', () => {
    const r = parseProbeOutput('[x] Gmail: a@b.hu - 5 uzenet\nCalendar naptarak: 2\nDrive fajlok (minta): 3\nOK', '', 0)
    expect(r.ok).toBe(true)
    expect(r.kind).toBeNull()
    expect(r.disabledApis).toEqual([])
  })
})

describe('az onellenorzes sora', () => {
  const meres = (accounts: any[]) => ({ checkedAt: NOW, accounts })

  it('kikapcsolt API: sajat PIROS sor linkkel, NEM "csatlakoztasd ujra", es nincs zold sor', () => {
    const rows = googleLiveRows(NOW, meres([
      { id: 'friss', ok: false, kind: 'api-disabled', disabledApis: ['gmail', 'calendar'], apiEnableUrl: googleApiEnableUrl('gmail', '987654321012') },
    ]), 1, 0)
    const sor = rows.find(r => r.id === 'google_api_disabled')
    expect(sor?.status).toBe('bad')
    expect(sor?.params).toMatchObject({ names: 'friss', apis: 'Gmail API, Google Calendar API' })
    expect(String(sor?.params?.url)).toMatch(/^https:\/\/console\.cloud\.google\.com\/apis\/library\/gmail\.googleapis\.com/)
    expect(rows.some(r => r.id === 'google_live_bad')).toBe(false)
    expect(rows.some(r => r.id === 'google_live_ok')).toBe(false)
  })

  it('vegyes eset: a lejart fiok tovabbra is a google_live_bad sorba megy', () => {
    const rows = googleLiveRows(NOW, meres([
      { id: 'friss', ok: false, kind: 'api-disabled', disabledApis: ['gmail'], apiEnableUrl: null },
      { id: 'regi', ok: false, kind: 'expired' },
    ]), 2, 0)
    expect(rows.find(r => r.id === 'google_live_bad')?.params).toMatchObject({ names: 'regi', n: 1 })
    expect(rows.find(r => r.id === 'google_api_disabled')?.params?.url).toBe('https://console.cloud.google.com/apis/library')
  })
})

describe('a mert allapot frissitese', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'glive-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const ir = (accounts: any[]) => writeFileSync(join(dir, GOOGLE_LIVE_FILE), JSON.stringify({ checkedAt: NOW, accounts }))

  it('egy sikeres bejelentkezes NEM torli a kikapcsolt-API jelzest (az nem login-hiba)', () => {
    ir([{ id: 'friss', ok: false, kind: 'api-disabled', disabledApis: ['gmail'] }])
    markGoogleLiveOk('friss', dir)
    expect(readGoogleLiveCheck(dir)!.accounts[0]).toMatchObject({ ok: false, kind: 'api-disabled' })
  })

  it('a kenyszeritett probe (Ellenorzes gomb) friss merese felulirja -- bekapcsolas utan azonnal zold', () => {
    ir([{ id: 'friss', ok: false, kind: 'api-disabled', disabledApis: ['gmail'] }])
    recordGoogleLiveProbe('friss', { ok: true, kind: null, disabledApis: [], apiEnableUrl: null }, dir)
    expect(readGoogleLiveCheck(dir)!.accounts[0]).toEqual({ id: 'friss', ok: true, kind: null })
  })

  it('meres nelkul nem talal ki fajlt', () => {
    recordGoogleLiveProbe('friss', { ok: true, kind: null }, dir)
    expect(readGoogleLiveCheck(dir)).toBeNull()
  })
})

// A valodi python kod, egy helyi szerverrel, ami ugy valaszol, mint a Google.
const DRIVER = String.raw`
import http.server, importlib.util, io, json, sys, threading, contextlib
BODY = json.dumps({"error": {"code": 403, "message": "Gmail API has not been used in project 987654321012 before or it is disabled. Enable it by visiting https://evil.example/x then retry.", "status": "PERMISSION_DENIED", "details": [{"reason": "SERVICE_DISABLED"}]}}).encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        code = 403 if self.path.startswith("/off") else 500
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(BODY if code == 403 else b'{"error":{"message":"belso hiba"}}')
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}"
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
auth = load(sys.argv[1], "gauth")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    a = auth._probe_api("tok", "gmail", base + "/off")
    b = auth._probe_api("tok", "drive", base + "/boom")
print(json.dumps({"auth": buf.getvalue(), "a": a, "b": b}))
g = load(sys.argv[2], "gcli")
try:
    g._get("https://gmail.googleapis.com/gmail/v1/users/me/profile".replace("https://gmail.googleapis.com", base + "/off/gmail.googleapis.com"), "tok")
except Exception as e:
    print(json.dumps({"cli": str(e)}))
`

describe('a python oldal (valodi kod, hamis Google)', () => {
  it('google-auth.py test: a kikapcsolt API gepi sort ad, a tobbi hiba olvashato sort; google.py: teendo + link', () => {
    const out = execFileSync('python3', ['-c', DRIVER, join(ROOT, 'scripts/google-auth.py'), join(ROOT, 'scripts/google.py')], {
      encoding: 'utf-8', timeout: 30_000,
    }).trim().split('\n')
    const auth = JSON.parse(out[0])
    expect(auth.a).toBeNull()
    expect(auth.b).toBeNull()
    expect(auth.auth).toContain('API-KIKAPCSOLVA: gmail project=987654321012')
    expect(auth.auth).toContain('HIBA (drive): 500 belso hiba')
    expect(parseProbeOutput(auth.auth, '', 1).kind).toBe('api-disabled')
    const cli = JSON.parse(out[1]).cli as string
    expect(cli).toContain('nincs bekapcsolva')
    expect(cli).toContain('https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=987654321012')
    expect(cli).not.toContain('evil')
  })
})

describe('a felulet', () => {
  it('minden uj kulcs megvan mindket nyelven', () => {
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const src = read(f)
      for (const k of ['health.google_api_disabled', 'health.google_api_disabled_action', 'gconn.api_disabled_note', 'gconn.api_enable']) {
        expect(src, `${f}: ${k}`).toContain(`'${k}'`)
      }
    }
  })

  it('a Fiokok oldalon kikapcsolt API-nal bekapcsolo link van, nem ujra-bejelentkeztetes', () => {
    const app = read('web/app.js')
    expect(app).toContain("a.error && !apiOff ? `<button class=\"btn-primary btn-compact\" data-gact=\"reauth\"")
    expect(app).toContain("a.apiEnableUrl.startsWith('https://console.cloud.google.com/')")
  })
})
