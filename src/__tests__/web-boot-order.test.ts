/**
 * A vezerlopult INDULASI SORRENDJE (web/app.js).
 *
 * Miert van ez a teszt: a Boss bejelentesere ("az iroda Depo alatti resz nem
 * mukodik. gombok nem csinalnak semmit") ket, egymast fedo hiba jott elo, es
 * mindketto INDULASI SORREND volt, nem logika:
 *
 *   1. A lap-iranyitas (routeFromHash) az app.js kozepen futott le. Innen a
 *      switchPage() olyan oldal-betoltoket hivott, amelyek allapot-valtozoi
 *      csak a fajl VEGEN kapnak erteket. A `let` ilyenkor nem undefined-ot ad,
 *      hanem hibat dob -- a Depo betoltoje az elso soran elszallt, igy egyetlen
 *      gombja sem kapott esemenykezelot. (Ugyanez a hibafajta mar KETSZER
 *      elofordult ebben a fajlban: `emailAccounts` es a naplo/archived
 *      betoltok.)
 *   2. A munkateruelet-visszaallitas a `.active` menupontbol probalta kitalalni,
 *      hol allunk. Indulaskor viszont meg egyik menupont sem aktiv, ezert "ez
 *      nem irodai oldal" alapon atdobta a lapot az Emailre.
 *
 * Ezek forras-horgonyok: a bongeszos bizonyitast a
 * tests/smoke/page-direct-load.spec.ts vegzi (az futo vezerlopultot igenyel),
 * ez viszont a rendes tesztfuttatasban is megfogja a visszaeseset.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')

describe('a kezdo lap-iranyitas nem futhat a fajl kozepen', () => {
  it('a routeFromHash csak a dokumentum feldolgozasa utan indul', () => {
    const blokk = APP.slice(APP.indexOf('function routeFromHash'), APP.indexOf('function routeFromHash') + 1600)
    expect(blokk).toContain("window.addEventListener('hashchange', routeFromHash)")
    // Nem a puszta `routeFromHash()` hivas all itt, hanem a keslelteto ag.
    expect(blokk).toContain("document.readyState === 'loading'")
    expect(blokk).toContain("document.addEventListener('DOMContentLoaded', routeFromHash, { once: true })")
  })

  it('a Depo idozitoje hoistolhato (var), tehat korai hivasnal sem dob hibat', () => {
    // `let _depoPoll` eseten a _depoStopPoll() korai hivasa
    // "Cannot access '_depoPoll' before initialization" hibaval all meg.
    expect(APP).toContain('var _depoPoll = null')
    expect(APP).not.toContain('let _depoPoll')
  })

  it('a _depoStopPoll tovabbra is takarit (a var nem tette feleslegesse)', () => {
    const f = APP.slice(APP.indexOf('function _depoStopPoll'), APP.indexOf('function _depoStopPoll') + 160)
    expect(f).toContain('clearInterval(_depoPoll)')
    expect(f).toContain('_depoPoll = null')
  })
})

describe('a munkateruelet-visszaallitas nem a .active menupontra tamaszkodik', () => {
  it('a setWorkspace elfogadja, MELYIK oldalra tartunk', () => {
    const f = APP.slice(APP.indexOf('function setWorkspace'), APP.indexOf('function setWorkspace') + 2200)
    expect(f).toContain("const activePage = (opts && opts.page) || activeLink?.dataset?.page")
    // A ket atdobas maradjon meg: ez a funkcio lenyege.
    expect(f).toContain("if (ws === 'iroda' && !activeIsIroda) location.hash = 'email'")
    expect(f).toContain("if (ws === 'marvin' && activeIsIroda) location.hash = 'overview'")
  })

  it('az indulo visszaallitas atadja az URL-ben megnevezett oldalt', () => {
    expect(APP).toContain("setWorkspace(ws, { persist: false, page: named || undefined })")
  })

  it('a Depo benne van az Iroda oldalaiban (a markupbol olvasva)', () => {
    const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf8')
    const nav = html.slice(html.indexOf('id="navIroda"'), html.indexOf('id="navIroda"') + 12000)
    expect(nav).toContain('data-page="depo"')
    // A lista a markupbol jon, nem kezzel karbantartott felsorolasbol.
    expect(APP).toContain("document.querySelectorAll('#navIroda [data-page]')")
  })
})
