// A land-pr.sh ures-rollup diagnosztajanak egysegtesztjei.
//
// MIERT LETEZIK (kanban #257): a land-pr.sh "nincs CI-futas" aga korabban minden
// ures rollupot "GitHub Actions kikapcsolva"-nak diagnosztizalt. De ha a PR
// UTKOZIK (a main moge maradt + azonos fajlok), a GitHub el sem inditja a
// workflow-t -> ugyanaz az ures rollup, csak a valodi ok a rebase-hiany. Ez a
// parser donti el determinisztikusan, gh NELKUL, hogy melyik a harom ok. Ha
// tevesen ACTIONS_OFF-ot mondana egy UNKNOWN/CONFLICT allapotra, a felhasznalot
// rossz iranyba viszi.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyRunDiagnosis, diagnosisFromText } from '../../scripts/lib/empty-run-diagnosis.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(REPO, 'scripts', 'lib', 'empty-run-diagnosis.mjs')

describe('emptyRunDiagnosis -- a nulla futas ket (harom) dolgot jelenthet', () => {
  // CONFLICT: a mergeable VAGY a state barmelyike jelezheti.
  it.each([
    ['CONFLICTING', 'DIRTY'],
    ['CONFLICTING', 'CLEAN'], // a mergeable donti
    ['MERGEABLE', 'DIRTY'], // a state donti
  ])('(%s, %s) -> CONFLICT', (m, s) => {
    expect(emptyRunDiagnosis(m, s)).toBe('CONFLICT')
  })

  // UNKNOWN: a GitHub meg szamol -> NEM vesszuk tiszta-allapotnak.
  it.each([
    ['UNKNOWN', 'UNKNOWN'],
    ['MERGEABLE', 'UNKNOWN'],
    ['UNKNOWN', 'CLEAN'],
  ])('(%s, %s) -> UNKNOWN', (m, s) => {
    expect(emptyRunDiagnosis(m, s)).toBe('UNKNOWN')
  })

  // ACTIONS_OFF: csak tiszta PR + tenyleg nulla futas.
  it.each([
    ['MERGEABLE', 'CLEAN'],
    ['MERGEABLE', 'BLOCKED'], // blocked pl. review-hiany miatt, de nem konfliktus
    ['MERGEABLE', 'BEHIND'], // le van maradva, DE nem DIRTY -> nem konfliktus
  ])('(%s, %s) -> ACTIONS_OFF', (m, s) => {
    expect(emptyRunDiagnosis(m, s)).toBe('ACTIONS_OFF')
  })

  // Hianyzo mezo NEM tiszta-allapot: a "nem latok bele" az UNKNOWN oldalra esik.
  it.each([
    [null, null],
    ['', ''],
    [undefined, undefined],
  ])('hianyzo mezo (%s, %s) -> UNKNOWN, NEM ACTIONS_OFF', (m, s) => {
    expect(emptyRunDiagnosis(m, s)).toBe('UNKNOWN')
  })

  // PRIORITAS: a CONFLICT erosebb az UNKNOWN-nal.
  it('a CONFLICT nyer az UNKNOWN felett: (CONFLICTING, UNKNOWN) -> CONFLICT', () => {
    expect(emptyRunDiagnosis('CONFLICTING', 'UNKNOWN')).toBe('CONFLICT')
  })

  // Kis/nagybetu nem szamit (gh nagybetuvel adja, de vedjuk).
  it('kisbetus bemenet is helyes: (conflicting, dirty) -> CONFLICT', () => {
    expect(emptyRunDiagnosis('conflicting', 'dirty')).toBe('CONFLICT')
  })
})

describe('diagnosisFromText -- gh --json kimenet ertelmezese', () => {
  it('az ures bemenet UNKNOWN (varunk), NEM hiba', () => {
    expect(diagnosisFromText('')).toEqual({ ok: true, diagnosis: 'UNKNOWN' })
  })

  it('a "null" (a --jq igy irja ki a hianyzo mezot) UNKNOWN', () => {
    expect(diagnosisFromText('null')).toEqual({ ok: true, diagnosis: 'UNKNOWN' })
  })

  it('utkozo PR objektum -> CONFLICT', () => {
    expect(diagnosisFromText('{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}'))
      .toEqual({ ok: true, diagnosis: 'CONFLICT' })
  })

  it('tiszta PR objektum -> ACTIONS_OFF', () => {
    expect(diagnosisFromText('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'))
      .toEqual({ ok: true, diagnosis: 'ACTIONS_OFF' })
  })

  // A LENYEG: hianyzo mezok esetben UNKNOWN, SOHA nem ACTIONS_OFF.
  it('ures objektum {} -> UNKNOWN (NEM ACTIONS_OFF!)', () => {
    expect(diagnosisFromText('{}')).toEqual({ ok: true, diagnosis: 'UNKNOWN' })
  })

  it('az ervenytelen JSON HIBA, nem diagnozis', () => {
    const r = diagnosisFromText('{ ez nem json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('nem ervenyes JSON')
  })

  it.each([
    ['tomb', '["a","b"]'],
    ['string', '"CONFLICTING"'],
  ])('a nem-objektum (%s) HIBA', (_label, text) => {
    const r = diagnosisFromText(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('nem objektum')
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

  it('utkozo PR-re CONFLICT-ot ir es 0-val lep ki', () => {
    const out = runCli('{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}')
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('CONFLICT')
  })

  it('tiszta PR-re ACTIONS_OFF-ot ir', () => {
    const out = runCli('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}')
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('ACTIONS_OFF')
  })

  it('ures bemenetre UNKNOWN-t ir (varunk, nem hiba)', () => {
    const out = runCli('')
    expect(out.code).toBe(0)
    expect(out.stdout).toBe('UNKNOWN')
  })

  // A hivo (land-pr.sh) a kilepokodon kulonbozteti meg a diagnozist a hibatol.
  it('romlott bemenetre 2-vel lep ki es NEM ir diagnozist', () => {
    const out = runCli('nem json')
    expect(out.code).toBe(2)
    expect(['CONFLICT', 'UNKNOWN', 'ACTIONS_OFF']).not.toContain(out.stdout)
    expect(out.stderr).toContain('ertelmezhetetlen')
  })
})
