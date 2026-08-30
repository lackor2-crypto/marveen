// NYOMTALAN MUNKA: az eletfat nem szemeteljuk tele.
//
// Boss, 2026-08-30: "onmagatol ne keletkezzen semmilyen fajl (...) te, Marvin, az
// agentek senki nem tehet plusz fajlt ebbe az eletfaba (...) es akkor kesobb itt
// kiderul, hogy na egyebkent meg 8 darab fajl ott van" -- majd: "hogyha
// ideiglenesen (...) kell letrehozni egy fajlt, akkor azt utana, amikor a
// fejlesztes keszen van, utana torolni kell" -- es: "amikor vege van a munkanak
// commit es push azonnal".
//
// A mert eset (2026-08-29 18:34:18 - 18:37:05): nyolc fajl keletkezett a repo
// gyokereben harom perc alatt -- negy Playwright-probaszkript es a kimeneteik --,
// es egy napig ott alltak. Ket reteg volt nyitva egyszerre: semmi nem allitotta
// meg a keletkezest, es a commitolatlan-munka ora a nem-kovetett fajlokat
// SZANDEKOSAN eldobta, tehat semmi nem vette eszre utana sem.
//
// Egy kezzel futtatando checklist ezt nem allitja meg -- ez a fajl az, ami
// megbuktatja a munkat.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(REPO, 'scripts', 'hooks', 'no-stray-files.py')

/** A kaput ugy futtatjuk, ahogy a Claude Code teszi: JSON a stdin-en, a valasz
 *  a kilepesi kod (2 = tiltas). */
function futtat(
  gyoker: string,
  tool: string,
  filePath: string,
  env: Record<string, string> = {},
): { code: number; err: string } {
  const r = spawnSync('python3', [GATE], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: gyoker, ...env },
  })
  return { code: r.status ?? -1, err: r.stderr || '' }
}

function ideiglenesRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyomtalan-'))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'package.json'), '{}\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  execFileSync('git', ['-C', dir, 'add', 'package.json', 'src/a.ts'])
  return dir
}

describe('a kapu megallitja a szemetet, es megmondja hova irja helyette', () => {
  it('UJ fajl a gyokerben -> TILTVA, es az uzenet megnevezi a helyes utat', () => {
    const dir = ideiglenesRepo()
    try {
      const r = futtat(dir, 'Write', join(dir, '.tmp-check-marvin.mjs'))
      expect(r.code).toBe(2)
      // Nem eleg megallitani: meg kell mondani, mit csinaljon helyette.
      expect(r.err).toMatch(/\/tmp\//)
      expect(r.err).toMatch(/TOROLD/i)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('KOVETETT gyoker-fajl szerkesztese -> szabad (kulonben a package.json akadna el)', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Edit', join(dir, 'package.json')).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ideiglenes NEVU fajl akkor is tiltott, ha alkonyvtarban van', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Write', join(dir, 'src', '.tmp-proba.ts')).code).toBe(2)
      expect(futtat(dir, 'Write', join(dir, 'src', 'valami.bak')).code).toBe(2)
      expect(futtat(dir, 'Write', join(dir, 'src', 'scratch-1.json')).code).toBe(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rendes fajl rendes helyen -> szabad', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Write', join(dir, 'src', 'uj-modul.ts')).code).toBe(0)
      expect(futtat(dir, 'Write', join(dir, 'src', 'melyebben', 'meg.ts')).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a fan KIVUL semmit nem tilt -- a /tmp epp az ajanlott hely', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Write', join(tmpdir(), '.tmp-proba.mjs')).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a kapu MINDEN bizonytalansagnal atenged (soha nem allitja meg a flottat)', () => {
  it('nem orzott eszkoz -> szabad', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Bash', join(dir, 'akarmi.txt')).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ertelmezhetetlen bemenet -> szabad', () => {
    const r = spawnSync('python3', [GATE], { input: 'nem json', encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })

  it('hianyzo file_path -> szabad', () => {
    const r = spawnSync('python3', [GATE], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: {} }), encoding: 'utf-8',
    })
    expect(r.status).toBe(0)
  })

  it('ha a git nem valaszol, NEM tilt -- a "nem latok oda" nem "nincs kovetett fajl"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyomtalan-nogit-'))
    try {
      // Nincs .git: a `git ls-files` hibaval ter vissza. Ha a kapu ilyenkor ures
      // halmazt feltetelezne, MINDEN gyoker-irast megtiltana.
      expect(futtat(dir, 'Write', join(dir, 'barmi.md')).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('MARVEEN_STRAY_FILE_GATE=0 kikapcsolja', () => {
    const dir = ideiglenesRepo()
    try {
      expect(futtat(dir, 'Write', join(dir, '.tmp-x.mjs'), { MARVEEN_STRAY_FILE_GATE: '0' }).code).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a kapu tenylegesen be van kotve (nem eleg megirni)', () => {
  it('a szkript letezik es futtathato', () => {
    expect(existsSync(GATE)).toBe(true)
  })

  it('a repo sajat .claude/settings.json-jeben PreToolUse-kent szerepel', () => {
    const s = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf-8'))
    const ptu = JSON.stringify(s?.hooks?.PreToolUse ?? [])
    expect(ptu).toContain('no-stray-files.py')
    expect(ptu).toContain('Write|Edit|MultiEdit|NotebookEdit')
  })

  it('minden agens megkapja: a web.ts indulaskor meghivja', () => {
    const web = readFileSync(join(REPO, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureStrayFileGate(agentName)')
    expect(web).toContain('ensureNoStrayFilesSection(agentName)')
    // ...es gepszinten is, mert egy worktree-ben dolgozo agens sosem olvassa a
    // sajat agents/<nev>/CLAUDE.md-jet.
    expect(web).toContain('ensureGlobalNoStrayFilesRule()')
  })

  it('a hook-or a sajat szkriptjenek ismeri (kulonben hianyzo fajlkent nem takaritja)', () => {
    const guard = readFileSync(join(REPO, 'src', 'web', 'hook-registration-guard.ts'), 'utf-8')
    expect(guard).toContain("'no-stray-files.py'")
  })

  it('a szabaly szovege kimondja mind a harom felet', () => {
    const scaffold = readFileSync(join(REPO, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    const kezd = scaffold.indexOf('function buildNoStrayBody()')
    expect(kezd).toBeGreaterThan(-1)
    const test = scaffold.slice(kezd, kezd + 4000)
    expect(test).toMatch(/Ideiglenes fajl SOHA nem a projekt fajaba megy/)
    expect(test).toMatch(/a fejlesztes vegen TOROLD LE/)
    expect(test).toMatch(/AZONNAL commit ES push/)
  })
})

describe('a figyelo eszreveszi a szemetet ES a pusholatlan munkat', () => {
  it('a nem-kovetett sorokat kulon szedi ki', async () => {
    const { parseStrayPaths } = await import('../web/uncommitted-work-runner.js')
    const porcelain = ' M src/a.ts\n?? .tmp-shot1.png\n?? "furcsa nev.txt"\nA  src/b.ts\n'
    expect(parseStrayPaths(porcelain)).toEqual(['.tmp-shot1.png', 'furcsa nev.txt'])
  })

  it('a harom kategoria HAROM kulon mondat, mert harom kulon teendo', async () => {
    const { describeMess } = await import('../uncommitted-work.js')
    const now = Date.now()
    const reg = now - 5 * 3_600_000
    const sz = describeMess({
      dirty: [{ path: 'src/a.ts', modifiedAt: reg }],
      stray: [{ path: '.tmp-shot1.png', modifiedAt: reg }],
      unpushed: 4, branch: 'main',
    }, now)!
    expect(sz).toMatch(/commitolatlan/)
    expect(sz).toMatch(/szemet/)
    expect(sz).toMatch(/4 commit nincs felpusholva/)
    expect(sz).toMatch(/main/)
  })

  it('a NULL pusholatlan-szam nem jelenik meg nullakent (nem latok oda != nincs)', async () => {
    const { describeMess, messIsEmpty } = await import('../uncommitted-work.js')
    const m = { dirty: [], stray: [], unpushed: null, branch: '' }
    expect(messIsEmpty(m)).toBe(true)
    expect(describeMess(m, Date.now())).toBeNull()
  })

  it('tiszta fa eseten hallgat', async () => {
    const { describeMess } = await import('../uncommitted-work.js')
    expect(describeMess({ dirty: [], stray: [], unpushed: 0, branch: 'main' }, Date.now())).toBeNull()
  })
})

describe('A FA MOST is tiszta -- ez a teszt buktatja meg a munkat', () => {
  it('nincs nem-kovetett fajl a repo gyokereben', () => {
    const r = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf-8' })
    // A NULLA KET DOLGOT JELENTHET: ha a git nem valaszol, az NEM tiszta fa.
    // Inkabb bukjon el hangosan, mint hogy csendben atengedjen.
    expect(r.status, `a git nem valaszolt: ${r.stderr}`).toBe(0)
    const szemet = (r.stdout || '')
      .split('\n')
      .filter(l => l.slice(0, 2) === '??')
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(p => !p.includes('/'))
    expect(
      szemet,
      'Szemet all a repo gyokereben. Ha a fejlesztes keszen van, TOROLD; ha a '
      + 'projekt resze, commitold. Ideiglenes fajl /tmp/ ala valo.',
    ).toEqual([])
  })
})
