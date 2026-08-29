/**
 * KIJELENTKEZTETES ES VISSZAJELENTKEZES -- A FELULETROL, NEM TERMINALBOL.
 *
 * Boss, 2026-08-29: "legyen inkabb az hogy te sajat magad jelentkeztesd ki.
 * igy nem lesz gond. es varazsloval visszahozlak." Merve ugyanaznap 11:30-kor,
 * a Claude Code 2.1.251-tel: a Claude-fiokot csak `claude auth logout`
 * futtatasaval lehetett kijelentkeztetni, vagyis pont azzal a terminal-uttal,
 * amit ez a kartya (#52, 61e9ed2b) meg akar szuntetni. A feluleten levo
 * "Kilepes" a dashboard sajat munkamenete, nem a Claude-fiok.
 *
 * Amit ez a teszt oriz -- mind a harom nemán tudna elromlani:
 *   1. minden fiok-sor kap gombot, es a BEJELENTKEZETT mast, mint a
 *      kijelentkezett (kulonben a kijelentkezett fiokot nem lehet visszahozni),
 *   2. a gomb magaval viszi, MELYIK fiokrol van szo (`data-plan`), es hogy a
 *      gep sajat bejelentkezeserol-e (`data-default`) -- e nelkul a kattintas
 *      "tortenik valami" nelkul marad,
 *   3. a gombfeliratok a `t()`-n mennek at, es a kulcs mindket nyelvben megvan.
 *
 * web/app.js klasszikus szkript, modulhatar nelkul: a fuggvenyt kizarojelezzuk
 * a forrasbol es kiertekeljuk (ugyanaz az idiom, mint accounts-one-panel).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'accounts.ts'), 'utf8')

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

const usedKeys: string[] = []
const render = new Function(
  't', 'escapeHtml', 'escapeAttr', '_accHubPart',
  `${extractFn(app, '_accHubClaudePart')}\nreturn _accHubClaudePart`,
)(
  (k: string) => { usedKeys.push(k); return `«${k}»` },
  (v: string) => String(v),
  (v: string) => String(v),
  (_k: string, body: string) => body,
) as (rows: unknown[]) => string

const loggedIn = (id: string | null, isDefault = false) => ({
  id, label: id ?? '', isDefault, configDir: id ? `/x/${id}` : null,
  identity: { loggedIn: true, email: `${id ?? 'default'}@example.com`, subscriptionType: 'pro' },
})
const loggedOut = (id: string | null, isDefault = false) => ({
  id, label: id ?? '', isDefault, configDir: id ? `/x/${id}` : null,
  identity: { loggedIn: false, email: null, subscriptionType: null },
})

describe('a fiok-sor gombjai', () => {
  it('a bejelentkezett fiok kijelentkeztetheto, es a gomb tudja MELYIKET', () => {
    const html = render([loggedIn('usalackor')])
    expect(html).toContain('acc-claude-logout')
    expect(html).toContain('data-plan="usalackor"')
    expect(html).not.toContain('acc-claude-relogin')
  })

  it('a kijelentkezett fiok visszahozhato ugyanonnan', () => {
    const html = render([loggedOut('usalackor')])
    expect(html).toContain('acc-claude-relogin')
    expect(html).toContain('data-plan="usalackor"')
    expect(html).toContain('data-default="0"')
    expect(html).not.toContain('acc-claude-logout')
  })

  it('a gep sajat bejelentkezese a default-agon megy vissza, nem nevvel', () => {
    const html = render([loggedOut(null, true)])
    expect(html).toContain('data-default="1"')
    expect(html).toContain('data-plan=""')
  })

  it('minden sor kap gombot -- egy sem marad zsakutcaban', () => {
    const html = render([loggedIn(null, true), loggedIn('usalackor'), loggedOut('lackor3')])
    const gombok = (html.match(/acc-claude-(logout|relogin)/g) || []).length
    expect(gombok).toBe(3)
  })

  it('a feliratok a forditason mennek at, es mindket nyelvben megvannak', () => {
    render([loggedIn('usalackor'), loggedOut('lackor3')])
    expect(usedKeys).toContain('claudeauth.logout_btn')
    expect(usedKeys).toContain('claudeauth.relogin_btn')
    for (const key of ['claudeauth.logout_btn', 'claudeauth.relogin_btn',
      'claudeauth.logout_confirm_agents', 'claudeauth.logout_confirm_none',
      'claudeauth.logout_done', 'claudeauth.logout_preview_failed']) {
      expect(hu, `hianyzik hu.js-bol: ${key}`).toContain(`'${key}'`)
      expect(en, `hianyzik en.js-bol: ${key}`).toContain(`'${key}'`)
    }
  })
})

describe('a kiszolgalo oldal', () => {
  it('van kijelentkeztetes-vegpont', () => {
    expect(route).toContain(`'/api/accounts/claude/logout'`)
  })

  it('van elonezet is, ami MEGMONDJA, kit allitana meg', () => {
    // Boss szabalya: visszafordithatatlan lepes elott elonezet. A kijelentkeztetes
    // az egyetlen ilyen gomb ezen az oldalon.
    expect(route).toContain(`'/api/accounts/claude/logout-preview'`)
    expect(route).toContain('agentsUsingLogin')
  })

  it('a bejelentkezes-vegpont tovabbadja a planId-t (visszajelentkezes)', () => {
    expect(route).toContain('planId: typeof body.planId')
  })
})
