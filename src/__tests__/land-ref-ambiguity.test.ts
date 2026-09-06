// 2026-09-06, 19:44: valaki letrehozott egy `origin/main` nevu LOKALIS agat a
// repoban. A git keresesi sorrendjeben a refs/heads/ ELOREBB van a
// refs/remotes/-nel, ezert onnantol minden csupasz `origin/main` olvasas a helyi
// arnyek-agat latta a tavoli helyett. Ket dolog tort el tole egyszerre:
//
//   - a land-pr.sh megallt ("a 'git rev-list --count' valasza nem szam
//     ('warning: refname 'origin/main' is ambiguous. 17')") -- a kapuja helyesen
//     jart el, de a flotta landolasa allt;
//   - a deploy-live.sh ELHALLGATTA a bajt: a `2>/dev/null` elnyelte a
//     figyelmeztetest, a szkript egy 14 committel regebbi commitot latott
//     "naprakesz"-nek, es 19:46-tol minden korben zold "Finished OK"-t irt --
//     kozben egyetlen landolt valtozas sem jutott ki az eles peldanyra.
//
// Ez a teszt eloszor BIZONYITJA, hogy az arnyekolas ezen a git-verzion is valos
// (kulonben csak egy szoveg-egyeztetes maradna), utana kotelezi a ket szkriptet
// arra, hogy a teljes refbol dolgozzon es kimondja, ha arnyek-ag van.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(__dirname, '..', '..', 'scripts')
const landPr = readFileSync(join(SCRIPTS, 'land-pr.sh'), 'utf8')
const deployLive = readFileSync(join(SCRIPTS, 'deploy-live.sh'), 'utf8')

let repo = ''
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'marveen-refambig-'))
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'a.txt'), 'regi\n')
  git('add', '-A'); git('commit', '-q', '-m', 'regi')
  const oldSha = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.txt'), 'uj\n')
  git('add', '-A'); git('commit', '-q', '-m', 'uj')
  const newSha = git('rev-parse', 'HEAD')
  // A tavoli ag az UJ commiton; az arnyek-ag a REGIN -- pontosan mint elesben.
  git('update-ref', 'refs/remotes/origin/main', newSha)
  git('update-ref', 'refs/heads/origin/main', oldSha)
})

afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }) })

describe('origin/main arnyekolas: a csupasz nev nem ref', () => {
  it('a csupasz "origin/main" a HELYI arnyek-agra oldodik fel, nem a tavolira', () => {
    const shadow = git('rev-parse', 'refs/heads/origin/main')
    const remote = git('rev-parse', 'refs/remotes/origin/main')
    expect(shadow).not.toBe(remote)
    // Ez a sor a bizonyitek: a hazard nem elmeleti, ezen a git-en is fennall.
    expect(git('rev-parse', 'origin/main')).toBe(shadow)
  })

  it('a teljes ref viszont mindig a tavoli agat adja', () => {
    expect(git('rev-parse', 'refs/remotes/origin/main')).not.toBe(git('rev-parse', 'refs/heads/origin/main'))
    expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(git('rev-parse', 'main'))
  })

  it('a "hany commit-tal vagyok elorebb" meres a csupasz neven ROSSZ szamot ad', () => {
    // A HEAD (main) az uj commiton all. A tavolihoz kepest 0 a kulonbseg, az
    // arnyekhoz kepest 1 -- a szkript ebbol dontene, hogy van-e mit landolni.
    expect(git('rev-list', '--count', 'refs/remotes/origin/main..HEAD')).toBe('0')
    expect(git('rev-list', '--count', 'refs/heads/origin/main..HEAD')).toBe('1')
  })
})

describe('a landolo es deployolo szkript a TELJES refet olvassa', () => {
  it('land-pr.sh nem olvas csupasz origin/main-t a mereseihez', () => {
    expect(landPr).toContain('MAIN_REF="refs/remotes/origin/main"')
    expect(landPr).toContain('git rev-list --count "$MAIN_REF"..HEAD')
    // A csupasz nev csak `git fetch origin main` alakban maradhat (ott a
    // "main" a TAVOLI ag neve, nem egy helyi ref-feloldas).
    expect(landPr).not.toMatch(/rev-list --count origin\/main/)
    expect(landPr).not.toMatch(/rev-parse --short origin\/main/)
  })

  it('deploy-live.sh nem olvas csupasz origin/$BRANCH-et', () => {
    expect(deployLive).toContain('MAIN_REF="refs/remotes/origin/$BRANCH"')
    expect(deployLive).toMatch(/rev-parse "\$MAIN_REF"/)
    expect(deployLive).not.toMatch(/rev-parse "origin\/\$BRANCH"/)
  })

  it('mindketto KIMONDJA, ha arnyek-ag van -- nem csak megkeruli', () => {
    // A csendes megkerules ugyanolyan rossz: a kovetkezo ember megint fel orat
    // keresne, mert a repo allapotarol semmi nem szol.
    expect(landPr).toMatch(/show-ref --verify --quiet refs\/heads\/origin\/main/)
    expect(landPr).toMatch(/git branch -D origin\/main/)
    expect(deployLive).toMatch(/show-ref --verify --quiet "refs\/heads\/origin\/\$BRANCH"/)
    expect(deployLive).toMatch(/git branch -D origin\/\$BRANCH/)
  })

  it('a deploy-live figyelmeztetese a naploba megy, nem a /dev/null-ba', () => {
    // Sor-alapu keres: a "shadows" szo a MAGYARAZO KOMMENTBEN is szerepel, es
    // egy karakter-offsetes vizsgalat azt talalna meg eloszor -- vagyis zold
    // lenne akkor is, ha a figyelmeztetes maga hianyzik.
    const warnLine = deployLive.split('\n').find(l => l.includes('log "WARNING'))
    expect(warnLine, 'nincs log "WARNING sor a deploy-live.sh-ban').toBeTruthy()
    expect(warnLine).toContain('shadows the remote-tracking ref')
  })
})
