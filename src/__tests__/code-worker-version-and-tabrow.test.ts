import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Boss, 2026-08-23. Harom kerdes egy korben:
 *
 *  1. "kosd be" -- a Windows-vegrehajto elavult TELEPITETT peldanya eddig
 *     nemaan regi adatot kuldott (ez adta a rossz beszelgetes-cimeket).
 *     Mostantol jelenti a verziojat, es az onellenorzes osszeveti a repoban
 *     levovel. A "nem latok oda" KULON ag: nincs meg a szkript -> nem
 *     "rendben", hanem "nem tudom megmondani".
 *
 *  2. "nezd meg hogy ott mi latszik a chat felsorolasbol! Mi a lenyeg?" --
 *     a CIM. A jelzok (kontextus, nema, bezaras) nem vehetik el a helyet.
 *
 *  3. "az online elott balra ... kiirhatnad hogy fut. vagy lealitva" -- a
 *     kartya ugyanazt a `process-indicator` elemet kapja, mint a tobbi.
 */

const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const ps1 = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
const health = readFileSync(join(ROOT, 'src', 'web', 'system-health.ts'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

/** A kod-hid kartyajanak labléce -- a szelet ne legyen ureses. */
function cardFooter(): string {
  const i = app.indexOf('code-bridge-agent-card')
  expect(i).toBeGreaterThan(0)
  const j = app.indexOf('agent-card-actions', i)
  expect(j).toBeGreaterThan(i)
  const slice = app.slice(i, j)
  expect(slice).toContain('agent-model-badge')
  return slice
}

describe('worker verzio: az elavult telepitett peldany nem maradhat nema', () => {
  it('a szkript megmondja a sajat verziojat, es minden jelentessel elkuldi', () => {
    expect(ps1).toMatch(/\$script:WorkerVersion\s*=\s*'[^']+'/)
    // Mindket jelentes-ag (ures lista es normal) viszi.
    const uses = ps1.match(/"workerVersion":/g) || []
    expect(uses.length).toBe(2)
  })

  it('a VART verzio ugyanabbol a fajlbol jon, amit a felulet letoltesre kinal', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'code-worker-version.ts'), 'utf8')
    expect(src).toContain('marvin-code-worker.ps1')
    // A regexp meg is talalja a valodi fajlban levo sort -- kulonben az
    // ellenorzes orokre "nem latok oda"-t mondana.
    const m = /\$script:WorkerVersion\s*=\s*'([^']{1,40})'/.exec(ps1)
    expect(m && m[1]).toBeTruthy()
  })

  it('harom KULON allapot: elavult / verziotlan / nem latok oda', () => {
    expect(health).toContain('code_bridge_worker_stale')
    expect(health).toContain('code_bridge_worker_unversioned')
    expect(health).toContain('code_bridge_worker_unknown')
    // A "nem latok oda" nem csusszanhat ossze a zold sorral.
    const okIdx = health.indexOf("id: 'code_bridge_ok'")
    const unknownIdx = health.indexOf("id: 'code_bridge_worker_unknown'")
    expect(unknownIdx).toBeGreaterThan(0)
    expect(unknownIdx).toBeLessThan(okIdx)
  })

  it('mind a harom sornak van szovege es teendoje, ket nyelven', () => {
    for (const id of ['code_bridge_worker_stale', 'code_bridge_worker_unversioned', 'code_bridge_worker_unknown']) {
      for (const [name, src] of [['hu', hu], ['en', en]] as const) {
        expect(src, `${name}: health.${id}`).toContain(`'health.${id}':`)
        expect(src, `${name}: health.${id}_action`).toContain(`'health.${id}_action':`)
      }
    }
  })
})

describe('ful-sor: a CIM a lenyeg, a tobbi jelzo', () => {
  it('a cim nincs 42 karakterre vagva, es a teljes cim a tooltipben all', () => {
    expect(app).not.toContain("shortDesc(label, 42)")
    expect(app).toContain('<span class="cb-tab-title" title="')
  })

  it('a cim viszi a maradek helyet (min-width: 0 nelkul a jelzok szoritanak)', () => {
    const m = /\.cb-tab-title \{[^}]*\}/.exec(css)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('min-width: 0')
    expect(m![0]).toContain('flex: 1 1 auto')
  })

  it('a bezaras piros x, a felirat a tooltipbe kerult', () => {
    expect(app).toContain('\\u00d7</button>')
    expect(app).toContain("aria-label=\"' + escapeAttr(t('cb.card.tab_close'))")
    const m = /\.cb-tab-close \{[^}]*\}/.exec(css)
    expect(m![0]).toContain('var(--danger')
  })

  it('a nema-jelzes egyetlen pont, az ORASZAM a tooltipben', () => {
    expect(app).toContain('\\u25cf</span>')
    // A tooltip tartalmazza az oraszamot -- kulonben elveszne az informacio.
    expect(app).toContain("t('cb.card.tab_idle', { h: idleH })")
  })
})

describe('kartya: fut / leallitva, ugyanott, mint a tobbi ugynoknel', () => {
  it('a modell-magyarazat NEM a kartyan van, hanem a MODELL csempe alatt', () => {
    expect(cardFooter()).not.toContain('cb-model-note')
    expect(html).toContain('id="cbTileModelNote"')
    expect(html).toContain('data-i18n="cb.card.model_where"')
  })

  it('a kartyan ott a process-indicator, az online-jelzestol balra', () => {
    const footer = cardFooter()
    const run = footer.indexOf('process-indicator')
    const online = footer.indexOf('tg-status')
    expect(run).toBeGreaterThan(0)
    expect(run).toBeLessThan(online)
  })

  it('regi backend (savedEnabled hianyzik) eseten NEM talalgat: az eles allapot latszik', () => {
    const i = app.indexOf('function cbRunPending')
    const src = app.slice(i, app.indexOf('function cbTabsPickHtml', i))
    expect(src).toContain('=== null')
    expect(src).toContain('undefined')
    expect(src).toContain('restarting')
  })

  it('a vegrehajto allapota emberi szo: online / offline', () => {
    expect(hu).toContain("'cb.card.worker_on': 'online'")
    expect(hu).toContain("'cb.card.worker_off': 'offline'")
    expect(en).toContain("'cb.card.worker_on': 'online'")
    for (const key of ['cb.card.run_on_help', 'cb.card.run_off_help', 'cb.card.stop_pending_help', 'cb.health.worker_online', 'cb.health.worker_offline']) {
      expect(hu, `hu: ${key}`).toContain(`'${key}':`)
      expect(en, `en: ${key}`).toContain(`'${key}':`)
    }
  })
})
