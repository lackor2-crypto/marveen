// Kanban aa55180c / #14 (14-A, BACKEND): a GitHub-bongeszo hatter tesztje.
//
// A `fetch`-et mockoljuk, es a config PROJECT_ROOT-jat egy ideiglenes store-ra
// iranyitjuk, ahova egy hamis token-tarolot irunk. Igy a VALODI utat jarjuk be:
// github-browse -> git-accounts.githubRequest -> (feloldott token) -> fetch.
// Ezzel azt is ellenorizzuk, hogy a token a SZERVEREN marad -- az elemzo a
// mockolt fetch Authorization-fejlecebol lathatja, de a fuggvenyek visszateresi
// erteke sose tartalmazza.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-ghbrowse-'))
mkdirSync(join(store, 'store'), { recursive: true })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

// Sajat PAT a `lackor2` fiokhoz -- ettol a resolveToken() sikerul, gh-CLI nelkul.
writeFileSync(
  join(store, 'store', '.git-tokens.json'),
  JSON.stringify({ lackor2: { token: 'ghp_TESTKULCS', login: 'lackor2', addedAt: '2026-09-04T00:00:00Z' } }),
  'utf8',
)

const { ghRepos, ghBranches, ghList, ghFile, ghPut } = await import('../github-browse.js')

interface Call { url: string; init: any }
let calls: Call[] = []

/** Egy Response-szeru objektum, amennyit a modul hasznal (ok/status/json). */
function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

/** A kovetkezo valasz(ok) sora, amit a mockolt fetch visszaad. */
let responder: (url: string, init: any) => any

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('github-browse (14-A backend)', () => {
  it('1) ghRepos: full_name -> fullName, default_branch -> defaultBranch, ureseket kiszur', async () => {
    responder = () => reply(200, [
      { name: 'marveen', full_name: 'lackor2-crypto/marveen', private: true, default_branch: 'main', updated_at: '2026-09-01T10:00:00Z' },
      { name: '', full_name: '', private: false, default_branch: '', updated_at: '' }, // ezt kiszurjuk
    ])
    const repos = await ghRepos('lackor2')
    expect(repos).toHaveLength(1)
    expect(repos[0]).toEqual({
      name: 'marveen', fullName: 'lackor2-crypto/marveen', private: true, defaultBranch: 'main', updatedAt: '2026-09-01T10:00:00Z',
    })
    // A token a SZERVEREN maradt: a fetch Authorization-fejlece hordozza, a
    // visszateresi ertek nem.
    expect(calls[0].init.headers.Authorization).toBe('Bearer ghp_TESTKULCS')
    expect(JSON.stringify(repos)).not.toContain('ghp_TESTKULCS')
  })

  it('2) ghBranches: az agak neveit adja vissza', async () => {
    responder = () => reply(200, [{ name: 'main' }, { name: 'work/lackor3' }, { name: '' }])
    expect(await ghBranches('lackor2', 'lackor2-crypto/marveen')).toEqual(['main', 'work/lackor3'])
  })

  it('3) ghList: a mappa tombjet GhEntry-kre kepezi (dir/file tipus)', async () => {
    responder = () => reply(200, [
      { name: 'src', path: 'src', type: 'dir', sha: 'aaa', size: 0 },
      { name: 'README.md', path: 'README.md', type: 'file', sha: 'bbb', size: 42 },
    ])
    const entries = await ghList('lackor2', 'lackor2-crypto/marveen', 'main', '')
    expect(entries).toEqual([
      { name: 'src', path: 'src', type: 'dir', sha: 'aaa', size: 0 },
      { name: 'README.md', path: 'README.md', type: 'file', sha: 'bbb', size: 42 },
    ])
    // A ref bekerul a lekerdezesbe.
    expect(calls[0].url).toContain('ref=main')
  })

  it('4) ghList: ha fajlt kaptunk (objektum, nem tomb) -> beszedes hiba', async () => {
    responder = () => reply(200, { name: 'README.md', type: 'file', sha: 'bbb', size: 42, content: '', encoding: 'base64' })
    await expect(ghList('lackor2', 'lackor2-crypto/marveen', 'main', 'README.md')).rejects.toThrow(/nem mappa/i)
  })

  it('5) ghFile: base64 tartalmat kibontja, sha-t visszaadja, nem truncated', async () => {
    const text = 'Helló GOLD\n'
    responder = () => reply(200, {
      name: 'a.txt', path: 'a.txt', type: 'file', sha: 'sha123',
      size: Buffer.byteLength(text), encoding: 'base64', content: Buffer.from(text, 'utf-8').toString('base64'),
    })
    const f = await ghFile('lackor2', 'lackor2-crypto/marveen', 'main', 'a.txt')
    expect(f.content).toBe(text)
    expect(f.sha).toBe('sha123')
    expect(f.truncated).toBe(false)
  })

  it('6) ghPut: sha NELKUL nem inditunk kerest, beszedes hibat dobunk', async () => {
    responder = () => reply(200, {})
    await expect(
      ghPut('lackor2', 'lackor2-crypto/marveen', 'main', 'a.txt', 'YWJj', '', 'uzenet'),
    ).rejects.toThrow(/sha kötelező/i)
    // A vedelem lenyege: sha nelkul EL SEM jutunk a GitHubig.
    expect(calls).toHaveLength(0)
  })

  it('7) ghPut: sha-val PUT-ot kuld (sha + branch a testben), commit sha-t ad vissza', async () => {
    responder = () => reply(200, { content: { path: 'a.txt', sha: 'ujsha' }, commit: { sha: 'commit789' } })
    const out = await ghPut('lackor2', 'lackor2-crypto/marveen', 'main', 'a.txt', 'YWJj', 'regisha', 'frissites')
    expect(out).toEqual({ path: 'a.txt', sha: 'ujsha', commit: 'commit789' })
    expect(calls[0].init.method).toBe('PUT')
    const sent = JSON.parse(calls[0].init.body)
    expect(sent.sha).toBe('regisha')
    expect(sent.branch).toBe('main')
    expect(sent.content).toBe('YWJj')
    // A token itt is csak a fejlecben van, a valaszban nem.
    expect(calls[0].init.headers.Authorization).toBe('Bearer ghp_TESTKULCS')
  })
})

// A temp store torlese a process vegen.
process.on('exit', () => { try { rmSync(store, { recursive: true, force: true }) } catch { /* takaritas */ } })
