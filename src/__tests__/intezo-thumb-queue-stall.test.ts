// #392 -- INTEZO: a belyegkep-sor nem allhat meg (Boss TG 6386: "megallt a
// fotok lathatosaga [...] lefagyott").
//
// A sor egyszerre negy kerest enged. Idokorlat nelkul negy lassu keres (video
// FFmpeg-gel, lassu meghajto) az egesz sort megallitotta; halozati hiba utan a
// csempe pedig vegleg szurke maradt, mert az IntersectionObserver mar levette.
// Forrasszoveg-ellenorzes, mint a tobbi intezo-* teszt. A viselkedest
// Chromiumban (Playwright) szimulalt elakado keresekkel ellenoriztuk: 6 elakado
// kerest kovetoen mind a 10 csempe betoltodott.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync('web/app.js', 'utf8')
const fetchFn = app.slice(app.indexOf('async function _intezoThumbFetch('), app.indexOf('function _intezoThumbPump('))

describe('Intezo belyegkep-sor (#392)', () => {
  it('minden keresnek idokorlatja van (AbortController)', () => {
    expect(app).toMatch(/const _INTEZO_THUMB_TIMEOUT_MS = \d+/)
    expect(fetchFn).toContain('ctrl.abort()')
    expect(fetchFn).toContain('signal: ctrl.signal')
  })

  it('halozati hiba / idotullepes utan a csempe visszakerul a sorba, korlatos szamban', () => {
    expect(fetchFn).toMatch(/_intezoThumbQueue\.push\(box\); _intezoThumbPump\(\)/)
    expect(fetchFn).toContain('tries < _INTEZO_THUMB_TRIES')
    expect(fetchFn).toContain("t('intezo.thumb_slow')")
  })

  it('a vegso "nem jott meg" mondat ket nyelven megvan', () => {
    expect(readFileSync('web/lang/hu.js', 'utf8')).toContain("'intezo.thumb_slow'")
    expect(readFileSync('web/lang/en.js', 'utf8')).toContain("'intezo.thumb_slow'")
  })
})
