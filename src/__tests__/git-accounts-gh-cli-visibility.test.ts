// GITHUB-FIOK LATHATOSAG: gh-CLI-bol felismert fiok is jelenjen meg a listaban.
//
// Boss, 2026-09-02: a Fiokok oldal ures GitHub-listat mutatott a lackor2 es
// usalackor fiokra, holott mindketto regisztralva volt a Raktar oldalon
// (storages.json gitAccounts) es mukodott is git-muveletekhez -- csak a
// gh-CLI sajat bejelentkezeset hasznaltak, nem egy Marveenbe irt PAT-ot.
// gitAccountsWithToken() addig CSAK a sajat token-tarolo (readTokens())
// kulcsait nezte, tehat egy gh-CLI-bol felismert fiokot soha nem mutatott,
// pedig a tenyleges git-muveletekhez hasznalt hasGitToken() mar figyelembe
// vette a gh-forrast is -- a ket fuggveny szetvalt.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-ghvis-store-'))
const fakeHome = mkdtempSync(join(tmpdir(), 'marveen-ghvis-home-'))
mkdirSync(join(store, 'store'), { recursive: true })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => fakeHome }
})

const { gitAccountsWithToken } = await import('../git-accounts.js')
const { writeStorageRegistry } = await import('../storages.js')

function writeGhHosts(entries: Array<{ login: string; token: string }>) {
  mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true })
  const users = entries.map((e) => `        ${e.login}:\n            oauth_token: ${e.token}`).join('\n')
  writeFileSync(join(fakeHome, '.config', 'gh', 'hosts.yml'), `github.com:\n    users:\n${users}\n`, 'utf8')
}

describe('gitAccountsWithToken', () => {
  it('regisztralt fiokot gh-CLI kulccsal is lat, sajat PAT nelkul', () => {
    writeStorageRegistry({ ids: {}, names: {}, disabled: {}, gitAccounts: ['lackor2', 'sehol'] })
    writeGhHosts([{ login: 'lackor2-crypto', token: 'gho_abc' }])
    expect(gitAccountsWithToken()).toEqual(['lackor2'])
  })

  it('nem regisztralt fiokot NEM mutat, akkor sem ha van gh-token', () => {
    writeStorageRegistry({ ids: {}, names: {}, disabled: {}, gitAccounts: [] })
    writeGhHosts([{ login: 'lackor2-crypto', token: 'gho_abc' }])
    expect(gitAccountsWithToken()).toEqual([])
  })

  it('regisztralt fiokot NEM mutat, ha sem sajat sem gh-token nincs hozza', () => {
    writeStorageRegistry({ ids: {}, names: {}, disabled: {}, gitAccounts: ['arva'] })
    writeGhHosts([])
    expect(gitAccountsWithToken()).toEqual([])
  })
})
