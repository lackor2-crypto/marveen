#!/usr/bin/env node
// ci-verdict.mjs -- a GitHub `statusCheckRollup` tomb egyetlen verdiktte forditasa.
//
// MIERT KULON FAJL (2026-09-04):
// Ez a logika korabban a land-pr.sh-ba volt beagyazva egy `python3 -c '...'`
// heredocban. Ket baja volt ennek:
//
//   1. TESZTELHETETLEN. A #8 commit uzenete azt allitotta, hogy "a CI-parser 16
//      egysegteszttel (CheckRun + StatusContext + kevert) zold" -- a fabaan
//      viszont a 435 tesztfajl kozul EGY sem erintette. A tesztek eldobhatoak
//      voltak, a commit megis tartos bizonyitekkent hivatkozott rajuk. Ez pont a
//      "a 'sikeresen lefutott' NEM bizonyitek" szabaly esete: a parser azota
//      barmikor elromolhatott volna, es semmi nem szolt volna.
//   2. FOLOSLEGES python3-FUGGOSEG. A repo Node-projekt: a `node` biztosan ott
//      van (a `npm ci` nelkul a land-pr amugy sem mukodne), a `python3` viszont
//      nem garantalt egy friss telepitesen. Egy hianyzo python3 a regi kodban
//      NEM hibauzenetet adott, hanem a `|| echo EMPTY` miatt csendben "EMPTY"
//      verdiktet -- vagyis a hianyzo ertelmezot "nincs meg egy check sem"-nek
//      olvasta. A nulla ket dolgot jelenthet; ez a valtozat kulon tudja oket.
//
// Hasznalat parancssorbol (a land-pr.sh igy hivja):
//   printf '%s' "$rollup_json" | node scripts/lib/ci-verdict.mjs
// Kimenet a stdout-on PONTOSAN egy szo: EMPTY | PENDING | PASS | FAIL
// Ertelmezhetetlen bemenetnel: stderr-re indoklas, kilepokod 2 (NEM "EMPTY").

/** A lehetseges verdiktek. */
export const VERDICTS = /** @type {const} */ (['EMPTY', 'PENDING', 'PASS', 'FAIL'])

// Egy BEFEJEZETT CheckRun ezekkel a conclusion-okkel szamit zoldnek. A NEUTRAL
// es a SKIPPED szandekosan zold: egy `if:`-fel kihagyott job nem bukas. Minden
// mas befejezett allapot (FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED,
// STARTUP_FAILURE, STALE es a null conclusion) bukas.
const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

// Klasszikus commit-status (StatusContext) allapotok, amik meg nem dontottek el.
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : '')

/**
 * Egyetlen rollup-elem besorolasa.
 *
 * A rollup KETFELE tipust kever, es ezt a kettot a mezoik alapjan kell
 * szetvalasztani:
 *   - StatusContext (klasszikus commit-status, pl. kulso CI): van `state`.
 *   - CheckRun (GitHub Actions): van `status` + `conclusion`, `state` nincs.
 *
 * @param {unknown} check
 * @returns {'ok'|'pending'|'fail'}
 */
export function classifyCheck(check) {
  // Ismeretlen/hibas elem: NEM tekintjuk zoldnek. A "nem tudom, mi ez" sosem
  // eshet a "rendben van" oldalra -- inkabb varunk ra (a hatarido ugyis lejar).
  if (check === null || typeof check !== 'object') return 'pending'

  const state = upper(/** @type {any} */ (check).state)
  if (state) {
    if (state === 'SUCCESS') return 'ok'
    if (PENDING_STATES.has(state)) return 'pending'
    return 'fail' // ERROR / FAILURE
  }

  const status = upper(/** @type {any} */ (check).status)
  const conclusion = upper(/** @type {any} */ (check).conclusion)
  if (status !== 'COMPLETED') return 'pending' // QUEUED / IN_PROGRESS / WAITING / ''
  return OK_CONCLUSIONS.has(conclusion) ? 'ok' : 'fail'
}

/**
 * A teljes rollup verdiktje.
 *
 * Prioritas: barmelyik bukas -> FAIL; egyebkent barmelyik fuggoben -> PENDING;
 * egyebkent PASS. Ures tomb -> EMPTY (a hivo dolga eldonteni, hogy ez "meg nem
 * regisztralt" vagy "nincs is CI").
 *
 * @param {unknown} rollup
 * @returns {'EMPTY'|'PENDING'|'PASS'|'FAIL'}
 */
export function ciVerdict(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'EMPTY'
  let pending = 0
  let failed = 0
  for (const check of rollup) {
    const cls = classifyCheck(check)
    if (cls === 'fail') failed++
    else if (cls === 'pending') pending++
  }
  if (failed > 0) return 'FAIL'
  return pending > 0 ? 'PENDING' : 'PASS'
}

/**
 * Nyers szoveg -> verdikt. A `gh ... --jq '.statusCheckRollup'` `null`-t ir ki,
 * ha a mezo hianyzik, es ures stringet, ha maga a hivas nem adott semmit; ezek
 * mind EMPTY-t jelentenek, de a SZINTAKTIKAILAG HIBAS bemenet nem -- az hiba.
 *
 * @param {string} text
 * @returns {{ok: true, verdict: 'EMPTY'|'PENDING'|'PASS'|'FAIL'} | {ok: false, error: string}}
 */
export function verdictFromText(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '' || trimmed === 'null') return { ok: true, verdict: 'EMPTY' }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, error: `a bemenet nem ervenyes JSON: ${/** @type {Error} */ (err).message}` }
  }
  if (parsed === null) return { ok: true, verdict: 'EMPTY' }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `a bemenet nem tomb, hanem ${typeof parsed} -- vart: statusCheckRollup tomb` }
  }
  return { ok: true, verdict: ciVerdict(parsed) }
}

// --- CLI ---------------------------------------------------------------------
// Csak akkor fut, ha kozvetlenul indititottak (import eseten nem).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    input += chunk
  })
  process.stdin.on('end', () => {
    const result = verdictFromText(input)
    if (!result.ok) {
      // NEM "EMPTY"-t irunk: a hivonak tudnia kell, hogy ez HIBA, nem uresseg.
      process.stderr.write(`ci-verdict: ertelmezhetetlen statusCheckRollup -- ${result.error}\n`)
      process.exit(2)
    }
    process.stdout.write(`${result.verdict}\n`)
  })
}
