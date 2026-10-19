// #712: a gepszintu `credential.helper = gh auth git-credential` ne irja felul a fiok sajat kulcsat.
//
// Mert hiba: a ~/.gitconfig segedje a Marveen GIT_ASKPASS-a ELOTT kerdezodik, es a gh AKTIV fiokjanak kulcsat adta
// (nem a tarolo fiokjet) -> "Repository not found" az 5 Freeber tarolon. A javitas (gitEnvFor) a segedlistat kiuriti
// az adott parancsra. Ez a teszt valodi `git credential fill`-lel mutatja, hogy a fiok kulcsa nyer.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const store = mkdtempSync(join(tmpdir(), 'marveen-credhelper-store-'))
const fakeHome = mkdtempSync(join(tmpdir(), 'marveen-credhelper-home-'))
mkdirSync(join(store, 'store'), { recursive: true })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => fakeHome }
})

const { gitEnvFor } = await import('../git-accounts.js')

// A "gepszintu" gitconfig: egy segedprogram, ami az IDEGEN (aktiv gh-) fiok kulcsat adja.
const wrongHelper = join(fakeHome, 'wrong-helper.sh')
writeFileSync(wrongHelper, '#!/bin/sh\necho username=wrong\necho password=WRONG_ACTIVE_ACCOUNT_KEY\n', { mode: 0o700 })
const globalCfg = join(fakeHome, 'gitconfig')
writeFileSync(
  globalCfg,
  `[credential "https://github.com"]\n\thelper = "${wrongHelper}"\n[credential]\n\thelper = "${wrongHelper}"\n`,
  'utf8',
)
mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true })
writeFileSync(
  join(fakeHome, '.config', 'gh', 'hosts.yml'),
  'github.com:\n    users:\n        usalackor-blip:\n            oauth_token: gho_RIGHT_ACCOUNT_KEY\n',
  'utf8',
)

const saved = { cfg: process.env.GIT_CONFIG_GLOBAL, nosys: process.env.GIT_CONFIG_NOSYSTEM, count: process.env.GIT_CONFIG_COUNT, askpass: process.env.GIT_ASKPASS, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME }
process.env.GIT_CONFIG_GLOBAL = globalCfg
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.GIT_CONFIG_COUNT
delete process.env.GIT_ASKPASS
process.env.HOME = fakeHome
process.env.XDG_CONFIG_HOME = join(fakeHome, 'xdg')

afterAll(() => {
  for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.cfg], ['GIT_CONFIG_NOSYSTEM', saved.nosys], ['GIT_CONFIG_COUNT', saved.count], ['GIT_ASKPASS', saved.askpass], ['HOME', saved.home], ['XDG_CONFIG_HOME', saved.xdg]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(store, { recursive: true, force: true })
  rmSync(fakeHome, { recursive: true, force: true })
})

function fillPassword(env: NodeJS.ProcessEnv): string {
  const out = execFileSync('git', ['credential', 'fill'], {
    env,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  return /^password=(.*)$/m.exec(out)?.[1] ?? ''
}

describe('gitEnvFor -- a fiok sajat kulcsa nyer a gepszintu segedprogram felett', () => {
  it('a gepszintu segedprogram (kiindulas) a rossz kulcsot adja', () => {
    expect(fillPassword({ ...process.env, GIT_TERMINAL_PROMPT: '0' })).toBe('WRONG_ACTIVE_ACCOUNT_KEY')
  })

  it('gitEnvFor-ral a fiok sajat (gh) kulcsa jon, nem az aktiv fioke', () => {
    expect(fillPassword(gitEnvFor('usalackor'))).toBe('gho_RIGHT_ACCOUNT_KEY')
  })

  it('mar meglevo GIT_CONFIG_COUNT mellett hozzafuz, nem ir felul', () => {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.abbrev'
    process.env.GIT_CONFIG_VALUE_0 = '9'
    try {
      const env = gitEnvFor('usalackor')
      expect(env.GIT_CONFIG_COUNT).toBe('3')
      expect(env.GIT_CONFIG_KEY_0).toBe('core.abbrev')
      expect(env.GIT_CONFIG_VALUE_0).toBe('9')
      expect(fillPassword(env)).toBe('gho_RIGHT_ACCOUNT_KEY')
    } finally {
      delete process.env.GIT_CONFIG_COUNT
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  it('kulcs nelkuli fiokhoz (nyilvanos repo) nem nyul a segedlistahoz', () => {
    const env = gitEnvFor('nincs-ilyen-fiok')
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GIT_ASKPASS).toBeUndefined()
  })
})
