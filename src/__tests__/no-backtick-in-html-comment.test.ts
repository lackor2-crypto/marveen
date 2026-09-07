// Kanban #235 (Boss, 2026-09-07): egy HTML-komment a `card.innerHTML = ...`
// TEMPLATE LITERAL belsejeben allt, es a kommentbe visszapipacs (backtick)
// kerult -- `.process-dot.running` es `.activity-badge.act-working`.
//
// A backtick KILEP a sablonbol, es a szoveg kozepe kifejezeskent ertekelodik
// ki: a bongeszo a ".process - dot.running" kivonast latta, es minden egyes
// rajzolaskor "ReferenceError: dot is not defined" dobodott. A fajl kozben
// SZINTAKTIKAILAG ERVENYES maradt (a negy backtick paros), ezert sem a tsc,
// sem a CI, sem a forras-kontraktus tesztek nem fogtak meg -- csak a valodi
// bongeszo. A tunet: a VS Code kartya eltunt a Csapat laprol.
//
// jsdom nincs a projektben, tehat a kartyat teszt nem tudja tenylegesen
// kirajzolni. Ez a kapu ezert a HIBA OSZTALYAT zarja le, nem az egy esetet:
// markup-kommentbe backtick nem kerulhet, mert nem lehet ranezesre megmondani,
// hogy a komment epp sablon belsejeben all-e.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

function jsFiles(): string[] {
  return readdirSync(WEB).filter((f) => f.endsWith('.js')).map((f) => join(WEB, f))
}

describe('#235 -- markup-kommentbe nem kerulhet backtick', () => {
  it('a web/*.js HTML-kommentjei backtick-mentesek', () => {
    const offenders: string[] = []
    for (const file of jsFiles()) {
      const src = readFileSync(file, 'utf8')
      // Minden <!-- ... --> blokk, a sorszamaval egyutt.
      const re = /<!--[\s\S]*?-->/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        if (!m[0].includes('`')) continue
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${file.split('/').pop()}:${line} -- ${m[0].slice(0, 80).replace(/\n/g, ' ')}`)
      }
    }
    expect(
      offenders,
      'HTML-kommentben backtick all. Ha a komment egy template literal belsejebe kerul, '
        + 'kilep a sablonbol es a szoveg kodkent ertekelodik ki (kanban #235). '
        + 'Idezojel helyett ird az osztalynevet csupaszon.',
    ).toEqual([])
  })
})

describe('#235 -- a kod-hid kartya hibaja nem lehet NEMA', () => {
  it('a catch nem csak naploz, hanem kirak egy lathato helyettesito kartyat', () => {
    const app = readFileSync(join(WEB, 'app.js'), 'utf8')
    expect(app.includes('renderCodeBridgeBrokenCard(agentsGrid, addBtn, err)')).toBe(true)
    expect(app.includes('function renderCodeBridgeBrokenCard(')).toBe(true)
  })

  it('a helyettesito kartya szovege ketnyelvu', () => {
    const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')
    for (const key of ['cb.card.broken', 'cb.card.broken_badge']) {
      expect(hu.includes(`'${key}'`), `${key} hianyzik a hu.js-bol`).toBe(true)
      expect(en.includes(`'${key}'`), `${key} hianyzik az en.js-bol`).toBe(true)
    }
  })
})
