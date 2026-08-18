// A loopback-varakozas: miert bukott el sokszor a bejelentkeztetes, es mit
// mond most a felhasznalonak.
//
// Boss, 2026-08-15: "Nem sikerult: HIBA: nem erkezett ervenyes kod
// (idotullepes vagy a loopback-atiranyitas nem ert ide). sokszor ezt irja ki."
//
// Ket meres vitte ide:
//   1. Egy WSL-listener a 127.0.0.1:47921-en Windowsbol ELERHETO volt -- tehat
//      a "loopback nem ert ide" magyarazat onmagaban HAMIS.
//   2. A naplo 22 inditast mutatott, kozottuk 14 perces szunetekkel (=10 perc
//      varakozas + a hibauzenet + ujraprobalas).
//
// A regi kod egyetlen kerest szolgalt ki (`[srv.handle_request() for _ in
// range(1)]`), es UTANA a port zarva volt. Barmi, ami elobb er oda -- favicon,
// egy nyitva felejtett regi ful ujratoltese --, elhasznalta az egy szal
// lehetoseget, es a VALODI atiranyitas mar sehova nem erkezett. Ugyanaz az
// egyetlen mondat jott ki negy kulonbozo okra is, ezert nem lehetett ravenni
// semmit.
//
// Itt a VALODI scriptet futtatjuk, valodi HTTP-keresekkel a loopback-portra.
// A halozati hivas (a kod bevaltasa) ki van stubolva: semmi nem beszel a
// Google-lel, es egyetlen igazi token sem keletkezik.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'google-auth.py')

// Sajat port, hogy egy VALODI, epp futo bejelentkeztetest (47921) ne zavarjunk.
const TEST_PORT = 47931

/**
 * A valodi cmd_auth() futtatasa. A kliens-szal ugy viselkedik, mint a bongeszo:
 * megvarja, amig a port hallgat, es elkuldi a `mode` szerinti kereseket.
 * Kiirja, hogy megtortent-e a bevaltas, es mi lett a hibauzenet elso sora.
 */
const DRIVER = `
import importlib.util, json, os, socket, sys, threading, time, urllib.error, urllib.parse, urllib.request

script, tmp, mode, wait, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
spec = importlib.util.spec_from_file_location('gauth', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.PENDING = os.path.join(tmp, 'pending.json')
mod.TOKENS = os.path.join(tmp, 'tokens.json')
mod.WAIT_SECS = wait
mod.FIXED_PORT = port
mod._load_client = lambda: {'client_id': 'teszt', 'client_secret': 'teszt'}

exchanged = []
mod._exchange_code = lambda code, account: exchanged.append({'code': code, 'account': account})

# 'busy_port' mod: valaki MAS fogja a portot, es csak fel masodperc mulva engedi
# el -- pont ez tortenik, amikor a felhasznalo megszakittatja a masik folyamatot.
squatter = []
if mode == 'busy_port':
    import socketserver
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port)); s.listen(1)
    squatter.append(s)
    threading.Timer(0.6, lambda: s.close()).start()

def get(query):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/%s' % (port, query), timeout=5) as r:
            return r.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return 'HTTP%d' % e.code

bodies = []

def client():
    if mode == 'busy_port':
        time.sleep(1.0)   # amig a masik el nem engedi a portot
    # Megvarjuk, hogy a szerver felalljon. Ez a proba MAGA is egy "kobasza"
    # keres -- pont az, ami a regi kodban elhasznalta az egyetlen kiszolgalast.
    for _ in range(400):
        try:
            bodies.append(('proba', get('favicon.ico')))
            break
        except Exception:
            time.sleep(0.05)
    if mode == 'stray_only':
        bodies.append(('stray2', get('favicon.ico')))
        return
    time.sleep(0.1)
    state = json.load(open(mod.PENDING))['state']
    if mode in ('stray_then_code', 'busy_port'):
        bodies.append(('kod', get('?' + urllib.parse.urlencode({'code': 'JO-KOD', 'state': state}))))
    elif mode == 'old_window':
        bodies.append(('regi', get('?' + urllib.parse.urlencode({'code': 'REGI-KOD', 'state': 'MAS-STATE'}))))
    elif mode == 'old_then_good':
        bodies.append(('regi', get('?' + urllib.parse.urlencode({'code': 'REGI-KOD', 'state': 'MAS-STATE'}))))
        time.sleep(0.2)
        bodies.append(('kod', get('?' + urllib.parse.urlencode({'code': 'JO-KOD', 'state': state}))))
    elif mode == 'denied':
        bodies.append(('elutasitva', get('?' + urllib.parse.urlencode({'error': 'access_denied', 'state': state}))))

th = None
if mode != 'silent':
    th = threading.Thread(target=client, daemon=True)
    th.start()

err = ''
try:
    mod.cmd_auth('tesztfiok')
except SystemExit as e:
    err = str(e.code or '')
if th:
    th.join(timeout=10)
print('RESULT ' + json.dumps({'exchanged': exchanged, 'error': err, 'bodies': bodies}))
`

type Run = {
  exchanged: { code: string; account: string }[]
  error: string
  bodies: [string, string][]
}

let dir: string
const cache = new Map<string, Run>()

/** Egy mod lefuttatasa (modonkent egyszer -- mindegyik valodi varakozas). */
function run(mode: string, wait = 3): Run {
  const key = `${mode}:${wait}`
  const hit = cache.get(key)
  if (hit) return hit
  const out = execFileSync('python3', ['-c', DRIVER, SCRIPT, dir, mode, String(wait), String(TEST_PORT)], {
    encoding: 'utf-8', timeout: 60_000,
  })
  const line = out.split('\n').find((l) => l.startsWith('RESULT '))
  if (!line) throw new Error(`nincs RESULT sor:\n${out}`)
  const parsed = JSON.parse(line.slice('RESULT '.length)) as Run
  cache.set(key, parsed)
  return parsed
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gauth-loopback-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('a loopback-szerver tobb kerest is kiszolgal', () => {
  it('egy korabbi, kod nelkuli keres NEM hasznalja el a szervert', () => {
    // EZ a hiba, ami korbe-korbe kuldte a Bosst: a favicon (vagy barmi mas)
    // elvitte az egyetlen kiszolgalast, es a valodi atiranyitas zart portra ert.
    const r = run('stray_then_code')
    expect(r.error, 'a jo kod utan nem lehet hiba').toBe('')
    expect(r.exchanged).toEqual([{ code: 'JO-KOD', account: 'tesztfiok' }])
  })

  it('egy REGI ablak visszaterese sem allitja le a varakozast', () => {
    // A regi ful kodjat elfogadni tilos (a state pont ez ellen van), de a
    // mostani folyamatot sem szabad kilonie: a jo ablak meg johet utana.
    const r = run('old_then_good')
    expect(r.error, 'a jo ablak meg megerkezett').toBe('')
    expect(r.exchanged).toEqual([{ code: 'JO-KOD', account: 'tesztfiok' }])
  })

  it('megvarja, ha valaki meg fogja a portot -- nem esik azonnal kezi utra', () => {
    // Ez a "szakitsd meg a masikat, es inditsd ezt" valasz utani pillanat: a
    // regi folyamat SIGTERM-et kapott, de meg nem engedte el a 47921-et. Egy
    // probalkozassal itt kikotnenk a bemasolgatasnal -- pont annal a lepesnel,
    // amit egy nem-programozo elhagy.
    const r = run('busy_port', 10)
    expect(r.error, 'a kesobb felszabadulo port ne legyen bukas').toBe('')
    expect(r.exchanged).toEqual([{ code: 'JO-KOD', account: 'tesztfiok' }])
  })

  it('a regi ablak kodjat SOSEM valtja be', () => {
    const r = run('old_window')
    expect(r.exchanged, 'idegen state-tel nem lehet bevaltani').toEqual([])
  })
})

describe('minden bukas-fajta MAST mond -- mert mast is kell tenni', () => {
  it('regi ablak: state-eltres, nem "idotulles"', () => {
    const e = run('old_window').error
    expect(e).toMatch(/KORABBI bejelentkeztetes/)
    expect(e).toMatch(/state-eltres/)
    expect(e, 'ne hazudjunk idotullepest').not.toMatch(/nem erkezett vissza semmi/)
  })

  it('a Google elutasitasa nevesitve jon vissza', () => {
    const e = run('denied').error
    expect(e).toMatch(/elutasitotta a jovahagyast \(access_denied\)/)
    expect(run('denied').exchanged).toEqual([])
  })

  it('ha tenyleg nem jott semmi, azt mondja -- es a varakozast is kimondja', () => {
    const e = run('silent', 2).error
    expect(e).toMatch(/nem erkezett vissza semmi/)
    expect(e, 'a "0 perc" ertelmetlen lenne').toMatch(/2 masodperc/)
  })

  it('csak kobasza keresek jottek: azt is megkulonbozteti', () => {
    const e = run('stray_only', 3).error
    expect(e).toMatch(/keres a loopback-portra, de egyikben sem volt jovahagyasi kod/)
  })

  it('MINDEN bukas-uzenet felajanlja a kezi utat', () => {
    for (const mode of ['old_window', 'denied', 'stray_only']) {
      expect(run(mode).error, mode).toMatch(/google-auth\.py exchange/)
    }
    expect(run('silent', 2).error).toMatch(/google-auth\.py exchange/)
  })

  it('a hibauzenet elso sora onmagaban is ertheto -- a felulet csak azt mutatja', () => {
    // google-auth-runner.ts: `flow.output...find(l => l.startsWith('HIBA'))`
    // -- egyetlen sor jut el a dashboardig, tehat annak kell hordoznia a lenyeget.
    for (const mode of ['old_window', 'denied', 'stray_only']) {
      const first = run(mode).error.split('\n')[0]
      expect(first, mode).toMatch(/^HIBA: /)
      expect(first.length, `${mode}: tul rovid ahhoz, hogy elmondja mi tortent`).toBeGreaterThan(40)
    }
  })
})

describe('amit a bongeszoben lat a felhasznalo', () => {
  it('a jo ablak azt latja, hogy kesz', () => {
    const bodies = Object.fromEntries(run('stray_then_code').bodies)
    expect(bodies.kod).toMatch(/hitelesites kesz/)
  })

  it('a regi ablak megtudja, hogy o a regi -- es mit tegyen', () => {
    const bodies = Object.fromEntries(run('old_window').bodies)
    expect(bodies.regi).toMatch(/KORABBI/)
    expect(bodies.regi, 'mondja meg a teendot is').toMatch(/LEGUJABB linket/)
  })

  it('a kod nelkuli keres nem allitja, hogy kesz van', () => {
    const bodies = Object.fromEntries(run('stray_then_code').bodies)
    expect(bodies.proba, 'a favicon-valasz nem mondhatja, hogy sikerult').not.toMatch(/hitelesites kesz/)
  })
})
