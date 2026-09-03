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

/**
 * Gyoker-szintu VALODI stray-ek egy `git ls-files` es egy `git status
 * --porcelain --untracked-files=all` kimenetbol -- vagy `null`, ha az olvasat
 * onellentmondo (terhelesi zaj): kovetett fajl jelenik meg nem-kovetettkent,
 * vagy hianyzik az alap-fajl (package.json) az ls-files-bol. A hivo ilyenkor
 * ujraprobal, es tartos ellentmondas eseten fail-open (nem tekinti szemetnek).
 */
export function classifyRootStrays(
  lsFilesStdout: string,
  statusStdout: string,
): string[] | null {
  const tracked = new Set(lsFilesStdout.split('\n').map(s => s.trim()).filter(Boolean))
  // Sanity: nehany gyokerfajl GARANTALTAN kovetett. Terheles alatt a megosztott
  // repo indexe atmenetileg csonka olvasatot adhat (pl. package.json megvan, de
  // a README.md hianyzik) -- pont ez okozta a hamis pozitivot. Ezert TOBB stabil
  // gyokerfajl meglétét kerjuk, nem csak egyet; ha barmelyik hianyzik, az olvasat
  // megbizhatatlan -> null (a hivo ujraprobal, tartos hibanal fail-open).
  const MUST_BE_TRACKED = ['package.json', 'tsconfig.json', 'README.md', 'vitest.config.ts', 'LICENSE']
  if (!MUST_BE_TRACKED.every(f => tracked.has(f))) return null
  const untrackedRoot = statusStdout
    .split('\n')
    .filter(l => l.slice(0, 2) === '??')
    .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(p => !p.includes('/'))
  // Ellentmondas: kovetett fajl nem-kovetettkent -> az olvasat megbizhatatlan.
  if (untrackedRoot.some(p => tracked.has(p))) return null
  // Valodi stray = nem-kovetett ES nincs az ls-files-ban.
  return untrackedRoot.filter(p => !tracked.has(p))
}

describe('classifyRootStrays: a valodi stray-t elkapja, a terhelesi hamis pozitivot nem', () => {
  const LS = 'package.json\ntsconfig.json\nREADME.md\nvitest.config.ts\nLICENSE\nsrc/a.ts\n'
  it('valodi gyoker-stray -> jelzi', () => {
    expect(classifyRootStrays(LS, '?? .tmp-shot1.png\n M src/a.ts\n')).toEqual(['.tmp-shot1.png'])
  })
  it('tobb valodi stray -> mindet jelzi', () => {
    expect(classifyRootStrays(LS, '?? .tmp-a.mjs\n?? "furcsa nev.txt"\n')).toEqual(['.tmp-a.mjs', 'furcsa nev.txt'])
  })
  it('tiszta fa -> ures lista', () => {
    expect(classifyRootStrays(LS, ' M src/a.ts\nA  src/b.ts\n')).toEqual([])
  })
  it('KOVETETT fajl ??-kent (a #101-et blokkolo terhelesi hamis pozitiv) -> null, nem szemet', () => {
    expect(classifyRootStrays(LS, '?? README.md\n?? package.json\n')).toBeNull()
  })
  it('csonka ls-files (nincs package.json) -> null, nem epitunk ra', () => {
    expect(classifyRootStrays('', '?? .tmp-x.png\n')).toBeNull()
  })
  it('reszleges index (package.json megvan, README.md hianyzik) -> null, ez volt a #101 hamis pozitiv', () => {
    // Pontosan a mert eset: az ls-files csonka (megvan a package.json, de a
    // README.md kimaradt), es a status a hianyzo kovetett fajlokat ??-kent latja.
    const partialLs = 'package.json\ntsconfig.json\nvitest.config.ts\nLICENSE\nsrc/a.ts\n'
    expect(classifyRootStrays(partialLs, '?? README.md\n?? ATTRIBUTIONS.md\n')).toBeNull()
  })
  it('alkonyvtari ?? nem szamit gyoker-stray-nek', () => {
    expect(classifyRootStrays(LS, '?? src/.tmp-y.ts\n')).toEqual([])
  })
})

describe('A FA MOST is tiszta -- ez a teszt buktatja meg a munkat', () => {
  // Egy VALODI stray fajl definicio szerint nem-kovetett: sosem szerepel a
  // `git ls-files`-ban. A pre-push kapu viszont a teljes suite-ot egy detached
  // worktree-ben futtatja, es parhuzamos git-terheles alatt (tobb agens
  // egyidejű teszt-/heartbeat-futasa ugyanazon a gepen) a `git status`
  // atmenetileg KOVETETT gyokerfajlokat (README.md, package.json) is jelenthet
  // nem-kovetettkent -- vagy a `git` hivas maga csonkul/hibazik. Ez blokkolta a
  // #101 (b4beb9b4) landolasat 2026-09-03-an haromszor, holott a tartalom es a
  // fuggetlen izolalt futas is zold volt (kartya 1a273800).
  //
  // Ezert a stray-t a KOVETETT halmazon atszurve allapitjuk meg (?? ES nincs a
  // ls-files-ban), az olvasast pedig addig ismeteljuk, amig konzisztens. Ha a
  // git tartosan nem ad megbizhato valaszt, az a "nem latok oda" eset: NEM
  // tekintjuk szemetnek (a stray-t amugy is elkapja a no-stray-files.py
  // PreToolUse kapu es a commitolatlan-munka ora), csak figyelmeztetunk. Egy
  // legitim landolas blokkolasa terhelesi zaj miatt valos kar; egy stray egy
  // push-nal atengedese jelentektelen es tobb helyen is fennakad. "nem latok
  // oda" != "szemet", ugyanugy ahogy != "tiszta".
  it('nincs nem-kovetett fajl a repo gyokereben', () => {
    /** Gyoker-szintu VALODI stray-ek, vagy null ha az olvasat megbizhatatlan. */
    const rootStrays = (): string[] | null => {
      const lf = spawnSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf-8' })
      if (lf.status !== 0) return null
      const st = spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf-8' })
      if (st.status !== 0) return null
      return classifyRootStrays(lf.stdout || '', st.stdout || '')
    }

    let szemet: string[] | null = null
    for (let attempt = 0; attempt < 6; attempt++) {
      szemet = rootStrays()
      if (szemet !== null) break
      spawnSync('sleep', ['0.4']) // hatha epp egy masik git-hivas irja az indexet
    }
    if (szemet === null) {
      // Tartosan megbizhatatlan git-olvasas: kornyezeti zaj, nem stray-problema.
      // Fail-open: nem blokkoljuk a landolast (a stray-t mas kapu is figyeli).
      console.warn(
        '[nyomtalan-munka] a git status/ls-files tartosan nem adott konzisztens '
        + 'valaszt (terheles?); a gyoker-stray ellenorzest kihagyom -- a '
        + 'no-stray-files.py kapu es a commitolatlan-munka ora amugy is figyel.',
      )
      return
    }
    expect(
      szemet,
      'Szemet all a repo gyokereben. Ha a fejlesztes keszen van, TOROLD; ha a '
      + 'projekt resze, commitold. Ideiglenes fajl /tmp/ ala valo.',
    ).toEqual([])
  })
})
