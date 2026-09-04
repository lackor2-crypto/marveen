// A LANDOLASI DOKTRINA gepi kapuja.
//
// MIERT (2026-09-04): a landolas-atallas (PR + zold CI, a main-re direkt push
// helyett) atirta a szkripteket, de a TUDAST nem sopörte vegig. A #8/#9 utan is
// igaz volt, hogy:
//
//   - a seed-skills/github-pr-rebase-merge/SKILL.md meg mindig `git push origin
//     main`-t tanitott. A telepito KIZAROLAG a seed-skills/-et masolja ki, tehat
//     egy FRISS telepites pontosan a mar tiltott utat kapta meg -- ott pedig a
//     branch protection (required check: ci-passed, enforce_admins: true) miatt
//     ez "protected branch hook declined"-dal bukik.
//   - a land-pr.sh a `gh` MINDEN hibajat (halozat, 401, hianyzo gh) egyetlen
//     `|| echo 0`-ra kepezte, es mindre azt allitotta, hogy "a GitHub Actions KI
//     van kapcsolva" -- vagyis TALALGATTA a hiba okat, es a "nem latok oda"-t
//     "nincs"-nek olvasta.
//   - a CI-varas hatarideje (900s) ROVIDEBB volt a CI sajat legrosszabb
//     esetenel (15 perc test + 2 perc ci-passed), tehat egy lassu, de ZOLD CI-t
//     eldobott volna.
//
// Ez a fajl azert van, hogy ezek egyike se tudjon visszamaszni eszrevetlenul.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LAND_PR = join(REPO, 'scripts', 'land-pr.sh')
const CI_YML = join(REPO, '.github', 'workflows', 'ci.yml')

/** Minden fajl a megadott konyvtar alatt, rekurzivan. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * A ```bash / ```sh kodblokkok VEGREHAJTHATO sorai (a kommentek nelkul).
 *
 * Szandekosan csak a kodblokkokat nezzuk: a prozaban valo emlites ("a regi
 * recept `git push origin main` volt") tanulsag, nem utasitas -- azt hagyni
 * KELL, kulonben nem tudjuk leirni, mit ne csinaljanak.
 */
function executableShellLines(markdown: string): string[] {
  const lines = markdown.split('\n')
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    const fence = line.trimStart().match(/^```(\w*)/)
    if (fence) {
      inBlock = fence[1] === 'bash' || fence[1] === 'sh' || fence[1] === 'shell' ? true : false
      continue
    }
    if (!inBlock) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    out.push(trimmed)
  }
  return out
}

/**
 * Egy shell-script VEGREHAJTHATO sorai: a teljes soros kommentek nelkul.
 *
 * Ugyanaz a megfontolas, mint a markdownnal: a land-pr.sh maga MAGYARAZZA, hogy
 * regen egyetlen `|| echo 0` fedte el a harom kulonbozo hibaallapotot. Ha a
 * guard a nyers szovegre nezne, a sajat tanulsagunk leirasat tiltana be -- es
 * pont az a resz esne ki, amitol a kovetkezo olvaso megerti, miert nem szabad.
 */
function executableBashLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
}

// `git push [flagek] origin main|master` -- a tiltott, kozvetlen landolas.
const DIRECT_MAIN_PUSH = /\bgit\s+push\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+\S*origin\S*\s+(?:HEAD:)?(?:refs\/heads\/)?(?:main|master)\b/

describe('a friss telepitesre kikerulo tudas nem tanit direkt main-push-t', () => {
  // A telepito KIZAROLAG ezt a ket helyet viszi ki egy uj gepre. Ami itt all,
  // az a friss telepites egyetlen tudasforrasa a landolasrol.
  const surfaces = [join(REPO, 'seed-skills'), join(REPO, 'templates')]
  const files = surfaces.flatMap(walk).filter((f) => f.endsWith('.md') || f.endsWith('.template'))

  it('van mit ellenoriznie (a nulla itt "nem latok oda" is lehetne)', () => {
    // Ha ez a szam nulla lenne, a tobbi teszt "zold"-et mondana ugy, hogy
    // valojaban semmit nem nezett meg.
    expect(files.length).toBeGreaterThan(10)
  })

  it.each([['seed-skills'], ['templates']])('a(z) %s/ alatt egy kodblokk sem pushol a main-re', (surface) => {
    const offenders: string[] = []
    for (const file of files.filter((f) => f.includes(`${surface}`))) {
      for (const line of executableShellLines(readFileSync(file, 'utf8'))) {
        if (DIRECT_MAIN_PUSH.test(line)) offenders.push(`${relative(REPO, file)}: ${line}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('a PR-landolo skill ismeri a land-pr.sh-t', () => {
    const skill = join(REPO, 'seed-skills', 'github-pr-rebase-merge', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, 'utf8')).toContain('land-pr.sh')
  })
})

describe('land-pr.sh: a nulla ket dolgot jelenthet', () => {
  const script = readFileSync(LAND_PR, 'utf8')
  const code = executableBashLines(script)

  // Ezek mind MERESI EREDMENYT hamisitanak: a hibas hivas kimenetet egy
  // ervenyesnek latszo ertekre cserelik, es onnantol a szkript nem tudja
  // megkulonboztetni a "nincs"-et a "nem latok oda"-tol.
  it('a komment-szuro tenylegesen szur (kulonben minden alabbi teszt vakon zold)', () => {
    // Ha az executableBashLines valamiert ures listat adna, a lenti `filter`-ek
    // mind ures tombot talalnanak, es a suite "zold"-et mondana ugy, hogy semmit
    // nem nezett meg. Ez ugyanaz a csapda, mint a nullas szabaly.
    const total = script.split('\n').length
    expect(code.length).toBeGreaterThan(0)
    expect(code.length).toBeLessThan(total)
  })

  it.each([
    ['|| echo 0', 'a gh/git hibat "nulla talalat"-ra keperi'],
    ['|| echo EMPTY', 'a parser hibajat "nincs check"-re keperi'],
    ["|| echo '[]'", 'a gh hibajat ures rollupra keperi'],
  ])('nem tartalmaz vak %s visszaesest (%s)', (pattern) => {
    const offenders = code.filter((line) => line.includes(pattern))
    expect(offenders).toEqual([])
  })

  it('a gh hibajat a KILEPOKOD alapjan kezeli, nem a kimenet alakjabol', () => {
    expect(script).toContain('runs_rc')
    expect(script).toContain('roll_rc')
  })

  it('a "nincs CI" uzenetet csak SIKERES lekerdezes utan mondja ki', () => {
    // Az uzenetnek explicit ki kell mondania, hogy a lekerdezes sikerult --
    // kulonben megint egy talalgatott ok kerulne a felhasznalo ele.
    expect(script).toContain('SIKERES lekerdezese is nulla futast talalt')
  })

  it('a gh-hiba uzenete NEM allitja, hogy nincs CI', () => {
    expect(script).toContain('Ez NEM azt jelenti, hogy nincs CI')
  })

  it('nem fugg a python3-tol (a node garantalt, a python3 nem)', () => {
    expect(script).not.toContain('python3')
  })

  it('a kulon fajlba emelt, tesztelheto parsert hasznalja', () => {
    expect(existsSync(join(REPO, 'scripts', 'lib', 'ci-verdict.mjs'))).toBe(true)
    expect(script).toContain('ci-verdict.mjs')
  })
})

describe('land-pr.sh: a CI-varas hatarideje nem rovidebb a CI legrosszabb eseténel', () => {
  it('a hatarido lefedi a ci.yml osszes soros timeout-jat', () => {
    const ci = readFileSync(CI_YML, 'utf8')
    const timeouts = [...ci.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1]))
    expect(timeouts.length).toBeGreaterThanOrEqual(2)

    // A `ci-passed` a `test` UTAN fut (needs: [test]), tehat a ket legrosszabb
    // eset OSSZEADODIK -- nem a nagyobbik szamit.
    const worstCaseSeconds = timeouts.reduce((a, b) => a + b, 0) * 60

    const script = readFileSync(LAND_PR, 'utf8')
    const match = script.match(/LAND_PR_CI_WAIT_MAX:-(\d+)/)
    expect(match, 'a land-pr.sh-ban nincs LAND_PR_CI_WAIT_MAX alapertek').not.toBeNull()
    const waitMax = Number(match![1])

    expect(
      waitMax,
      `a CI-varas hatarideje (${waitMax}s) rovidebb a CI legrosszabb esetenel (${worstCaseSeconds}s), ` +
        'tehat egy lassu, de ZOLD CI-t eldobna',
    ).toBeGreaterThanOrEqual(worstCaseSeconds)
  })
})

describe('a landolo szkriptek futtathatoak maradnak', () => {
  // MIERT: egy szkript ujrairasakor (barmilyen szerkesztovel) csendben elveszhet
  // a futtathato bit. A fajl tartalma tokeletes, a `bash -n` zold, a git diff
  // csak "mode change"-et mutat a legaljan -- es a kovetkezo hivas
  // "Permission denied"-dal all meg. Pontosan ez tortent 2026-09-04-en.
  //
  // A git INDEX modjat nezzuk, nem a fajlrendszeret: a Windows-checkout nem
  // orzi a unix jogokat, a git index viszont igen -> host-agnosztikus.
  const SHELL_ENTRYPOINTS = [
    'scripts/land-pr.sh',
    'scripts/agent-worktree.sh',
    'scripts/verify-branch-protection.sh',
    'scripts/deploy-live.sh',
  ]

  /** `git ls-files -s` a repo gyokereben, ORÖKÖLT git-kornyezet NELKUL. */
  function indexModes(): Map<string, string> {
    // A GIT_DIR/GIT_WORK_TREE erosebb a cwd-nel: ha a suite-ot egy hookbol
    // inditjak, ezek egy MASIK repora mutathatnak, es akkor nem azt mernenk,
    // amit hiszunk. Ezert kiszedjuk oket.
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE
    const out = execFileSync('git', ['ls-files', '-s', '--', 'scripts'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    })
    const modes = new Map<string, string>()
    for (const line of out.split('\n')) {
      const m = line.match(/^(\d{6})\s+\S+\s+\d+\t(.+)$/)
      if (m) modes.set(m[2], m[1])
    }
    return modes
  }

  it('a git index tenyleg valaszolt (a nulla itt "nem latok oda" is lehetne)', () => {
    expect(indexModes().size).toBeGreaterThan(5)
  })

  it.each(SHELL_ENTRYPOINTS)('%s futtathato (mode 100755)', (path) => {
    const modes = indexModes()
    expect(modes.has(path), `${path} nincs a git indexben`).toBe(true)
    expect(
      modes.get(path),
      `${path} nem futtathato -- a kovetkezo hivas "Permission denied"-dal all meg`,
    ).toBe('100755')
  })
})

describe('a branch protection allapota MERHETO a repobol', () => {
  // A #8/#9 review-ja azert nem tudta ellenorizni a required check listat, mert
  // a repoban SEMMI nem szolt rola: a `ci-passed` csak a sajat ci.yml-jeben
  // szerepelt. A kapcsolo at volt allitva -- de ezt csak a GitHub tudta, a fa nem.
  const script = join(REPO, 'scripts', 'verify-branch-protection.sh')

  it('van szkript, ami lekerdezi', () => {
    expect(existsSync(script)).toBe(true)
  })

  it('a harom allapotot kulon kezeli, es a hibat nem olvassa "nincs vedelem"-nek', () => {
    const src = readFileSync(script, 'utf8')
    // "nincs vedelem" csak a GitHub explicit valaszara mondhato ki
    expect(src).toContain('Branch not protected')
    // a jogosultsag-/halozati hiba NEM ugyanaz
    expect(src).toContain('nem latok oda')
    // es ezt ki is kell mondania, nem elhallgatnia
    expect(src).toContain('Ez NEM azt jelenti, hogy nincs vedelem')
  })

  it('a ci.yml-ben tenyleg letezik az a job, amit megkovetel', () => {
    const src = readFileSync(script, 'utf8')
    const match = src.match(/REQUIRED_CHECK="([^"]+)"/)
    expect(match, 'a szkriptben nincs REQUIRED_CHECK').not.toBeNull()
    const required = match![1]
    // Ha a szkript egy nem letezo job nevet kovetelne meg, a --apply orokre
    // blokkolo required checket allitana be -- pont az a hiba, amit orizni akar.
    expect(readFileSync(CI_YML, 'utf8')).toContain(`name: ${required}`)
  })
})

describe('ci.yml: a stabil nevu aggregalt kapu megvan', () => {
  const ci = readFileSync(CI_YML, 'utf8')

  // A branch protection required checkje egy FIX nev. Ha a matrix-jobok nevet
  // atirjak, a required check nem szabad hogy elavuljon.
  it('van ci-passed job', () => {
    expect(ci).toMatch(/^\s{2}ci-passed:/m)
  })

  it('a ci-passed akkor is lefut, ha a test bukik (if: always())', () => {
    expect(ci).toContain('if: always()')
  })

  it('a ci-passed a test eredmenyet nezi, nem csak azt, hogy lefutott', () => {
    expect(ci).toContain('needs.test.result')
  })
})
