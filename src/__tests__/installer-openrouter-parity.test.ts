import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Kanban #48. The OpenRouter key offer existed only in install-linux.sh, so a
// macOS install ended silently WITHOUT a fleet key -- and the multi-model
// debate then looks broken rather than "not configured yet". Nothing measured
// the difference: both installers were green, they just did different things.
//
// This file is that measurement. It does not read a status line and it does not
// trust the script's own text alone: it slices the block out of the macOS
// installer and RUNS it against a recorder standing in for node, so an empty
// diff (a previous attempt reported "done" with no code change) cannot pass.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const LANG = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')

/** Every `_t <key>` the two installers ask for. */
function usedKeys(src: string): Set<string> {
  return new Set(Array.from(src.matchAll(/_t\s+([A-Za-z0-9_.-]+)/g), (m) => m[1]))
}

/** Every `<lang>:<key>)` case arm defined in install-lang.sh. */
function definedKeys(lang: 'hu' | 'en'): Set<string> {
  const re = new RegExp(`^\\s*${lang}:([A-Za-z0-9_.-]+)\\)`, 'gm')
  return new Set(Array.from(LANG.matchAll(re), (m) => m[1]))
}

/** The OpenRouter section of an installer, from its banner to the next one. */
function openRouterBlock(src: string): string {
  const start = src.indexOf('# OpenRouter (opcionalis)')
  expect(start, 'nincs OpenRouter szekcio a telepitoben').toBeGreaterThan(-1)
  const end = src.indexOf('# Git hookok', start)
  expect(end, 'nincs lezaro szekcio az OpenRouter blokk utan').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('installer: az OpenRouter-kulcs felajanlasa mindket telepitoben ugyanaz', () => {
  it('a macOS telepito is felajanlja a kulcsot, es a Vault-ba menti', () => {
    const block = openRouterBlock(MACOS)
    expect(block).toContain('_t section_openrouter')
    expect(block).toContain('_t prompt_openrouter')
    expect(block).toContain("setSecret('openrouter-fleet-key'")
    expect(block).toContain('dist/web/vault.js')
  })

  it('kihagyhato: alapertelmezes "nem", es a kihagyas utat mutat', () => {
    const block = openRouterBlock(MACOS)
    expect(block).toContain('DO_OPENROUTER=${DO_OPENROUTER:-n}')
    expect(block).toContain('_t hint_openrouter_later')
  })

  it('a ket telepito UGYANAZOKAT a szovegkulcsokat hasznalja ehhez', () => {
    const linux = Array.from(usedKeys(openRouterBlock(LINUX))).sort()
    const macos = Array.from(usedKeys(openRouterBlock(MACOS))).sort()
    expect(macos).toEqual(linux)
  })

  it('a blokk a build UTAN fut, tehat a dist/ es a node mar megvan', () => {
    const build = MACOS.indexOf('npm run build')
    const node = MACOS.lastIndexOf('NODE_PATH=')
    const block = MACOS.indexOf('# OpenRouter (opcionalis)')
    expect(build).toBeGreaterThan(-1)
    expect(block).toBeGreaterThan(build)
    expect(block).toBeGreaterThan(node)
  })

  it('nincs beegetett kulcs egyik telepitoben sem', () => {
    expect(LINUX).not.toMatch(/sk-or-[A-Za-z0-9]/)
    expect(MACOS).not.toMatch(/sk-or-[A-Za-z0-9]/)
  })
})

describe('installer i18n: minden kepernyore kerulo szoveg ketnyelvu', () => {
  it('az install-lang.sh hu es en kulcshalmaza azonos', () => {
    const hu = definedKeys('hu')
    const en = definedKeys('en')
    expect(hu.size).toBeGreaterThan(0)
    expect(Array.from(hu).filter((k) => !en.has(k)).sort()).toEqual([])
    expect(Array.from(en).filter((k) => !hu.has(k)).sort()).toEqual([])
  })

  it('amit a telepitok kerdeznek, az le is van forditva', () => {
    const hu = definedKeys('hu')
    const en = definedKeys('en')
    for (const [name, src] of [['install-linux.sh', LINUX], ['install-macos.sh', MACOS]] as const) {
      const missing = Array.from(usedKeys(src)).filter((k) => !hu.has(k) || !en.has(k))
      expect(missing, `${name}: forditas nelkuli kulcs`).toEqual([])
    }
  })
})

describe('installer: az OpenRouter blokk tenylegesen le is fut', () => {
  // A "megvan a szovegben" nem bizonyitja, hogy mukodik. Kivagjuk a blokkot,
  // es RÖGZITOVEL futtatjuk (nem /bin/true nyelovel): a stub node kiirja, mivel
  // hivtak. Igy a hianyt es a hibas hivast is latjuk, nem csak a hallgatast.
  function runBlock(answers: string): { out: string; recorded: string } {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-or-'))
    try {
      const recorder = join(dir, 'node-recorder.sh')
      const log = join(dir, 'called.txt')
      writeFileSync(recorder, `#!/bin/bash\nprintf '%s\\n' "$@" >> "${log}"\nexit 0\n`)
      chmodSync(recorder, 0o755)
      const script = [
        'set -e',
        `source "${join(ROOT, 'install-lang.sh')}"`,
        'BOLD=""; DIM=""; NC=""; GREEN=""; ORANGE=""',
        'ok() { echo "OK: $*"; }',
        'warn() { echo "WARN: $*"; }',
        `INSTALL_DIR="${dir}"`,
        `NODE_PATH="${recorder}"`,
        openRouterBlock(MACOS),
      ].join('\n')
      const out = execFileSync('bash', ['-c', script], { input: answers, encoding: 'utf-8' })
      return { out, recorded: existsSync(log) ? readFileSync(log, 'utf-8') : '' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('ha a user kulcsot ad meg, a Vault-iras a megadott kulccsal indul', () => {
    const { out, recorded } = runBlock('i\ntest-key-NEM-VALODI\n')
    expect(recorded).toContain("setSecret('openrouter-fleet-key'")
    expect(recorded).toContain('test-key-NEM-VALODI')
    expect(out).toContain('OK:')
  })

  it('ha a user nemet mond, semmi nem fut, es megmondjuk hol potolhatja', () => {
    const { out, recorded } = runBlock('n\n')
    expect(recorded).toBe('')
    expect(out).toContain('Vault')
  })

  it('ures kulcs eseten nem irunk semmit, es szolunk rola', () => {
    const { out, recorded } = runBlock('i\n\n')
    expect(recorded).toBe('')
    expect(out).toContain('WARN:')
  })
})
