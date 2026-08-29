/**
 * A KIJELENTKEZTETES GOMBJA AZ UGYNOK KARTYAJAN IS.
 *
 * Boss, 2026-08-29: "hat igen ted ra a kartyara is! de! mi az hogy mind a 6
 * ugynokot kiutne? hat basza meg! csak azt az egy ugynokot usse ki. csak azt
 * az egy fiokot! itt fiokonkent kell egyessevel ez t megoldani! nem?"
 *
 * A valasz, amit ez a teszt kikenyszerit: a kijelentkeztetes mindig EGY FIOKOT
 * erint -- nem tobbet, nem kevesebbet. Hogy ez hany ugynokot allit meg, azt nem
 * a gomb donti el, hanem az, hany ugynok van arra a fiokra allitva. Ezert a
 * gomb nem allit semmit sajat magatol: a szerver mondja meg, MELYIK fiok alatt
 * fut az ugynok (`agent.claudeAccount`), es a felulet ezt csak OSSZEFUZI a
 * bejelentkezesi allapottal.
 *
 * Harom nema elromlas ellen or:
 *   1. a szabaly ("hasznal-e egyaltalan Claude-bejelentkezest") ne keruljon at
 *      a bongeszobe egy MASODIK peldanyban -- egy ilyen parbol mar volt kar,
 *   2. ha a fiok sora nem talalhato, NE talaljunk oda gombot: a nem-talalt sor
 *      "nem lattam oda", nem "az alapertelmezett",
 *   3. a felirat a t()-n megy at, es a kulcs mindket nyelvben megvan.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { usesClaudeLogin } from '../web/default-login-dependents.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const agentsRoute = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

type Row = {
  id: string | null
  label: string
  isDefault: boolean
  configDir: string | null
  identity: { loggedIn: boolean; email?: string | null }
}

const usedKeys: string[] = []
function build(rows: Row[] | null) {
  return new Function(
    't', 'escapeHtml', 'escapeAttr', 'mainAccountLabel', 'stripModelSuffix', 'rows',
    `let _claudeAccountRows = rows
     ${extractFn(app, 'claudeAccountRowFor')}
     ${extractFn(app, 'agentLogoutButtonHtml')}
     return agentLogoutButtonHtml`,
  )(
    (k: string, p: Record<string, string> = {}) => { usedKeys.push(k); return `«${k}:${p.account ?? ''}»` },
    (v: string) => String(v),
    (v: string) => String(v),
    () => 'Gep',
    (v: string) => String(v),
    rows,
  ) as (agent: unknown) => string
}

const row = (over: Partial<Row>): Row => ({
  id: 'usalackor', label: 'Usalackor', isDefault: false,
  configDir: '/x/usalackor', identity: { loggedIn: true, email: 'a@example.com' }, ...over,
})

describe('a szabaly a szerveren marad', () => {
  it('sajat API-kulccsal futo agens nem hasznal bejelentkezest', () => {
    expect(usesClaudeLogin('api', 'claude-opus-5')).toBe(false)
  })
  it('nem Claude-modell nem hasznal bejelentkezest', () => {
    expect(usesClaudeLogin('shared', 'nvidia/nemotron-3-nano-30b-a3b:free')).toBe(false)
  })
  it('Claude-modell megosztott modban igen', () => {
    expect(usesClaudeLogin('shared', 'claude-opus-5')).toBe(true)
  })
  it('a kartya a szervertol kapja, melyik fiok alatt fut', () => {
    // Ha ez kikerul a valaszbol, a bongeszo kenytelen ujraszamolni -- pont az a
    // ket-retegu masolat, amibol mar volt kar.
    expect(agentsRoute).toContain('claudeAccount: claudeLoginForAgent(name)')
  })
})

describe('a gomb csak akkor van ott, ha van mit kijelentkeztetni VAGY visszahozni', () => {
  it('Claude-bejelentkezes nelkuli agensen nincs gomb', () => {
    expect(build([row({})])({ name: 'nemotron', claudeAccount: null })).toBe('')
  })

  it('amig a fioklista meg nem jott meg, nincs gomb', () => {
    // A null itt "nem lattam oda". Egy talalgatott gomb rosszabb, mint egy
    // kesobb megjeleno.
    expect(build(null)({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })).toBe('')
  })

  it('mar kijelentkezett fiokon bejelentkezes-gomb van, nem semmi', () => {
    // Boss, 2026-08-29: kijelentkeztetett egy ugynokot INNEN, es a doboz utana
    // teljesen eltunt -- nem tudta visszahozni. A "Vissza a Bejelentkezes
    // gombbal... johet" szoveg mar akkor is ezt igerte, csak nem volt hozza gomb.
    const html = build([row({ identity: { loggedIn: false } })])(
      { name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(html).not.toBe('')
    expect(html).toContain('agent-account-relogin-btn')
    expect(html).toContain('data-plan="usalackor"')
    expect(html).toContain('data-default="0"')
  })

  it('ismeretlen config-konyvtar NEM esik vissza az alapertelmezettre', () => {
    // Ez a nema hiba, amit a legkonnyebb elrontani: ha a parositas nem talal
    // sort, egy "planId nelkul = alapertelmezett" logika a GEP sajat fiokjat
    // jelentkeztetne ki egy teljesen mas agens gombjarol.
    const rows = [row({ id: null, label: '', isDefault: true, configDir: null })]
    expect(build(rows)({ name: 'x', claudeAccount: { configDir: '/x/mashol' } })).toBe('')
  })
})

describe('a gomb magaval viszi, MELYIK fiokrol van szo', () => {
  it('sajat fioku agensnel a terv-azonosito megy at', () => {
    const html = build([row({})])({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(html).toContain('data-plan="usalackor"')
    expect(html).toContain('agent-account-logout-btn')
  })

  it('a gep sajat bejelentkezesenel ures a terv-azonosito', () => {
    const rows = [row({ id: null, label: '', isDefault: true, configDir: null })]
    const html = build(rows)({ name: 'x', claudeAccount: { configDir: null } })
    expect(html).toContain('data-plan=""')
  })

  it('a gomb megnevezi, KIT jelentkeztet ki', () => {
    const html = build([row({})])({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(html).toContain('data-who="a@example.com"')
  })

  it('a gomb tenylegesen kirajzolodik valahol', () => {
    expect(app).toContain('agentLogoutButtonHtml(agent)')
    expect(app).toContain('.agent-account-logout-btn')
  })

  it('ugyanaz a nevekkel-megerosito ut fut, mint a Fiokok oldalon', () => {
    // Kulon, halkabb masolat nem keletkezhet: az elonezet nelkuli
    // kijelentkeztetes pontosan az, amit Boss nem akart.
    const handler = app.slice(app.indexOf(".agent-account-logout-btn'"))
    expect(handler.slice(0, 400)).toContain('_claudeAuthLogout(')
  })

  it('a visszahozo gomb elobb lathatova teszi a bejelentkezes-dobozt, csak azutan nyitja meg', () => {
    // A #claudeAuthFlow doboz a Fiokok lap sajat, `hidden` DOM-agan lakik. Ha
    // csak _claudeAuthStartFlow-t hivnank a kartya-modalbol, a doboz nema
    // maradna a nezo szamara -- pontosan ez volt a hiba, amit Boss jelzett.
    const handler = app.slice(app.indexOf(".agent-account-relogin-btn'"))
    const body = handler.slice(0, 500)
    const switchIdx = body.indexOf('switchPage(')
    const closeIdx = body.indexOf('closeModal(agentDetailOverlay)')
    const flowIdx = body.indexOf('_claudeAuthStartFlow(')
    expect(switchIdx, 'switchPage a Fiokok lapra').toBeGreaterThan(-1)
    expect(closeIdx, 'a kartya-modal bezarodik').toBeGreaterThan(-1)
    expect(flowIdx, 'a bejelentkezes-folyamat inditasa').toBeGreaterThan(-1)
    expect(switchIdx).toBeLessThan(flowIdx)
    expect(closeIdx).toBeLessThan(flowIdx)
  })
})

describe('a felirat ketnyelvu', () => {
  it('mindket kulcs megvan magyarul es angolul', () => {
    for (const key of [
      'agents.btn.account_logout', 'agents.btn.account_logout_tip',
      'agents.btn.account_relogin', 'agents.btn.account_relogin_tip',
    ]) {
      expect(hu, `hu: ${key}`).toContain(`'${key}'`)
      expect(en, `en: ${key}`).toContain(`'${key}'`)
    }
  })
  it('a felirat a t()-n megy at, nem beegetve', () => {
    build([row({})])({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(usedKeys).toContain('agents.btn.account_logout')
  })
  it('a visszahozo gomb felirata is a t()-n megy at', () => {
    usedKeys.length = 0
    build([row({ identity: { loggedIn: false } })])({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(usedKeys).toContain('agents.btn.account_relogin')
  })
})

/**
 * NINCS MEGKULONBOZTETES AGENS ES AGENS KOZOTT.
 *
 * Boss, 2026-08-29: "persze hogy rakd be. nincs megkulonboztetes agent es agent
 * kozott!" -- a fo agens sajat kartyaja mashonnan (`/api/marveen`) kapja az
 * adatait, mint a tobbi ugynoke (`/api/agents`), es emiatt eloszor kimaradt
 * belole a gomb. Pontosan ez az a fajta elteres, amit senki nem vesz eszre:
 * mindket lap mukodik, csak az egyik kartyan hianyzik egy lehetoseg.
 *
 * Amit ez a harom eset ovni akar:
 *   1. a fo agens kartyaja is kirajzolja a gombot,
 *   2. a fiokot a SZERVER mondja meg neki is (ugyanaz a fuggveny, ugyanaz a
 *      mezonev) -- nem a bongeszo talalja ki, hogy "a fo agens az alapertelmezett",
 *   3. a ket kartya UGYANAZT a bekoto utat hasznalja, nem ket masolatot.
 */
describe('a fo agens kartyaja sem marad ki', () => {
  const marveenRoute = readFileSync(join(ROOT, 'src', 'web', 'routes', 'marveen.ts'), 'utf8')

  it('a /api/marveen is kuldi a fiokot, ugyanazzal a szaballyal', () => {
    expect(marveenRoute).toContain('claudeAccount: claudeLoginForAgent(MAIN_AGENT_ID)')
    expect(marveenRoute).toContain("from '../default-login-dependents.js'")
  })

  it('a fo agens ugyanazt a dobozt kapja, nem sajat valtozatot', () => {
    // Mindket megnyito ugyanazt a rendezot hivja, es a doboz maga egyetlen
    // helyen letezik a HTML-ben -- tehat nem tud ketfele elcsuszni.
    const openers = app.match(/renderAgentLogoutSetting\(currentAgent\)/g) || []
    expect(openers.length, 'a fo agens es az al-agens megnyitoja is bekoti').toBe(3)
    const groups = html.match(/id="agentLogoutGroup"/g) || []
    expect(groups.length, 'pontosan egy kijelentkeztetes-doboz letezik').toBe(1)
  })

  it('egyetlen bekoto ut van, nem ket masolat', () => {
    // A megerosito ut (nevek + visszakerdezes) egyetlen helyen el. Ha valaki
    // masol belole egy masodikat, az elobb-utobb halkabb lesz -- ezert szamolunk.
    const defs = app.match(/function wireAccountLogoutButton\(/g) || []
    expect(defs.length, 'pontosan egy bekoto fuggveny letezhet').toBe(1)
    const inline = app.match(/\.agent-account-logout-btn'\)\?\.addEventListener/g) || []
    expect(inline.length, 'csak a kozos fuggvenyben kotodik esemeny').toBe(1)
  })

  it('a fo agens kartyaja sem esik vissza az alapertelmezettre magatol', () => {
    // Ha a szerver azt mondja, nincs Claude-bejelentkezese (mas szolgaltato),
    // akkor nincs gomb -- akkor sem, ha o a fo agens.
    const html = build([row({})])({ name: 'main', claudeAccount: null })
    expect(html).toBe('')
  })
})

/**
 * BELULRE, A BEALLITASOK ALA -- NEM A KARTYA ELEJERE.
 *
 * Boss, 2026-08-29: "jaajj de mondtam hogy ne kivulre tedd. hanem belulre a
 * belaitasok ala." A gomb tehat az ugynok sajat lapjan, a Beallitasok fulon
 * lakik, a Claude-elofizetes alatt -- ugyanott, ahol a bejelentkezes is.
 *
 * Amit ez ovni akar: a kartya elejere visszacsuszo gombot. Az elozo korben
 * pont az volt a kifogas, hogy kint van; ha valaki visszateszi, ez elhasal.
 */
describe('a gomb a Beallitasok fulon van, nem a kartyan', () => {
  it('a kartyak akcio-sora nem tartalmazza a gombot', () => {
    expect(app).not.toContain('${agentLogoutButtonHtml(agent)}')
    expect(app).not.toContain('${agentLogoutButtonHtml(m)}')
  })

  it('a doboz a Beallitasok fulon belul van', () => {
    const tab = html.slice(html.indexOf('id="tabSettings"'))
    const end = tab.indexOf('id="tabChannel"')
    const settingsTab = end > 0 ? tab.slice(0, end) : tab
    expect(settingsTab).toContain('id="agentLogoutGroup"')
    expect(settingsTab).toContain('id="agentLogoutSlot"')
  })

  it('alapbol rejtve all, es csak akkor nyilik ki, ha van mit kijelentkeztetni', () => {
    expect(html).toContain('id="agentLogoutGroup" hidden')
    const fn = extractFn(app, 'renderAgentLogoutSetting')
    expect(fn).toContain('group.hidden = !html')
  })

  it('a fioklista hianya nem gomb-hianynak latszik, hanem megkerdezi a forrast', () => {
    // A nulla ket dolgot jelenthet: "nincs fiok" vagy "meg nem lattam oda".
    // Itt a masodik esetben ujra kell kerdezni, nem eldonteni.
    const fn = extractFn(app, 'renderAgentLogoutSetting')
    expect(fn).toContain('if (!_claudeAccountRows)')
    expect(fn).toContain('primeClaudeAccounts(')
  })

  it('a doboz felirata ketnyelvu', () => {
    for (const key of ['agents.settings.logout_label', 'agents.settings.logout_desc']) {
      expect(hu, `hu: ${key}`).toContain(`'${key}'`)
      expect(en, `en: ${key}`).toContain(`'${key}'`)
    }
  })
})
