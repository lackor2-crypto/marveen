import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Two Overview complaints from Boss on 2026-08-15, one root cause each.
//
// (1) "az usalackorhoz van telgram es a lackor3 hoz is van. es hasznalom is.
//      akkor miert hibas?"  -- the probe cannot launch a channel plugin the way
//      the agent does, so it reported two working Telegrams as faults. The
//      classification fix lives in mcp-connectors.ts (covered by
//      mcp-connectors-parse.test.ts); this file covers the half the operator
//      actually SEES: the row must not be painted or worded as a fault.
//
// (2) "attekintesben volt 3 hiba [...] de elojott ujabb 2 ami hibas. ezt miert
//      nem jelezte az elejen mar? hogy nem 3 hanem 5 javitanivalo van?"
//     -- the setup card names the WORST tier's count only, so finishing the
//     essentials reveals the next tier as if it were new. The card now says
//     how many more are waiting.
const PROJECT_ROOT = join(import.meta.dirname, '..', '..')
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(PROJECT_ROOT, 'web', 'style.css'), 'utf8')
const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  // A parameterlistat vegigjarjuk, mielott a torzs '{'-jat keresnenk: egy
  // `(opts = {})` alapertek kulonben lezarna a merest az elso sorban.
  let i = src.indexOf('(', start.index)
  let paren = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik be: ${name}`)
}

describe('az ugynok inditotta csatorna nem nez ki hibanak', () => {
  const row = extractFn(app, '_accHubMcpServerHtml')

  it('sajat, nyugodt cimket kap -- nem a "hibas"-t', () => {
    expect(row).toMatch(/s\.fix === 'agent-managed' \? 'mconn\.status_agent'/)
  })

  it('a legcsendesebb pillt kapja, nem a hibasat', () => {
    expect(row).toMatch(/s\.fix === 'agent-managed' \? 'conn-pill-neutral'/)
    // A CSS-nek tenylegesen tudnia kell errol az osztalyrol -- es pontosan
    // errol: a puszta toContain atengedne egy .conn-pill-neutral-x elirast is.
    expect(css).toMatch(/\.conn-pill-neutral\s*\{[^}]*background:/)
  })

  it('magyarazatot kap, nem gombot: itt nincs mit megnyomni', () => {
    expect(row).toMatch(/s\.fix === 'agent-managed'[\s\S]{0,160}mconn\.fix_agent/)
    // A bejelentkeztetes csak a 'login'-hoz tartozhat; egy csatorna-pluginra
    // felkinalva egy olyan folyamatot inditana, ami nem tud sikerulni.
    expect(row).toMatch(/if \(s\.fix === 'login'\) \{/)
  })

  for (const [lang, key] of [['hu', 'mconn.status_agent'], ['hu', 'mconn.fix_agent'],
    ['en', 'mconn.status_agent'], ['en', 'mconn.fix_agent']] as const) {
    it(`${lang}: megvan a(z) ${key} forditas`, () => {
      const src = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf8')
      const m = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']+)'`).exec(src)
      expect(m, `${lang}: hianyzik a(z) ${key}`).toBeTruthy()
      expect(m![1].length).toBeGreaterThan(3)
    })
  }
})

describe('az attekintes osszege nem tierenkent csepegtet', () => {
  const fn = extractFn(app, 'renderOverviewSetupStatus')

  it('mindharom tier hianyzoit osszeadja', () => {
    expect(fn).toMatch(/byTier\.essential \|\| 0\) \+ \(byTier\.recommended \|\| 0\) \+ \(byTier\.extra \|\| 0\)/)
  })

  it('a maradekot a legrosszabb tier szamabol vonja ki, nem nullaz', () => {
    expect(fn).toMatch(/rest = Math\.max\(0, outstanding - n\)/)
  })

  it('csak akkor mondja ki, ha tenyleg van meg', () => {
    expect(fn).toMatch(/rest > 0 \?[\s\S]{0,120}overview\.setup\.also_later/)
  })

  it('a leiras a szamolt szoveget hasznalja, nem a regi fixet', () => {
    expect(fn).toMatch(/overview-capability-desc[^\n]*\$\{escapeHtml\(descText\)\}/)
  })

  for (const lang of ['hu', 'en']) {
    it(`${lang}: az also_later forditas letezik es {n}-et tartalmaz`, () => {
      const src = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf8')
      const m = /'overview\.setup\.also_later':\s*'([^']*)'/.exec(src)
      expect(m, `${lang}: hianyzik az overview.setup.also_later`).toBeTruthy()
      expect(m![1], `${lang}: nincs benne {n}`).toContain('{n}')
    })
  }
})

describe('a /api/connections/summary utvonal', () => {
  it('elkuldi az agentManaged szamot', () => {
    expect(route).toMatch(/agentManaged: mcp\.agentManaged/)
  })

  it('de NEM szamolja bele a tier-be', () => {
    // A tier-szamitas a legrosszabb allapotnal kezdodik es a legjobbnal ('ok')
    // zarul. Korabban a `googleBroken` szora horgonyzott ez a minta, de a
    // legrosszabb ag azota zarojelbe kerult (a lejart hitelesites is ide
    // tartozik), es a horgony csendben elvesztette a blokkot -- a teszt
    // "megtalaltam es rendben van" helyett "nem talaltam"-ot merte volna.
    const tier = /tier: [\s\S]*?'ok',/.exec(route)?.[0] ?? ''
    expect(tier.length, 'nem talaltam meg a tier-szamitast').toBeGreaterThan(10)
    expect(tier).not.toContain('agentManaged')
  })
})
