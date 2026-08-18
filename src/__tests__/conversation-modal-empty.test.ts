import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Boss, 2026-08-15, about the Beszelgetesek button on an agent card:
//
//   "nincs alatta semmi. be van az kotve egyaltalan? soha semmi beszelgetest
//    nem mutat. akor minek az oda?"
//
// It WAS wired. MEASURED the same day against the live dashboard, all 14
// agents, GET /api/agents/<name>/conversation?limit=50:
//
//   gemma 50 entries (all 'note'), north 50 ('note'+'action'), ling 50,
//   lagunaxs 50, nemotron* 27-50 ... and exactly ONE 'out' entry in the whole
//   fleet (usalackor), zero 'in'.
//
// The modal's default filter keeps only kind 'in'/'out' -- correct for an agent
// that talks on Telegram, and for this fleet it means the modal opens on a full
// transcript and prints "Nincs megjelenitheto uzenet." So: reveal the detail
// when there is no channel traffic to show, and never print the bare empty
// message over entries that exist.
const PROJECT_ROOT = join(import.meta.dirname, '..', '..')
const APP_JS = join(PROJECT_ROOT, 'web', 'app.js')

// Brace-match the function OUT of the file, the way the other web/app.js tests
// do -- with one correction they do not need and this file does. The usual
// helper starts matching at the first '{' after the name, which for
// `function renderConversation(opts = {})` is the default VALUE: depth returns
// to zero at its '}' and the helper hands back a 38-character stub. Every
// toMatch on the body then fails, and -- far worse -- every not.toMatch passes.
// So: walk the parameter list to its closing paren FIRST, and only then look
// for the opening brace of the body. Covered by its own describe block below.
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let i = src.indexOf('(', start.index)
  let paren = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break } }
  }
  const from = src.indexOf('{', i)
  if (from < 0) throw new Error(`nincs torzse: ${name}`)
  let depth = 0
  for (let j = from; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(start.index, j + 1)
    }
  }
  throw new Error(`nem zarodik be: ${name}`)
}

const app = existsSync(APP_JS) ? readFileSync(APP_JS, 'utf8') : ''

// Az ellenorzot magat is teszteljuk: ez a helper mar egyszer csendben rossz
// valaszt adott (a `(opts = {})` alapertek levagta a torzset), es a csend a
// veszelyes resze -- egy not.toMatch atment volna egy 38 karakteres csonkon.
describe('extractFn: a merceje is meroeszkoz', () => {
  const sample = [
    'function elso(a, b) { return a + b }',
    'function alapertekkel(opts = {}, x = (1)) {',
    '  const y = { z: 1 }',
    '  return y',
    '}',
    'async function utolso() { return 1 }',
  ].join('\n')

  it('nem all meg az alapertek {} -janal', () => {
    const body = extractFn(sample, 'alapertekkel')
    expect(body).toContain('const y = { z: 1 }')
    expect(body.trimEnd().endsWith('}')).toBe(true)
    expect(body).not.toContain('async function utolso')
  })

  it('a szomszed fuggvenyeket nem szippantja be', () => {
    expect(extractFn(sample, 'elso')).toBe('function elso(a, b) { return a + b }')
  })

  it('szol, ha nincs ilyen fuggveny', () => {
    expect(() => extractFn(sample, 'nincsilyen')).toThrow(/nincs ilyen fuggveny/)
  })
})

describe('a beszelgetes-ablak nem nezhet ki uresnek teli atirat felett', () => {
  it('az ablak megnyitasa keri a reszletek automatikus felfedeset', () => {
    const open = extractFn(app, 'openConversationModal')
    expect(open).toMatch(/loadConversation\(\s*\{\s*autoRevealDetail:\s*true\s*\}\s*\)/)
  })

  it('a frissites gomb NEM irja felul a kezi valasztast', () => {
    // loadConversation() opts nelkul -- ha a Frissites is autoReveal-t kuldene,
    // visszakapcsolna a pipat az operator minden kikapcsolasa utan.
    const idx = app.indexOf(`getElementById('conversationRefresh')`)
    expect(idx, 'nincs meg a frissites gomb bekotese').toBeGreaterThan(0)
    expect(app.slice(idx, idx + 160)).toMatch(/loadConversation\(\)/)
  })

  it('csak akkor kapcsol be a pipa, ha nincs csatorna-forgalom DE van bejegyzes', () => {
    const load = extractFn(app, 'loadConversation')
    expect(load).toMatch(/opts\.autoRevealDetail/)
    // Mindharom feltetel kell: pipa letezik, nincs in/out, es van mit mutatni.
    expect(load).toMatch(/e\.kind === 'in' \|\| e\.kind === 'out'/)
    expect(load).toMatch(/!hasChannelTraffic && conversationEntries\.length/)
  })

  it('a szures utani ures allapot megmondja, hany bejegyzes van elrejtve', () => {
    const render = extractFn(app, 'renderConversation')
    expect(render).toMatch(/conversation\.empty_filtered/)
    expect(render).toMatch(/conversation\.empty_search/)
    // A csupasz "nincs uzenet" csak akkor, ha tenyleg nulla bejegyzes van.
    expect(render).toMatch(/hidden\s*\?[\s\S]{0,200}:\s*t\('conversation\.empty'\)/)
  })

  it('a kereses es a szuro kulon uzenetet kap', () => {
    // Ugyanaz a szoveg mindkettore azt sugallna, hogy a pipa segit a keresesen.
    const render = extractFn(app, 'renderConversation')
    expect(render).toMatch(/q \? 'conversation\.empty_search' : 'conversation\.empty_filtered'/)
  })
})

describe('a hozza tartozo forditasok megvannak', () => {
  for (const lang of ['hu', 'en']) {
    it(`${lang}: empty_filtered es empty_search, {n} helyorzovel`, () => {
      const src = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const key of ['conversation.empty_filtered', 'conversation.empty_search']) {
        const m = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`).exec(src)
        expect(m, `${lang}: hianyzik a(z) ${key}`).toBeTruthy()
        expect(m![1], `${lang}: ${key} nem tartalmaz {n}-t`).toContain('{n}')
      }
    })
  }
})
