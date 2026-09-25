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
