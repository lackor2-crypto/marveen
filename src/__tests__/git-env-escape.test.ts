/**
 * A GIT-HIVASOK NEM SZOKHETNEK AT AZ ELO REPOBA.
 *
 * 2026-09-03: a pre-push kapu a teljes teszt-suite-ot egy git HOOK-bol
 * inditotta. A hookok kornyezeteben a git beallitja a `GIT_DIR`-t, azt a
 * teszt-folyamatok orokoltek, es a `GIT_DIR` FELULIRJA a `cwd`-t. Igy negy
 * teszt-commit (`elso`, `elso`, `elso`, `egy`, mind `T <t@t>`) az ELO repo
 * `main` again landolt, es a teljes fat lecserelte egyetlen `a.txt`-re.
 *
 * Amit ez a fajl bizonyit:
 *   1. a vedelem nelkul a szokes TENYLEG megtortenik (kulonben a 2. pont
 *      akkor is zold lenne, ha a `cleanGitEnv` egy ures fuggveny volna),
 *   2. a vedelemmel a masik repo ERINTETLEN marad,
 *   3. a `git -C <ut>` sem ment meg -- a `GIT_DIR` azt is felulirja,
 *   4. az identitas-valtozok MEGMARADNAK (a tesztek epitenek rajuk).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanGitEnv, leakedGitVars, REPO_POINTING_GIT_VARS } from '../git-env.js'

const base = mkdtempSync(join(tmpdir(), 'git-env-escape-'))
const IDENT = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
}

/** Egy "elo" repo igazi tartalommal -- ezt kell erintetlenul hagyni. */
let elo = ''
/** Egy kulon konyvtar, ahol a "teszt" dolgozni AKAR. */
let munka = ''

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).toString()
}

/**
 * Ez a fajl maga is git-et hiv -- tehat ugyanugy ki lenne teve a szokesnek,
 * amit merni akar. A sajat hivasai ezert MINDIG tisztitott kornyezetbol
 * indulnak, es a "szennyezett" kornyezetbe is csak azt tesszuk vissza, amit
 * eppen merni akarunk.
 */
const TISZTA = () => ({ ...cleanGitEnv(), ...IDENT })
const SZENNYEZETT = (gitDir: string) => ({ ...TISZTA(), GIT_DIR: gitDir })

/** Hany fajl van az adott repo main again. */
function fileCount(repo: string): number {
  const out = execFileSync('git', ['--git-dir', join(repo, '.git'), 'ls-tree', '-r', '--name-only', 'main'],
    { encoding: 'utf8', env: cleanGitEnv() }).toString().trim()
  return out ? out.split('\n').length : 0
}

function head(repo: string): string {
  return execFileSync('git', ['--git-dir', join(repo, '.git'), 'log', '-1', '--format=%s'],
    { encoding: 'utf8', env: cleanGitEnv() }).toString().trim()
}

beforeEach(() => {
  elo = mkdtempSync(join(base, 'elo-'))
  munka = mkdtempSync(join(base, 'munka-'))
  const jo = TISZTA()
  git(elo, ['init', '-q', '-b', 'main'], jo)
  mkdirSync(join(elo, 'src'), { recursive: true })
  writeFileSync(join(elo, 'README.md'), 'fontos\n')
  writeFileSync(join(elo, 'src', 'index.ts'), 'export const x = 1\n')
  git(elo, ['add', '-A'], jo)
  git(elo, ['commit', '-qm', 'igazi munka'], jo)
  writeFileSync(join(munka, 'a.txt'), 'x\n')
})

afterAll(() => { try { rmSync(base, { recursive: true, force: true }) } catch { /* takaritas */ } })

describe('GIT_DIR-szokes', () => {
  it('VEDELEM NELKUL a szokes tenyleg megtortenik -- ezert kell a vedelem', () => {
    // Ez a teszt magat a MERCET hitelesiti. Ha ez zold lenne szokes nelkul is,
    // akkor a kovetkezo teszt semmit nem bizonyitana.
    expect(fileCount(elo)).toBe(2)
    const szennyezett = SZENNYEZETT(join(elo, '.git'))
    git(munka, ['add', '-A'], szennyezett)
    git(munka, ['commit', '-qm', 'elso'], szennyezett)

    expect(head(elo)).toBe('elso')          // az ELO repo commitot kapott
    expect(fileCount(elo)).toBe(1)          // es a fabol egyetlen fajl maradt
  })

  it('cleanGitEnv mellett a masik repo ERINTETLEN marad', () => {
    const vedett = cleanGitEnv(SZENNYEZETT(join(elo, '.git')))
    // A munka-konyvtar nem repo, tehat a git-nek EL KELL hasalnia -- nem
    // szabad, hogy "sikerrel" barhova mashova irjon.
    expect(() => git(munka, ['add', '-A'], vedett)).toThrow()

    expect(head(elo)).toBe('igazi munka')
    expect(fileCount(elo)).toBe(2)
  })

  it('a `git -C <ut>` sem ved meg -- a GIT_DIR azt is felulirja', () => {
    const masik = mkdtempSync(join(base, 'masik-'))
    git(masik, ['init', '-q', '-b', 'main'], TISZTA())
    writeFileSync(join(masik, 'b.txt'), 'b\n')

    const szennyezett = SZENNYEZETT(join(elo, '.git'))
    // Latszolag a `masik` repora mutat. A GIT_DIR miatt megsem oda ir.
    git(masik, ['-C', masik, 'add', '-A'], szennyezett)
    git(masik, ['-C', masik, 'commit', '-qm', 'masik repoba szantam'], szennyezett)
    expect(head(elo)).toBe('masik repoba szantam')

    // Ugyanez a hivas cleanGitEnv-vel mar tenyleg a `masik` repot talalja el.
    const elo2 = head(elo)
    rmSync(join(masik, 'b.txt'))
    writeFileSync(join(masik, 'c.txt'), 'c\n')
    const vedett = cleanGitEnv(szennyezett)
    git(masik, ['-C', masik, 'add', '-A'], vedett)
    git(masik, ['-C', masik, 'commit', '-qm', 'ez mar jo helyre megy'], vedett)
    expect(head(masik)).toBe('ez mar jo helyre megy')
    expect(head(elo)).toBe(elo2)            // az elo repo tovabbra sem mozdult
  })
})

describe('cleanGitEnv', () => {
  it('minden repot elterito valtozot levesz', () => {
    const szennyezett: NodeJS.ProcessEnv = {}
    for (const k of REPO_POINTING_GIT_VARS) szennyezett[k] = '/valahol/mashol'
    expect(leakedGitVars(szennyezett).sort()).toEqual([...REPO_POINTING_GIT_VARS].sort())
    expect(leakedGitVars(cleanGitEnv(szennyezett))).toEqual([])
  })

  it('az identitast es a jelszo-kezelest NEM veszi el', () => {
    const env = cleanGitEnv({
      ...IDENT, GIT_DIR: '/valahol', GIT_ASKPASS: '/x/askpass', GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -i /x', MARVEEN_GIT_TOKEN: 'titok',
    })
    expect(env.GIT_AUTHOR_NAME).toBe('T')
    expect(env.GIT_COMMITTER_EMAIL).toBe('t@t')
    expect(env.GIT_ASKPASS).toBe('/x/askpass')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /x')
    expect(env.MARVEEN_GIT_TOKEN).toBe('titok')
    expect(env.GIT_DIR).toBeUndefined()
  })

  it('nem irja at a kapott kornyezetet (nincs lathatatlan mellekhatas)', () => {
    const eredeti: NodeJS.ProcessEnv = { GIT_DIR: '/valahol' }
    cleanGitEnv(eredeti)
    expect(eredeti.GIT_DIR).toBe('/valahol')
  })
})
