// Harom dolog, mind egy 2026-08-23-i meresbol:
//
// 1. "a tobbi kartyan van a beallitasok alatt model valaszto. a vscode alat
//    miert nincs?" -- mert nincs mit allitani; ez a kartyan is alljon ott.
// 2. "mellesleg a neve sem egyezik!" -- a transcriptben a 12. sor "VS Code
//    ugynok kartya tesztelese", a 13. sortol vegig "VS Code ugynok tesztelese".
//    A worker az ELSO `ai-title`-nel megallt, a VS Code viszont az UTOLSOT
//    mutatja. Mostantol az utolso nyer, es a fajl VEGET is megnezzuk.
// 3. "a vscode ban nem tudom bezarni. mert nem latok ott semmit." -- merve hat
//    elo `claude` folyamat futott ugyanabbol az egy VS Code ablakbol, kozben a
//    fulek egy resze mar sehol nem latszott. Amit ott bezarni nem lehet, azt
//    innen kell tudni bezarni.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  requestCodeTabClose, takeCodeTabCloseRequests, _resetCodeTabCloseRequests, CLOSE_REQUEST_TTL_MS,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const code = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
const ps1 = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

describe('modell: a kartyan all, hogy hol allithato', () => {
  it('a modell mellett ott a magyarazat, nem csak tooltipben', () => {
    // A `agent-model-badge` tobb kartyan is szerepel -- a KOD-HID kartyajanak
    // reszet nezzuk, kulonben egy masik kartya sora hitelesitene a tesztet.
    const cardAt = app.indexOf('code-bridge-agent-card')
    const footer = app.slice(cardAt, app.indexOf('agent-card-actions', cardAt))
    expect(footer).toContain('agent-model-badge')
    // 2026-08-23, masodik kor: NEM a kartyan, hanem a reszletes ablak MODELL
    // csempeje alatt -- a kartyan mar eleg informacio van.
    expect(footer).not.toContain('cb-model-note')
    const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
    expect(html).toContain('id="cbTileModelNote"')
    expect(html).toContain('data-i18n="cb.card.model_where"')
  })
  it('a szoveg ketnyelvu', () => {
    for (const k of ['cb.card.model_where', 'cb.card.model_where_help']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${k}'`)
    }
  })
})

describe('cim: az UTOLSO ai-title nyer', () => {
  it('a worker nem all meg az elso cimnel', () => {
    // A regi alak: `if (-not $info.title -and $line -match \'"ai-title"\')`.
    expect(ps1).not.toMatch(/if \(-not \$info\.title -and \$line -match '"ai-title"'\)/)
    expect(ps1).toMatch(/if \(\$line -match '"ai-title"'\)/)
  })
  it('a fajl VEGET is megnezi, mert a kesobbi atnevezes ott van', () => {
    expect(ps1).toContain('$tailBytes')
    expect(ps1).toMatch(/Seek\(-\$tailBytes, 'End'\)/)
  })
})

describe('bezaras: a feluletrol le lehet allitani egy beszelgetest', () => {
  beforeEach(() => { _resetCodeTabCloseRequests() })

  it('a keres egyszer megy at, aztan elfogy', () => {
    requestCodeTabClose('abc')
    expect(takeCodeTabCloseRequests()).toEqual(['abc'])
    expect(takeCodeTabCloseRequests()).toEqual([])
  })

  it('a regi keres nem lep eletbe kesobb', () => {
    const t0 = Date.now()
    requestCodeTabClose('abc', t0)
    // Egy kesobb induló worker nem csukhat be valamit oraкkal a kattintas utan.
    expect(takeCodeTabCloseRequests(t0 + CLOSE_REQUEST_TTL_MS + 1)).toEqual([])
  })

  it('ures nevre nem keletkezik keres', () => {
    requestCodeTabClose('   ')
    expect(takeCodeTabCloseRequests()).toEqual([])
  })

  it('a vegpont csak akkor fogadja el, ha van mit leallitani', () => {
    expect(code).toContain("path.endsWith('/close')")
    // A hianyzo PID nem "nincs mit bezarni", hanem "nem latok oda". A nyers
    // `error` kod megmarad (worker/back-compat), de MELLETTE i18n-kulcs is megy,
    // hogy a komuves ne gepi angol kodot lasson (Boss: "a user egy komuves").
    expect(code).toContain("error: 'no-pid', errorKey: 'cb.err.tab_no_pid' }, 409)")
    expect(code).toContain("error: 'worker-offline', errorKey: 'cb.err.worker_offline' }, 409)")
    // A worker a jelentes VALASZABAN kapja meg a kereseket.
    expect(code).toContain('closeSessions: takeCodeTabCloseRequests()')
  })

  it('a worker nem lo ki idegen folyamatot', () => {
    expect(ps1).toContain('function Close-RequestedSessions')
    // PID ujrahasznosulhat: a folyamat NEVET is ellenorizni kell.
    expect(ps1).toMatch(/ProcessName -notmatch '\^\(node\|claude\)\$'[\s\S]{0,120}refusing/)
    expect(ps1).toContain('Stop-Process -Id $p.Id -ErrorAction Stop')
  })

  it('a felulet gombja csak ismert PID mellett all ki', () => {
    const fn = app.slice(app.indexOf('function cbTabsPickHtml'), app.indexOf('function cbTabsPickHtml') + 3000)
    expect(fn).toMatch(/typeof tb\.pid === 'number' && tb\.pid > 0/)
    expect(fn).toContain('cb-tab-close')
    expect(fn).toContain("t('cb.card.tab_idle'")
  })

  it('a hibauzenetek a KOVETKEZO lepest mondjak, es ketnyelvuek', () => {
    for (const k of [
      'cb.card.tab_close', 'cb.card.tab_close_help', 'cb.card.tab_close_confirm',
      'cb.card.tab_close_queued', 'cb.card.tab_close_failed', 'cb.card.tab_close_worker_off',
      'cb.card.tab_close_no_pid', 'cb.card.tab_close_unknown',
      'cb.card.tab_idle', 'cb.card.tab_idle_help',
    ]) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${k}'`)
    }
    // Nem allitjuk, hogy "kesz": a worker allitja le, es ezt ki is mondjuk.
    expect(hu).toMatch(/'cb\.card\.tab_close_queued':[^\n]*munkás/)
  })
})
