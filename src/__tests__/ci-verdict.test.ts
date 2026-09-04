// A land-pr.sh CI-verdikt parserenek egysegtesztjei.
//
// MIERT LETEZIK EZ A FAJL (2026-09-04):
// A #8 commit (a9a75ff) uzenete azt allitotta: "a CI-parser 16 egysegteszttel
// (CheckRun + StatusContext + kevert) zold". A fabaan viszont a 435 tesztfajl
// kozul EGY sem hivatkozott ra: a parser egy bash-heredocba agyazott
// `python3 -c` volt, amit a vitest el sem er. A tesztek eldobhatoak voltak, a
// commit megis tartos bizonyitekkent hivatkozott rajuk -- pontosan az a
// helyzet, amit a "'sikeresen lefutott' NEM bizonyitek" szabaly tilt.
//
// A parser az egyetlen dolog, ami eldonti, hogy egy PR merge-elheto-e. Ha
// tevesen PASS-t mond, egy PIROS CI-vel rendelkezo commit kerul a main-re. Ez a
// fajl az, ami ezt megbuktatja.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ciVerdict, classifyCheck, verdictFromText } from '../../scripts/lib/ci-verdict.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(REPO, 'scripts', 'lib', 'ci-verdict.mjs')

/** GitHub Actions job (CheckRun). */
const run = (status: string, conclusion: string | null = null) => ({
  __typename: 'CheckRun',
  name: 'Node 22',
  status,
  conclusion,
})

/** Klasszikus commit-status (StatusContext). */
const ctx = (state: string) => ({ __typename: 'StatusContext', context: 'kulso/ci', state })

describe('classifyCheck -- CheckRun (GitHub Actions)', () => {
  it('a COMPLETED + SUCCESS zold', () => {
    expect(classifyCheck(run('COMPLETED', 'SUCCESS'))).toBe('ok')
  })

  // A NEUTRAL es a SKIPPED szandekosan zold: egy `if:`-fel kihagyott job nem bukas.
  it.each(['NEUTRAL', 'SKIPPED'])('a COMPLETED + %s zold (kihagyott job nem bukas)', (conclusion) => {
    expect(classifyCheck(run('COMPLETED', conclusion))).toBe('ok')
  })

  // Ez a lenyeg: MINDEN mas befejezett allapot bukas. Ha barmelyik ide be tudna
  // csuszni "ok"-kent, egy piros CI merge-elodne.
  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])(
    'a COMPLETED + %s BUKAS',
    (conclusion) => {
      expect(classifyCheck(run('COMPLETED', conclusion))).toBe('fail')
    },
  )

  it('a COMPLETED + null conclusion BUKAS (nem tekintjuk zoldnek)', () => {
    expect(classifyCheck(run('COMPLETED', null))).toBe('fail')
  })

  it.each(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'])(
    'a %s statusz fuggoben van',
    (status) => {
      expect(classifyCheck(run(status))).toBe('pending')
    },
  )
})

describe('classifyCheck -- StatusContext (klasszikus commit-status)', () => {
  it('a SUCCESS state zold', () => {
    expect(classifyCheck(ctx('SUCCESS'))).toBe('ok')
  })

  it.each(['PENDING', 'EXPECTED'])('a %s state fuggoben van', (state) => {
    expect(classifyCheck(ctx(state))).toBe('pending')
  })

  it.each(['ERROR', 'FAILURE'])('a %s state BUKAS', (state) => {
    expect(classifyCheck(ctx(state))).toBe('fail')
  })

  // Regresszio: a `state` mezo letezese donti el a tipust. Ha egy StatusContext
  // "status"-alapunak nezne, minden klasszikus check OROKRE pending lenne.
  it('az ures state atengedi a vezerlest a CheckRun-agnak', () => {
    expect(classifyCheck({ state: '', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('ok')
  })
})

describe('classifyCheck -- ismeretlen alak', () => {
  // "Nem tudom, mi ez" SOSEM eshet a zold oldalra: inkabb varunk ra, es a
  // hatarido lejartakor emberi uzenetet kap a felhasznalo.
  it.each([
    ['se state, se status', { __typename: 'Valami', name: 'x' }],
    ['null elem', null],
    ['string elem', 'COMPLETED'],
    ['szam elem', 7],
  ])('a(z) %s NEM zold, hanem fuggo', (_label, value) => {
    expect(classifyCheck(value)).toBe('pending')
  })
})

describe('ciVerdict -- osszesites', () => {
  it('az ures tomb EMPTY', () => {
    expect(ciVerdict([])).toBe('EMPTY')
  })

  it('a nem-tomb EMPTY', () => {
    expect(ciVerdict(null)).toBe('EMPTY')
  })

  it('csupa zold -> PASS', () => {
    expect(ciVerdict([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SUCCESS')])).toBe('PASS')
  })

  it('zold + fuggo -> PENDING', () => {
    expect(ciVerdict([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')])).toBe('PENDING')
  })

  it('zold CheckRun + fuggo StatusContext -> PENDING (kevert tipusok)', () => {
    expect(ciVerdict([run('COMPLETED', 'SUCCESS'), ctx('PENDING')])).toBe('PENDING')
  })

  // A bukas ERSEBB a fuggonel: nem varunk vegig egy mar biztosan piros CI-re.
  it('bukott + fuggo -> FAIL (a bukas nyer)', () => {
    expect(ciVerdict([run('COMPLETED', 'FAILURE'), run('IN_PROGRESS')])).toBe('FAIL')
  })

  it('bukott + zold -> FAIL', () => {
    expect(ciVerdict([run('COMPLETED', 'SUCCESS'), ctx('ERROR')])).toBe('FAIL')
  })

  it('csak SKIPPED -> PASS', () => {
    expect(ciVerdict([run('COMPLETED', 'SKIPPED')])).toBe('PASS')
  })

  // Ez a repo valodi alakja: a ci.yml ket matrix-jobja + a ci-passed kapu + a
  // secret-gate.yml scan-je. Ez a negy check fut minden PR-en.
  it('a repo valodi negy checkje zolden PASS', () => {
    const rollup = [
      { __typename: 'CheckRun', name: 'Node 20.19', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'Node 22', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'Kulcs-minta ellenorzes a valtozott sorokban', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'ci-passed', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ]
    expect(ciVerdict(rollup)).toBe('PASS')
  })

  it('ha a ci-passed bukik, a tobbi zold sem ment meg', () => {
    const rollup = [
      { __typename: 'CheckRun', name: 'Node 20.19', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'ci-passed', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]
    expect(ciVerdict(rollup)).toBe('FAIL')
  })
})

describe('verdictFromText -- a nulla ket dolgot jelenthet', () => {
  it('az ures bemenet EMPTY', () => {
    expect(verdictFromText('')).toEqual({ ok: true, verdict: 'EMPTY' })
  })

  it('a "null" (a --jq igy irja ki a hianyzo mezot) EMPTY', () => {
    expect(verdictFromText('null')).toEqual({ ok: true, verdict: 'EMPTY' })
  })

  it('az ures JSON-tomb EMPTY', () => {
    expect(verdictFromText('[]')).toEqual({ ok: true, verdict: 'EMPTY' })
  })

  // A LENYEG: a romlott bemenet HIBA, nem uresseg. A regi kod `|| echo EMPTY`-vel
  // nyelte el -- vagyis egy csonka valasz, egy hianyzo ertelmezo vagy egy
  // gh-hibauzenet mind "nincs meg egy check sem"-nek latszott.
  it('az ervenytelen JSON HIBA, nem EMPTY', () => {
    const result = verdictFromText('{ ez nem json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nem ervenyes JSON')
  })

  it('a gh hibauzenete HIBA, nem EMPTY', () => {
    const result = verdictFromText('error connecting to api.github.com')
    expect(result.ok).toBe(false)
  })

  it('a nem-tomb JSON HIBA, nem EMPTY', () => {
    const result = verdictFromText('{"message":"Not Found"}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('nem tomb')
  })
})

describe('CLI -- ahogy a land-pr.sh hivja', () => {
  const runCli = (input: string) => {
    try {
      const stdout = execFileSync('node', [CLI], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      return { code: 0, stdout: stdout.trim(), stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? -1, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() }
    }
  }

  it('zold rollupra PASS-t ir es 0-val lep ki', () => {
    const out = runCli(JSON.stringify([run('COMPLETED', 'SUCCESS')]))
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('PASS')
  })

  it('ures rollupra EMPTY-t ir es 0-val lep ki', () => {
    const out = runCli('[]')
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('EMPTY')
  })

  it('piros rollupra FAIL-t ir', () => {
    const out = runCli(JSON.stringify([run('COMPLETED', 'FAILURE')]))
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('FAIL')
  })

  // A hivo (land-pr.sh) ezen a kilepokodon kulonbozteti meg a "nincs check"-et a
  // "nem tudtam megnezni"-tol. Ha ez 0 lenne EMPTY-vel, visszajonne a regi bug.
  it('romlott bemenetre 2-vel lep ki es NEM ir EMPTY-t', () => {
    const out = runCli('nem json')
    expect(out.code).toBe(2)
    expect(out.stdout).not.toBe('EMPTY')
    expect(out.stderr).toContain('ertelmezhetetlen')
  })
})
