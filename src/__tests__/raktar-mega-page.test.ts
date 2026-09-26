// #391 -- RAKTAR -> MEGA menupont (Boss TG 1254 + 6380).
//
// A #360 a MEGA mappat csak az Intezo fajaba tette; a bal menu Raktar
// csoportjaban a Drive / Fotok / Git tarolok mellol hianyzott. Forrasszoveg-
// ellenorzes, mint az intezo-* tesztek: a tobb tizezer soros bongeszo-fajl
// modulkent nem toltheto be.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync('web/index.html', 'utf8')
const app = readFileSync('web/app.js', 'utf8')
const hu = readFileSync('web/lang/hu.js', 'utf8')
const en = readFileSync('web/lang/en.js', 'utf8')

describe('Raktar -> MEGA (#391)', () => {
  it('a MEGA menupont a Raktar csoportban all, a Git tarolok utan', () => {
    const group = html.slice(html.indexOf('id="depotNavItems"'), html.indexOf('id="depotNavItems"') + 4000)
    expect(group.indexOf('data-page="gitrepos"')).toBeGreaterThan(0)
    expect(group.indexOf('data-page="megadepot"')).toBeGreaterThan(group.indexOf('data-page="gitrepos"'))
  })

  it('van hozza lap, betolto, es a Raktar csoport nyitva marad rajta', () => {
    expect(html).toContain('id="megadepotPage"')
    expect(app).toContain("if (pageId === 'megadepot') loadMegaDepotPage()")
    expect(app).toMatch(/pageId === 'gitrepos' \|\| pageId === 'megadepot'\)/)
  })

  it('a ket forrast parhuzamosan keri, es a "nem lattam oda" kulon mondat', () => {
    expect(app).toContain("await Promise.all([fetch('/api/mega'), fetch('/api/storages')])")
    expect(app).toContain("t('megadepot.load_failed'")
    expect(app).toContain("t('megadepot.empty_no_accounts')")
    expect(app).toContain("t('megadepot.empty_no_rclone')")
  })

  it('a fiok mappaja egy kattintassal nyilik az Intezoben', () => {
    expect(app).toMatch(/data-megadepot-open[\s\S]{0,400}_intezoPath = b\.getAttribute\('data-megadepot-open'\)/)
  })

  it('minden uj szoveg ket nyelven megvan', () => {
    for (const k of ['nav.megadepot', 'megadepot.page_title', 'megadepot.load_failed', 'megadepot.empty_no_accounts',
      'megadepot.empty_no_rclone', 'megadepot.used', 'megadepot.open', 'megadepot.no_folder', 'megadepot.manage']) {
      expect(hu).toContain("'" + k + "'")
      expect(en).toContain("'" + k + "'")
    }
  })
})

describe('Raktar -> MEGA: a fiok tartalma helyben (#398)', () => {
  const page = html.slice(html.indexOf('id="megadepotPage"'), html.indexOf('id="megadepotPage"') + 6000)
  const loader = app.slice(app.indexOf('// === RAKTAR -> MEGA (#391) ==='), app.indexOf("document.getElementById('megadepotAccountsBtn')"))

  it('a lapon ott a bongeszo: morzsasor, lista, ures-mappa es kulon hiba-doboz, hasabos nezet', () => {
    for (const id of ['megadepotBrowser', 'megadepotBreadcrumb', 'megadepotBrowseList', 'megadepotEmpty',
      'megadepotError', 'megadepotMulti', 'megadepotAccountSelect', 'megadepotAllToggle']) {
      expect(page).toContain('id="' + id + '"')
    }
    // Ugyanazok a lista-osztalyok, mint a Drive-on -- ugyanugy nez ki, mobilon is.
    expect(page).toContain('class="drive-list"')
    expect(page).toContain('class="drive-breadcrumb"')
  })

  it('a tartalmat a /api/mega/list adja, fiok + ut parameterrel', () => {
    expect(loader).toContain("fetch('/api/mega/list?name=' + encodeURIComponent(account) + '&path=' + encodeURIComponent(path))")
  })

  it('mappaba belepes a verembe tol, a morzsasor visszavag', () => {
    expect(loader).toMatch(/stack\.push\(\{ path: row\.getAttribute\('data-mega-path'\)/)
    expect(loader).toMatch(/_megaStacks\[account\] = _megaStack\(account\)\.slice\(0,/)
  })

  it('ures mappa es "nem lattam oda" kulon ag, kulon mondattal', () => {
    // A hiba-ag a lista ELOTT dol el: hibanal soha nem latszik az ures-mappa szoveg.
    const fn = loader.slice(loader.indexOf('async function loadMegaFolder'), loader.indexOf('async function loadMegaColumn'))
    expect(fn.indexOf('if (!r.ok)')).toBeGreaterThan(0)
    expect(fn.indexOf('if (!r.ok)')).toBeLessThan(fn.indexOf('empty.hidden = false'))
    expect(fn).toContain('_megaErrorHtml(r.data, r.status)')
    expect(loader).toContain("t('megadepot.browse_failed', { reason })")
    expect(loader).toContain("t('megadepot.empty_folder')")
  })

  it('az Intezo-gomb megmarad, masodlagoskent', () => {
    expect(loader).toContain('btn-secondary btn-compact" data-megadepot-open=')
  })

  it('minden uj szoveg ket nyelven megvan', () => {
    const keys = ['megadepot.root_label', 'megadepot.accounts_heading', 'megadepot.account_select', 'megadepot.open_folder', 'megadepot.empty_folder',
      'megadepot.browse_failed', 'megadepot.browse_detail']
    for (const c of ['rclone_missing', 'login_failed', 'twofa', 'not_activated', 'network', 'transfer_quota',
      'timeout', 'dir_not_found', 'not_found', 'bad_path', 'network_client', 'unknown']) keys.push('megadepot.browse_err_' + c)
    for (const k of keys) {
      expect(hu).toContain("'" + k + "'")
      expect(en).toContain("'" + k + "'")
    }
  })
})
