// #421 -- "Mi valtozott az upstreamben?" ablak: ful-rend, sors-jelvenyek,
// magyarazat minden szam mellett.
//
// Boss (TG 6701/6706, 2026-09-27): a fulek szamai osszekeverhetok voltak --
// "Valtozasok 521" commit, "Fajlok 799" fajl, "Kizart es dontesre varo 10 + 29"
// megint commit, a 29 "dontesre var" pedig mar rég eldolt (mind a 29 minden
// fajlja a kihagyott-listan allt). Az elfogadott rend: Valtozasok -> Bent van
// nalunk -> Kizarva -> Dontesre var -> Fajlok (kereso), felul EGY osszegzo sor
// fajlban ("799 fajl = 322 bent + 477 kizarva + 0 dontesre var"), es minden
// ful alatt ertheto magyarazat.
//
// Boss (TG 6847): "Szandekosan kihagyva nem latszik a kepernyon es nem is lehet
// odahuzni a gombokat" -- a fulsor nem tordelt, a sor vege kilogott.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

function fnBody(name: string): string {
  const m = app.match(new RegExp(`\\n(?:async )?function ${name}\\(`))
  if (!m) throw new Error(`${name} nincs a web/app.js-ben`)
  const start = m.index! + 1
  return app.slice(start, app.indexOf('\n}\n', start) + 2)
}

// A ket tiszta fuggveny a feluletbol, valodi adaton futtatva -- nem a
// forrasszoveget nezzuk, hanem hogy mit SZAMOL.
const lib = new Function(
  `${fnBody('upstreamSplitModel')}\n${fnBody('upstreamChangeFate')}\n`
  + 'return { upstreamSplitModel, upstreamChangeFate }',
)() as {
  upstreamSplitModel: (d: unknown) => null | {
    hasFiles: boolean
    counts: { total: number; bent: number; kizarva: number; nyitott: number }
    fate: Map<string, string>
  }
  upstreamChangeFate: (c: unknown, m: unknown) => null | { kind: string; bent: number; kiz: number; open: number }
}

const data = {
  available: true,
  total: 6,
  files: ['a', 'b', 'c', 'd'].map((path) => ({ path, conflict: false, shas: [] })),
  split: {
    absorbed: ['a'],
    skipped: [
      { path: 'b', kind: 'decided', reason: 'a mi logikank mas' },
      { path: 'c', kind: 'decided', reason: 'upstream teszt' },
      // Ellentmondo bejegyzes: egy fajl nem lehet egyszerre bent es kizarva --
      // a "bent" a teny (betűre ugyanaz), az nyer.
      { path: 'a', kind: 'decided', reason: 'regi dontes' },
    ],
  },
}

describe('a fajlok sorsa a meresbol (#421)', () => {
  const model = lib.upstreamSplitModel(data)!

  it('bent + kizarva + dontesre var = osszes fajl', () => {
    expect(model.hasFiles).toBe(true)
    expect(model.counts).toEqual({ total: 4, bent: 1, kizarva: 2, nyitott: 1 })
    const { bent, kizarva, nyitott, total } = model.counts
    expect(bent + kizarva + nyitott).toBe(total)
    expect(model.fate.get('a')).toBe('bent')
    expect(model.fate.get('d')).toBe('nyitott')
  })

  it('a valtozas (commit) sorsa a fajljai sorsabol', () => {
    const kind = (files: string[]) => lib.upstreamChangeFate({ files }, model)!.kind
    expect(kind(['a'])).toBe('bent')
    expect(kind(['b', 'c'])).toBe('kizarva')
    expect(kind(['a', 'b'])).toBe('reszben')
    expect(kind(['a', 'b', 'd'])).toBe('nyitott')
    // Olyan fajl, ami a mert elteresben mar nincs benne (az upstream kesobb
    // visszacsinalta): nem sors-kerdes, nem "dontesre var".
    expect(kind(['zzz'])).toBe('nincs')
    // Osszefesulo commit: nincs sajat fajlja.
    expect(kind([])).toBe('nincs')
  })

  it('meres nelkul NINCS modell -- a "nem mertuk" nem nulla', () => {
    expect(lib.upstreamSplitModel({ available: true, files: [] })).toBeNull()
    expect(lib.upstreamSplitModel({ available: false, split: { absorbed: null, skipped: [] } })).toBeNull()
    expect(lib.upstreamChangeFate({ files: ['a'] }, null)).toBeNull()
  })

  it('fajl-lista nelkul a dontesre varo szam ismeretlen, es ezt ki is mondjuk', () => {
    const m = lib.upstreamSplitModel({ available: false, split: data.split })!
    expect(m.hasFiles).toBe(false)
    expect(m.counts.bent).toBe(1)
    expect(m.counts.kizarva).toBe(2)
    // A felso sor ilyenkor nem ir nullat a dontesre varo helyere...
    const summary = fnBody('renderUpstreamSummary')
    expect(summary).toMatch(/model && model\.hasFiles[\s\S]*upstream\.summary\.line[\s\S]*upstream\.summary\.nofiles/)
    // ...es a ful sem.
    expect(fnBody('labelUpstreamViewTabs')).toMatch(/model && model\.hasFiles\s*\?\s*t\('upstream\.view\.decide'/)
    expect(fnBody('renderUpstreamDecide')).toContain("t('upstream.decide.unknown')")
  })
})

describe('ful-rend es lathatosag (#421)', () => {
  const ORDER = ['upstreamViewChanges', 'upstreamViewAbsorbed', 'upstreamViewSkipped', 'upstreamViewDecide', 'upstreamViewFiles']

  it('a fulek a Boss altal elfogadott sorrendben allnak, a kodban is ugyanigy', () => {
    const tabs = html.slice(html.indexOf('id="upstreamViewTabs"'), html.indexOf('</div>', html.indexOf('id="upstreamViewTabs"')))
    const ids = [...tabs.matchAll(/<button[^>]*id="(upstreamView[A-Za-z]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(ORDER)
    const table = app.slice(app.indexOf('const UPSTREAM_VIEW_TABS'), app.indexOf(']\n', app.indexOf('const UPSTREAM_VIEW_TABS')))
    expect([...table.matchAll(/\['(upstreamView[A-Za-z]+)'/g)].map((m) => m[1])).toEqual(ORDER)
  })

  it('a fulsor tordelodik, a sor vegi ful nem log ki a kepbol (TG 6847)', () => {
    expect(css).toMatch(/\.upstream-view-tabs \{[^}]*flex-wrap: wrap/)
  })

  it('felul az osszegzo sor, a fulek alatt a ful magyarazata', () => {
    const body = html.slice(html.indexOf('id="upstreamChangesSummary"'))
    expect(body.indexOf('id="upstreamChangesSummary"')).toBe(0)
    expect(body.indexOf('id="upstreamViewTabs"')).toBeGreaterThan(0)
    expect(body.indexOf('id="upstreamChangesIntro"')).toBeGreaterThan(body.indexOf('id="upstreamViewTabs"'))
    for (const v of ['valtozas', 'bent', 'kizarva', 'dontes', 'fajl']) {
      expect(app).toContain(`t('upstream.explain.${v}')`)
    }
  })

  it('a valtozas-sor a sorsat mutatja, nem a regi "dontesre var" kapu-jelvenyt', () => {
    const row = fnBody('upstreamChangeRow')
    expect(row).toMatch(/const badge = fate \? upstreamFateBadge\(c, fate\) : upstreamGateBadge\(c\.gate\)/)
    // A sort a map() indexevel hivni hiba volt (a modell helyere a sorszam ment).
    expect(app).not.toContain('.map(upstreamChangeRow)')
  })
})

describe('minden uj szoveg ket nyelven (#421)', () => {
  const keys = [
    'upstream.view.decide', 'upstream.view.decide_unknown',
    'upstream.summary.line', 'upstream.summary.nofiles', 'upstream.summary.unmeasured',
    'upstream.explain.valtozas', 'upstream.explain.bent', 'upstream.explain.kizarva',
    'upstream.explain.dontes', 'upstream.explain.fajl',
    'upstream.fate.split_counts', 'upstream.changes.fates', 'upstream.files.conflict_note',
    'upstream.files.group_open', 'upstream.files.group_bent', 'upstream.files.group_kizarva',
    'upstream.absorbed.group_gate', 'upstream.kizarva.gate_intro', 'upstream.kizarva.group_gate',
    'upstream.kizarva.discuss_decided', 'upstream.kizarva.gate_files',
    'upstream.decide.unknown', 'upstream.decide.intro', 'upstream.decide.none',
    'upstream.decide.open_files', 'upstream.decide.group_gate', 'upstream.decide.group_files',
    'upstream.skipped.intro_final',
  ]
  for (const f of ['bent', 'kizarva', 'reszben', 'nyitott', 'nincs', 'merge']) {
    keys.push(`upstream.fate.${f}`, `upstream.fate.${f}_tip`)
  }

  it('hu es en is megvan', () => {
    for (const k of keys) {
      expect(hu, `hu: ${k}`).toContain(`'${k}'`)
      expect(en, `en: ${k}`).toContain(`'${k}'`)
    }
  })

  it('a ful-nevek a Boss szavai: Bent van nalunk / Kizarva / Dontesre var', () => {
    expect(hu).toMatch(/'upstream\.view\.absorbed':\s*'Bent van nálunk \(\{n\}\)'/)
    expect(hu).toMatch(/'upstream\.view\.skipped':\s*'Kizárva \(\{n\}\)'/)
    expect(hu).toMatch(/'upstream\.view\.decide':\s*'Döntésre vár \(\{n\}\)'/)
    // A Valtozasok ful magyarazata kimondja: ez az upstream listaja, nem a mienk.
    expect(hu).toMatch(/'upstream\.explain\.valtozas':\s*'[^']*az upstream listája/)
  })
})
