// Kanban #372: two code-bridge cards of the same bot ("Marvin VS Code") looked
// identical on the Agents page. Each card now names its folder and where it
// lives (WSL / Windows / Linux), read from the project's own workspacePath --
// never from anything host-specific. The helpers are lifted out of web/app.js
// and run, so the test measures behaviour, not source text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() is missing from web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() braces do not balance`)
}

const harness = `
  function t(key, vars) { return key + '|' + (vars ? vars.folder : '') }
  ${extractFn(app, 'cbWorkspaceKind')}
  ${extractFn(app, 'cbProjectLine')}
  return { cbWorkspaceKind: cbWorkspaceKind, cbProjectLine: cbProjectLine }
`
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const api = new Function(harness)() as {
  cbWorkspaceKind: (p: unknown) => string
  cbProjectLine: (e: Record<string, unknown>) => string
}

describe('#372 code-bridge card: which folder, and where', () => {
  it('tells WSL, Windows and Linux paths apart', () => {
    expect(api.cbWorkspaceKind('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj')).toBe('wsl')
    expect(api.cbWorkspaceKind('\\\\wsl$\\Debian\\srv\\proj')).toBe('wsl')
    expect(api.cbWorkspaceKind('//wsl.localhost/Ubuntu/home/u/proj')).toBe('wsl')
    expect(api.cbWorkspaceKind('f:\\Data\\Projects\\Stocks')).toBe('windows')
    expect(api.cbWorkspaceKind('C:/work/app')).toBe('windows')
    expect(api.cbWorkspaceKind('/home/u/proj')).toBe('linux')
  })

  it('does not guess a platform it cannot read', () => {
    expect(api.cbWorkspaceKind('')).toBe('')
    expect(api.cbWorkspaceKind(null)).toBe('')
    expect(api.cbWorkspaceKind('\\\\fileserver\\share\\proj')).toBe('')
  })

  it('the two real-world cards get different lines', () => {
    const a = api.cbProjectLine({ project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\marveen' })
    const b = api.cbProjectLine({ project: 'tozsde', workspacePath: 'f:\\Data\\Projekt\\Tőzsde\\' })
    expect(a).toBe('cb.card.where_wsl|marveen')
    expect(b).toBe('cb.card.where_windows|Tőzsde')
    expect(a).not.toBe(b)
  })

  it('falls back to the alias, and to nothing, without inventing', () => {
    expect(api.cbProjectLine({ project: 'p', workspacePath: '' })).toBe('p')
    expect(api.cbProjectLine({})).toBe('')
  })

  it('the card renders the line, and the text exists in both languages', () => {
    expect(extractFn(app, 'renderCodeBridgeAgentCards')).toContain('cb-project-line')
    for (const k of ['wsl', 'windows', 'linux']) {
      expect(hu).toContain(`'cb.card.where_${k}':`)
      expect(en).toContain(`'cb.card.where_${k}':`)
    }
  })
})
