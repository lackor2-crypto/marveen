import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Egy eldobhato git-repo a lemezen: a modul VALODI gitet hiv, tehat valodi
// repon kell merni. A PROJECT_ROOT-ot erre iranyitjuk at.
const repo = mkdtempSync(join(tmpdir(), 'marveen-remotes-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: repo }
})

const { readRemotes, setRemote, removeRemote, validateRemoteUrl, repoFromUrl } =
  await import('../web/git-remotes.js')

function git(...args: string[]): void {
  execFileSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf-8' })
}

beforeAll(() => {
  git('init', '-q')
  writeFileSync(join(repo, 'README.md'), '# probe\n')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('validateRemoteUrl', () => {
  it('elfogadja a https, ssh es scp-alaku cimeket', () => {
    for (const url of [
      'https://github.com/lackor2/marveen.git',
      'https://github.com/lackor2/marveen',
      'ssh://git@github.com/lackor2/marveen.git',
      'git@github.com:lackor2/marveen.git',
    ]) {
      expect(validateRemoteUrl(url), url).toEqual({ ok: true, url })
    }
  })

  it('levagja a korulotte levo szokozoket', () => {
    expect(validateRemoteUrl('  https://github.com/a/b.git  ')).toEqual({ ok: true, url: 'https://github.com/a/b.git' })
  })

  it('elutasitja az ureset', () => {
    expect(validateRemoteUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateRemoteUrl('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('elutasitja a belso szokozt (ket argumentumma esne szet)', () => {
    expect(validateRemoteUrl('https://github.com/a/b .git')).toEqual({ ok: false, reason: 'whitespace' })
  })

  it('elutasitja a kotojellel kezdodo cimet (a git sajat kapcsolojanak venne)', () => {
    expect(validateRemoteUrl('--upload-pack=whoami')).toEqual({ ok: false, reason: 'dash' })
  })

  // ★ Ez nem kozmetika: az `ext::` remote PARANCSOT futtat a lehuzaskor, a
  //   `file://` pedig a gep barmelyik mappajat behuzhatna. A cim a feluletrol
  //   jon, tehat nem bizunk benne.
  it('elutasitja a parancsot futtato es a helyi semakat', () => {
    expect(validateRemoteUrl('ext::sh -c whoami').ok).toBe(false)
    expect(validateRemoteUrl('ext::whoami')).toEqual({ ok: false, reason: 'scheme' })
    expect(validateRemoteUrl('file:///tmp/repo')).toEqual({ ok: false, reason: 'scheme' })
    expect(validateRemoteUrl('http://github.com/a/b.git')).toEqual({ ok: false, reason: 'scheme' })
  })

  it('elutasitja a csupasz utvonalat es a gazdagep nelkuli cimet', () => {
    expect(validateRemoteUrl('/tmp/repo')).toEqual({ ok: false, reason: 'shape' })
    expect(validateRemoteUrl('https://github.com')).toEqual({ ok: false, reason: 'shape' })
  })
})

describe('repoFromUrl', () => {
  it('GitHub-cimbol Owner/Repo lesz', () => {
    expect(repoFromUrl('https://github.com/lackor2/marveen.git')).toBe('lackor2/marveen')
    expect(repoFromUrl('git@github.com:Szotasz/marveen.git')).toBe('Szotasz/marveen')
  })
  it('nem GitHub-cimre ures string -- nem talalgatunk nevet', () => {
    expect(repoFromUrl('https://gitlab.com/a/b.git')).toBe('')
    expect(repoFromUrl('')).toBe('')
  })
})

describe('readRemotes', () => {
  it('friss repo: olvashato, de MINDKET forras null (ez nem hiba)', () => {
    const r = readRemotes()
    expect(r.readable).toBe(true)
    if (!r.readable) return
    expect(r.origin).toBeNull()
    expect(r.upstream).toBeNull()
  })

  it('beallitas utan mindket forrast visszaadja, a repo-nevvel egyutt', () => {
    expect(setRemote('origin', 'https://github.com/lackor2/marveen.git')).toEqual({ ok: true })
    expect(setRemote('upstream', 'https://github.com/Szotasz/marveen.git')).toEqual({ ok: true })
    const r = readRemotes()
    expect(r.readable).toBe(true)
    if (!r.readable) return
    expect(r.origin).toEqual({ name: 'origin', url: 'https://github.com/lackor2/marveen.git', repo: 'lackor2/marveen' })
    expect(r.upstream).toEqual({ name: 'upstream', url: 'https://github.com/Szotasz/marveen.git', repo: 'Szotasz/marveen' })
  })

  it('meglevo forras cime feluliras utan az UJ cimet mutatja', () => {
    expect(setRemote('origin', 'git@github.com:masik/marveen.git')).toEqual({ ok: true })
    const r = readRemotes()
    if (!r.readable) throw new Error('olvashatonak kellene lennie')
    expect(r.origin?.url).toBe('git@github.com:masik/marveen.git')
    expect(r.origin?.repo).toBe('masik/marveen')
  })
})

describe('setRemote / removeRemote', () => {
  it('csak az origin es az upstream allithato', () => {
    expect(setRemote('evil', 'https://github.com/a/b.git')).toEqual({ ok: false, reason: 'bad-name' })
    expect(setRemote('--upload-pack=x', 'https://github.com/a/b.git')).toEqual({ ok: false, reason: 'bad-name' })
  })

  it('rossz cimet nem ir ki a gitbe', () => {
    const before = readRemotes()
    expect(setRemote('upstream', 'ext::whoami')).toEqual({ ok: false, reason: 'bad-url', detail: 'scheme' })
    expect(readRemotes()).toEqual(before)
  })

  it('csak az upstream vehato le -- az origin nelkul nem lenne mibol frissulni', () => {
    expect(removeRemote('origin')).toEqual({ ok: false, reason: 'bad-name' })
    const r = readRemotes()
    if (!r.readable) throw new Error('olvashatonak kellene lennie')
    expect(r.origin).not.toBeNull()
  })

  it('az upstream levehato, es utana mar nincs ott (a levetel visszafordithato)', () => {
    expect(removeRemote('upstream')).toEqual({ ok: true })
    const after = readRemotes()
    if (!after.readable) throw new Error('olvashatonak kellene lennie')
    expect(after.upstream).toBeNull()
    // Visszafordithato: ugyanaz a cim ujra megadhato.
    expect(setRemote('upstream', 'https://github.com/Szotasz/marveen.git')).toEqual({ ok: true })
    const back = readRemotes()
    if (!back.readable) throw new Error('olvashatonak kellene lennie')
    expect(back.upstream?.repo).toBe('Szotasz/marveen')
  })
})

// ★ A NULLA KET DOLGOT JELENTHET. Ez a blokk a masodik jelentest meri: ha a
//   mappa nem git-checkout, a valasz NEM "nincs beallitva forras", hanem
//   kimondott "nem tudom megnezni" + a git TENYLEGES uzenete.
//   (A .git elvetele miatt ez a blokk a fajl vegen all.)
describe('readRemotes nem-git mappaban', () => {
  beforeAll(() => {
    rmSync(join(repo, '.git'), { recursive: true, force: true })
  })

  it('readable:false, es a git sajat hibauzenetevel jon vissza', () => {
    const r = readRemotes()
    expect(r.readable).toBe(false)
    if (r.readable) return
    expect(r.error.length).toBeGreaterThan(0)
    // A git sajat mondata, nem a mienk: ezt idezzuk a feluleten is.
    expect(r.error).toMatch(/not a git repository/i)
  })
})
