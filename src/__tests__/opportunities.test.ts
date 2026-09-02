/**
 * TOVABBI LEHETOSEGEID -- a ki nem hasznalt lehetosegek NEM hibak.
 *
 * Boss, 2026-09-02: "az nem hiba, hogyha valamit a Marvinbol nem akarok
 * telepiteni [...] ezek nem hibak hanem lehetosegek, tovabbi lehetosegek
 * [...] de nem igy ide villogo ki pirossal."
 *
 * A kivalto ok merve volt: a `.overview-capabilities` osztaly alapertelmezett
 * hattere `#dc2626` (riaszto piros), es ezt a "Ezeket meg nem hasznalod ki"
 * kartya -- a masik ket kartyaval ellentetben -- sosem irta felul. Egyetlen
 * ki nem hasznalt opcio (a GLM) igy vorosen villogott az Attekintesen.
 *
 * Ez a teszt harom dolgot tart:
 *   1. a piros nem jon vissza csendben egy kesobbi atirassal,
 *   2. a lista alapbol csukva van, es az Onellenorzes ALATT all,
 *   3. a NULLA ket dolgot jelenthet: a hianyzo fajl 0, az olvashatatlan null,
 *      es a null a feluleten kimondott sor lesz, nem hamis nulla.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  buildOpportunities,
  countClaudePlans,
  countGoogleAccounts,
  type OpportunityDeps,
} from '../web/opportunities.js'

const css = readFileSync(join(PROJECT_ROOT, 'web', 'style.css'), 'utf8')
const html = readFileSync(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')

/**
 * A proba-fajlok kozos tmp konyvtara. EGY konyvtar az egesz fajlnak: hivasonkent
 * egy-egy `mkdtemp` minden futasnal ujabb marveen-opp-* mappakat hagyna a
 * /tmp-ben (nyomtalan munka). A fajlnevek tesztenkent kulonboznek.
 */
let _tmpDir: string | null = null
function tmp(): string {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'marveen-opp-'))
  return _tmpDir
}

describe('a ki nem hasznalt lehetoseg nem fest riaszto szint', () => {
  it('a .overview-capabilities alapertelmezese mar nem a riaszto piros', () => {
    const rule = /\n\.overview-capabilities\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? ''
    expect(rule.length).toBeGreaterThan(20)
    // Ez volt a hiba: a kozos osztaly alapbol pirosat festett, es csak ket
    // kartya irta felul rajzolaskor.
    expect(rule.toLowerCase()).not.toContain('#dc2626')
  })

  it('a kartya cime nem fix feketevel irodik (olvashato sotet temaban is)', () => {
    const rule = /\n\.overview-capabilities-title\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? ''
    expect(rule.length).toBeGreaterThan(10)
    expect(rule).not.toMatch(/color:\s*#000\b/)
  })

  it('a lehetoseg-sorok egyetlen sora sem riaszto szinu', () => {
    const renderer = /function renderOverviewOpportunities\([\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(renderer.length).toBeGreaterThan(500)
    for (const alarm of ['#dc2626', '#b91c1c', '#ef4444', '#f87171']) {
      expect(renderer.toLowerCase()).not.toContain(alarm)
    }
  })

  it('a regi piros blokk eltunt a feluletrol', () => {
    expect(html).not.toContain('overviewCapabilities')
    expect(hu).not.toContain('overview.capabilities.title')
    expect(en).not.toContain('overview.capabilities.title')
  })
})

describe('a gomb az Onellenorzes ALATT all, es alapbol csukva van', () => {
  it('sorrend: eloszor ami elromolhatott, utana a kinalat', () => {
    const selfCheck = html.indexOf('id="overviewConnections"')
    const opportunities = html.indexOf('id="overviewOpportunities"')
    expect(selfCheck).toBeGreaterThan(-1)
    expect(opportunities).toBeGreaterThan(selfCheck)
  })

  it('a nyito gomb alapbol csukott allapotban indul', () => {
    const block = /<div class="overview-opportunities"[\s\S]*?<div class="overview-capabilities-list"[^>]*>/.exec(html)?.[0] ?? ''
    expect(block.length).toBeGreaterThan(200)
    expect(block).toContain('aria-expanded="false"')
    // A lista maga rejtve indul; a gomb nyitja ki.
    expect(block).toMatch(/id="overviewOpportunitiesList"[^>]*hidden/)
  })

  it('a gombon ott a magyarazo tooltip, es az elmondja a lenyeget', () => {
    // Boss, 2026-09-02: "tooltip [...] egerrel ha fole megyek. irj egy jo kis
    // magyarazo szoveget hogy a tovabbi lehetosegeid alatt mi van! mire valo.
    // onnan ha kattintasz tudod oket telepiteni."
    const block = /<button[^>]*id="overviewOpportunitiesToggle"[\s\S]*?>/.exec(html)?.[0] ?? ''
    expect(block).toContain('data-i18n-title="overview.opportunities.tooltip"')
    for (const lang of [hu, en]) {
      const text = new RegExp("'overview\\.opportunities\\.tooltip':\\s*'([^']*)'").exec(lang)?.[1] ?? ''
      // Nem hossz-merce: a harom dolog, amit Boss kert -- mire valo, hogy NEM
      // hiba, es hogy kattintassal be lehet kotni.
      expect(text.length).toBeGreaterThan(200)
      expect(text.toLowerCase()).toMatch(/nem hibák|nem hibak|not errors/)
      expect(text.toLowerCase()).toMatch(/kattint|click/)
    }
  })

  it('a nyito gomb az aria-expanded-et is atallitja, nem csak a lathatosagot', () => {
    const renderer = /function renderOverviewOpportunities\([\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(renderer).toContain("setAttribute('aria-expanded'")
  })
})

describe('a NULLA ket dolgot jelenthet -- a forrast kerdezzuk meg, nem a darabszamot', () => {
  it('a hianyzo Claude-terv-fajl NULLA (friss telepites), nem ismeretlen', () => {
    expect(countClaudePlans(join(tmp(), 'nincs-ilyen.json'))).toBe(0)
  })

  it('a romlott Claude-terv-fajl NULL (nem latok oda), nem nulla', () => {
    const p = join(tmp(), 'plans.json')
    writeFileSync(p, '{ ez nem json', 'utf8')
    expect(countClaudePlans(p)).toBeNull()
  })

  it('a hianyzo Google-token-fajl NULLA, a romlott NULL', () => {
    const dir = tmp()
    expect(countGoogleAccounts(join(dir, 'nincs.json'))).toBe(0)
    const p = join(dir, 'google-tokens.json')
    writeFileSync(p, '<<< nem json >>>', 'utf8')
    expect(countGoogleAccounts(p)).toBeNull()
  })

  it('a nem-objektum tartalom is NULL, nem ures lista', () => {
    const p = join(tmp(), 'tokens.json')
    writeFileSync(p, '[1,2,3]', 'utf8')
    expect(countGoogleAccounts(p)).toBeNull()
  })
})

/** Egy alap fuggoseg-keszlet, amit tesztenkent felulirunk. */
function deps(over: Partial<OpportunityDeps> = {}): OpportunityDeps {
  return {
    keyServices: () => [],
    claudePlans: () => 0,
    googleAccounts: () => 0,
    githubAccounts: () => 0,
    connectors: () => ({ total: 0, installed: 0 }),
    ...over,
  }
}

describe('buildOpportunities: az olvashatatlan forras kimondott sor lesz', () => {
  it('a null darabszam "unknown" allapotot ad, nem hamis nullat', () => {
    const items = buildOpportunities(deps({
      claudePlans: () => null,
      googleAccounts: () => null,
      githubAccounts: () => null,
      connectors: () => ({ total: null, installed: null }),
    }))
    const byId = Object.fromEntries(items.map(i => [i.id, i]))
    expect(byId['claude-plan'].state).toBe('unknown')
    expect(byId['google-account'].state).toBe('unknown')
    expect(byId['github'].state).toBe('unknown')
    expect(byId['connector'].state).toBe('unknown')
    for (const i of items) expect(i.params?.n).toBeUndefined()
  })

  it('az olvashatatlan trezor kulcs-sora is "unknown", nem "nincs kulcs"', () => {
    const items = buildOpportunities(deps({
      keyServices: () => [{ id: 'zai', count: null }],
    }))
    expect(items.find(i => i.id === 'zai')?.state).toBe('unknown')
    expect(items.find(i => i.id === 'zai')?.params?.n).toBeUndefined()
  })

  it('a kulcs-proba dobasat NEM nyeljuk el -- a csend ugyanaz lenne, mint a rendben', () => {
    // Ha elnyelnenk, a kulcs-sorok nyomtalanul eltunnenek, es a lista pont ugy
    // nezne ki, mint egy friss telepitesen. A hiba igy a vegpontig eljut, es a
    // felulet kimondott "most nem tudtam lekerdezni" sort rajzol.
    expect(() => buildOpportunities(deps({
      keyServices: () => { throw new Error('vault zarva') },
    }))).toThrow()
  })

  it('a BEKOTOTT kulcs-szolgaltatas sora MARAD, es azt mondja, hany van', () => {
    // Boss, 2026-09-02: "de miert tunik el? a lehetoseg tovabbra is fennal.
    // nem? akar felvihetne kesobb egy legujabb glm elofizetest is. masodikat."
    const items = buildOpportunities(deps({
      keyServices: () => [
        { id: 'zai', count: 1 },
        { id: 'groq-stt', count: 0 },
        { id: 'openrouter', count: 3 },
      ],
    }))
    const byId = Object.fromEntries(items.map(i => [i.id, i]))
    expect(byId['zai']).toBeDefined()
    expect(byId['zai'].state).toBe('connected')
    expect(byId['zai'].params?.n).toBe(1)
    expect(byId['groq-stt'].state).toBe('available')
    expect(byId['openrouter'].params?.n).toBe(3)
  })

  it('az eltunt aktiv kulcs a soron is megjelenik (nem nemá visszaeses)', () => {
    const items = buildOpportunities(deps({
      keyServices: () => [{ id: 'zai', count: 2, activeMissing: true }],
    }))
    expect(items.find(i => i.id === 'zai')?.activeMissing).toBe(true)
    for (const lang of [hu, en]) {
      expect(lang).toContain("'overview.opportunity.active_missing'")
    }
    expect(app).toContain("t('overview.opportunity.active_missing')")
  })

  it('a fiok-sorok akkor is ott vannak, ha mar van bekotve fiok', () => {
    // Ez a lenyeg: a negyedik elofizetes vagy a masodik Google-fiok LEHETOSEG,
    // nem hianyossag -- akkor is felajanlhato, ha nem "hianyzik" semmi.
    const items = buildOpportunities(deps({
      claudePlans: () => 3, googleAccounts: () => 1, githubAccounts: () => 2,
    }))
    expect(items.find(i => i.id === 'claude-plan')?.params?.n).toBe(3)
    expect(items.find(i => i.id === 'google-account')?.params?.n).toBe(1)
    expect(items.find(i => i.id === 'github')?.params?.n).toBe(2)
  })

  it('ha minden connector be van kotve, a sor MARAD, csak mast mond', () => {
    const items = buildOpportunities(deps({ connectors: () => ({ total: 5, installed: 5 }) }))
    const row = items.find(i => i.id === 'connector')
    expect(row?.state).toBe('connected')
    expect(row?.variant).toBe('all_installed')
    for (const lang of [hu, en]) {
      expect(lang).toContain("'overview.opportunity.connector.desc_all_installed'")
    }
  })

  it('ha a katalogust latom, de a bekototteket nem, csak a teljes szamot mondom', () => {
    // Nem "unknown" (a lehetoseg all es tudom, mennyi van), de nem is talalgat
    // installed-et: sajat, szukebb mondatot kap.
    const items = buildOpportunities(deps({ connectors: () => ({ total: 14, installed: null }) }))
    const row = items.find(i => i.id === 'connector')
    expect(row?.state).toBe('available')
    expect(row?.variant).toBe('total_only')
    expect(row?.params).toEqual({ total: 14 })
    expect(row?.params?.installed).toBeUndefined()
    for (const lang of [hu, en]) {
      expect(lang).toContain("'overview.opportunity.connector.desc_total_only'")
    }
    // A kliens a variant-bol kepzi a kulcsot.
    expect(app).toContain('`${info.descKey}_${o.variant}`')
  })

  it('a hianyzo connectorok szama a kulonbseg -- es a sor akkor is marad', () => {
    // Mar van bekotve ketto, tehat "connected": a sor nem hianyt jelez, hanem
    // azt mondja meg, hol tartasz es mennyi van meg hatra.
    const items = buildOpportunities(deps({ connectors: () => ({ total: 9, installed: 2 }) }))
    const row = items.find(i => i.id === 'connector')
    expect(row?.state).toBe('connected')
    expect(row?.variant).toBeUndefined()
    expect(row?.params).toMatchObject({ n: 7, total: 9, installed: 2 })
  })
})

describe('minden felsorolt szolgaltatasnak van felirata -- egy lista, nem harom', () => {
  const catalog = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'key-service-dependents.ts'), 'utf8')
  const block = /export const KEY_SERVICE_CATALOG[\s\S]*?\n\]/.exec(catalog)?.[0] ?? ''
  const ids = Array.from(block.matchAll(/\{ id: '([a-z0-9-]+)'/g)).map(m => m[1])

  it('a katalogus nem ures, es a DeepSeek is benne van', () => {
    // A DeepSeek eddig CSAK az ugynokok modell-valasztojaban letezett: a Fiokok
    // oldalarol es a lehetoseg-listabol kimaradt, mert harom kulon lista volt.
    expect(ids.length).toBeGreaterThanOrEqual(4)
    expect(ids).toContain('deepseek')
  })

  it('minden katalogus-id-hez van CAPABILITY_INFO sor a kliensen', () => {
    for (const id of ids) {
      expect(app).toMatch(new RegExp("(^|\\n)\\s*'?" + id + "'?:\\s*\\{", 'm'))
    }
  })

  it('minden katalogus-id feliratai megvannak MINDKET nyelven', () => {
    for (const id of ids) {
      const key = 'overview.capability.' + id.replace(/-/g, '_')
      for (const lang of [hu, en]) {
        expect(lang).toContain("'" + key + ".label'")
        expect(lang).toContain("'" + key + ".desc'")
      }
    }
  })
})

describe('a connector-szamlalas nem ad hamis nullat', () => {
  // MERVE 2026-09-02, ujraindulas utan: a vegpont "14-bol 0 van bekotve"-t
  // valaszolt, holott a bekotott listat meg senki nem kerdezte le (az
  // mcpListCache induloallapota ures tomb, lastRefreshed: 0). A szamolo ezert
  // eloszor azt nezi meg, tortent-e egyaltalan meres.
  const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'connectors.ts'), 'utf8')
  const fn = /export function connectorCatalogCounts\([\s\S]*?\n}\n/.exec(src)?.[0] ?? ''

  it('a soha le nem futott meres ismeretlen, nem nulla', () => {
    expect(fn.length).toBeGreaterThan(200)
    expect(fn).toMatch(/lastRefreshed/)
    expect(fn).toMatch(/if \(!cache\.lastRefreshed\) return \{ total: catalog\.length, installed: null \}/)
  })

  it('a katalogus olvashatatlansaga sem nulla', () => {
    expect(fn).toContain('return { total: null, installed: null }')
  })
})

describe('a lekerdezes bukasa sem tunhet el csendben', () => {
  it('elerhetetlen vegpontnal a gomb kint marad, kimondott sorral', () => {
    const loader = /async function loadOverviewOpportunities\([\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(loader).toContain('/api/opportunities')
    expect(loader).toContain('renderOverviewOpportunities([], true)')
    const renderer = /function renderOverviewOpportunities\([\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(renderer).toContain('overview.opportunities.unreachable')
    expect(renderer).toContain('overview.opportunities.unknown')
  })
})

describe('minden uj szoveg ketnyelvu', () => {
  const keys = [
    'overview.opportunities.title',
    'overview.opportunities.title_n',
    'overview.opportunities.unknown',
    'overview.opportunities.unreachable',
    'overview.opportunities.tooltip',
    'overview.opportunity.claude_plan.label',
    'overview.opportunity.claude_plan.desc',
    'overview.opportunity.google_account.label',
    'overview.opportunity.google_account.desc',
    'overview.opportunity.connector.label',
    'overview.opportunity.connector.desc',
    'overview.opportunity.connector.desc_total_only',
  ]
  for (const key of keys) {
    it(`${key} magyarul es angolul is megvan`, () => {
      expect(hu).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    })
  }
})
