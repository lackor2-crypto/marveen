// Boss, 2026-08-19: "az elso oszlop es masodik oszlop sem toltodik be hamar.
// sokat kell varni ra." A hullamkepben az email-oldal ELSO kerese a
// /api/email/accounts volt, es a mappa-lista (1. oszlop) meg csak ez UTAN
// indult -- indulaskori tolongasban ez ~0,6-1,2 mp puszta varakozas volt,
// mikozben a legutobb hasznalt fiokot mar a bongeszo is tudja (loadEmailUiState).
// Ez a teszt azt orzi, hogy a ket oszlop NE varjon a fiok-listara, es hogy a
// spekulacio ne tudjon rossz allapotot kirajzolni.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractBlock(source: string, head: string): string {
  const at = source.indexOf(head)
  if (at < 0) throw new Error('nincs ilyen blokk: ' + head)
  let depth = 0
  for (let j = source.indexOf('{', at); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(at, j + 1) }
  }
  throw new Error('nem zarodik: ' + head)
}

const loadPageSrc = extractBlock(app, 'async function loadEmailPage(')
// CSAK az elso betoltes aga -- a fuggveny tovabbi reszeben is van
// mappa-toltes (fiokvaltas), az ide nem szamit bele.
const firstLoad = extractBlock(loadPageSrc, 'if (!emailLoaded)')
const loadMailboxesSrc = extractBlock(app, 'async function loadEmailMailboxes(')

describe('az elso ket oszlop nem var a fiok-listara', () => {
  it('a mappa-lista mar a fiok-lekeres ELOTT elindul', () => {
    const speculative = firstLoad.indexOf('loadEmailMailboxes()')
    const accountNav = firstLoad.indexOf('await ensureEmailAccountNav()')
    expect(speculative, 'nincs korai mappa-toltes').toBeGreaterThan(0)
    expect(accountNav, 'a fiok-lekeres eltunt').toBeGreaterThan(0)
    expect(speculative, 'a mappa-lista megint a fiok-lista vegere var').toBeLessThan(accountNav)
  })

  it('a korai toltes a MEGJEGYZETT fiokkal indul, nem talalgat', () => {
    const upToNav = firstLoad.slice(0, firstLoad.indexOf('await ensureEmailAccountNav()'))
    expect(upToNav.includes('loadEmailUiState()'), 'honnan tudna a fiokot').toBe(true)
    expect(upToNav.includes('const speculativeAccount = saved?.account')).toBe(true)
    expect(upToNav.includes('if (speculativeAccount)'), 'fiok nelkul nem indulhat lekeres').toBe(true)
  })

  it('a korai toltest NEM varjuk meg -- kulonben semmit sem nyertunk', () => {
    const upToNav = firstLoad.slice(0, firstLoad.indexOf('await ensureEmailAccountNav()'))
    expect(upToNav.includes('await loadEmailMailboxes()'), 'await-elve ugyanaz a sorbanallas').toBe(false)
  })

  it('ha a megjegyzett fiok mar nincs meg, ujratolt a helyessel', () => {
    const afterNav = firstLoad.slice(firstLoad.indexOf('await ensureEmailAccountNav()'))
    expect(afterNav.includes('if (emailAccount !== speculativeAccount) await loadEmailMailboxes()')).toBe(true)
  })

  it('egyezo fiok eseten nincs masodik, felesleges lekeres', () => {
    const afterNav = firstLoad.slice(firstLoad.indexOf('await ensureEmailAccountNav()'))
    const calls = afterNav.split('loadEmailMailboxes()').length - 1
    expect(calls, 'a helyesbito toltes csak feltetellel futhat').toBe(1)
  })
})

describe('ket parhuzamos mappa-toltes nem zavarja ossze a listat', () => {
  it('van generacio-orzo, es a valasz UTAN ellenorzi', () => {
    expect(loadMailboxesSrc.includes('const requestId = ++emailMailboxRequestId')).toBe(true)
    const guard = loadMailboxesSrc.indexOf('if (requestId !== emailMailboxRequestId) return')
    const jsonAt = loadMailboxesSrc.indexOf('await mailboxesRes.json()')
    expect(guard, 'nincs orzo -- a regi valasz felulirhatja a frisset').toBeGreaterThan(0)
    expect(guard, 'az orzonek a valasz megerkezese UTAN kell allnia').toBeGreaterThan(jsonAt)
  })

  it('a lejart lekeres nem rajzol es nem indit levellistat', () => {
    const afterGuard = loadMailboxesSrc.slice(loadMailboxesSrc.indexOf('if (requestId !== emailMailboxRequestId) return'))
    expect(afterGuard.includes('pane.innerHTML = systemHtml'), 'a rajzolas az orzo utan van').toBe(true)
    expect(afterGuard.includes('loadEmailEnvelopes('), 'a levellista is csak az orzo utan indulhat').toBe(true)
  })
})
