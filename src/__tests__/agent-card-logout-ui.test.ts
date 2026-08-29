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

describe('a gomb csak akkor van ott, ha van mit kijelentkeztetni', () => {
  it('Claude-bejelentkezes nelkuli agensen nincs gomb', () => {
    expect(build([row({})])({ name: 'nemotron', claudeAccount: null })).toBe('')
  })

  it('amig a fioklista meg nem jott meg, nincs gomb', () => {
    // A null itt "nem lattam oda". Egy talalgatott gomb rosszabb, mint egy
    // kesobb megjeleno.
    expect(build(null)({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })).toBe('')
  })

  it('mar kijelentkezett fiokon nincs gomb', () => {
    const html = build([row({ identity: { loggedIn: false } })])(
      { name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(html).toBe('')
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

  it('a kartya tenylegesen kirajzolja a gombot', () => {
    expect(app).toContain('${agentLogoutButtonHtml(agent)}')
    expect(app).toContain('.agent-account-logout-btn')
  })

  it('ugyanaz a nevekkel-megerosito ut fut, mint a Fiokok oldalon', () => {
    // Kulon, halkabb masolat nem keletkezhet: az elonezet nelkuli
    // kijelentkeztetes pontosan az, amit Boss nem akart.
    const handler = app.slice(app.indexOf(".agent-account-logout-btn'"))
    expect(handler.slice(0, 400)).toContain('_claudeAuthLogout(')
  })
})

describe('a felirat ketnyelvu', () => {
  it('mindket kulcs megvan magyarul es angolul', () => {
    for (const key of ['agents.btn.account_logout', 'agents.btn.account_logout_tip']) {
      expect(hu, `hu: ${key}`).toContain(`'${key}'`)
      expect(en, `en: ${key}`).toContain(`'${key}'`)
    }
  })
  it('a felirat a t()-n megy at, nem beegetve', () => {
    build([row({})])({ name: 'x', claudeAccount: { configDir: '/x/usalackor' } })
    expect(usedKeys).toContain('agents.btn.account_logout')
  })
})
