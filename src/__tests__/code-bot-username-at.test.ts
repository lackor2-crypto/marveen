// Boss, 2026-08-23: "@@marveen_vscode_bot az attekintes fulon veletlen az hogy
// ketto kukac jel van vagy hiba?" -- hiba volt.
//
// Merve: a /api/code/health `codeBot.username` mezoje MAR tartalmazza a kukacot
// (`@${r.botUsername}`, code-bridge-telegram.ts), a csempe pedig meg egyet ele
// rakott. Ket forras, mindketto "biztos, ami biztos" alapon.
//
// A javitas nem az egyik oldal nemitasa: a csempe LEVAGJA a vezeto kukacot, es
// pontosan egyet tesz ki. Igy akkor is helyes, ha a szerver valaha kukac nelkul
// adja vissza a nevet (regi vagy masik forras) -- egy friss telepitesen sem
// szamit, melyik alakban erkezik.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

describe('kod-bot neve: pontosan egy kukac', () => {
  it('a csempe levagja a vezeto kukacot, mielott kitenne a sajatjat', () => {
    expect(app).toContain("'@' + String(bot.username).replace(/^@+/, '')")
    // A regi, duplazo alak ne jojjon vissza.
    expect(app).not.toContain("'@' + bot.username")
  })

  it('a viselkedes mindket bemeneti alakra egy kukac', () => {
    const render = (u: string) => '@' + String(u).replace(/^@+/, '')
    expect(render('@marveen_vscode_bot')).toBe('@marveen_vscode_bot')
    expect(render('marveen_vscode_bot')).toBe('@marveen_vscode_bot')
    expect(render('@@marveen_vscode_bot')).toBe('@marveen_vscode_bot')
  })
})
