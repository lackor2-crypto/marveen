#!/usr/bin/env node
// empty-run-diagnosis.mjs -- ha a PR rollupja URES es nulla CI-futas van, ez
// donti el, MIERT: CONFLICT (utkozo PR, a workflow el sem indul), UNKNOWN (a
// GitHub meg szamolja a mergeable-t), vagy ACTIONS_OFF (tiszta PR, tenyleg
// nincs Actions). Kulon fajl + export, hogy gh nelkul, truth-table-lel
// tesztelheto legyen -- pontosan a ci-verdict.mjs mintajara.
//
// Hasznalat: gh pr view <url> -R <repo> --json mergeable,mergeStateStatus \
//   | node scripts/lib/empty-run-diagnosis.mjs
// Kimenet PONTOSAN egy szo: CONFLICT | UNKNOWN | ACTIONS_OFF
// Ertelmezhetetlen bemenet: stderr + kilepokod 2 (NEM diagnozis).

export const DIAGNOSES = /** @type {const} */ (['CONFLICT', 'UNKNOWN', 'ACTIONS_OFF'])

const upper = (v) => (typeof v === 'string' ? v.toUpperCase() : '')

/**
 * @param {unknown} mergeable        gh: MERGEABLE | CONFLICTING | UNKNOWN
 * @param {unknown} mergeStateStatus gh: CLEAN|DIRTY|BEHIND|BLOCKED|UNKNOWN|...
 * @returns {'CONFLICT'|'UNKNOWN'|'ACTIONS_OFF'}
 */
export function emptyRunDiagnosis(mergeable, mergeStateStatus) {
  const m = upper(mergeable) || 'UNKNOWN'
  const s = upper(mergeStateStatus) || 'UNKNOWN'
  if (m === 'CONFLICTING' || s === 'DIRTY') return 'CONFLICT'
  if (m === 'UNKNOWN' || s === 'UNKNOWN') return 'UNKNOWN'
  return 'ACTIONS_OFF'
}

/**
 * @param {string} text  a `gh pr view --json mergeable,mergeStateStatus` objektuma
 * @returns {{ok:true,diagnosis:'CONFLICT'|'UNKNOWN'|'ACTIONS_OFF'}|{ok:false,error:string}}
 */
export function diagnosisFromText(text) {
  const trimmed = String(text ?? '').trim()
  // Ures/nincs info -> UNKNOWN (varunk), NEM hiba: a "nem latok bele" sosem
  // eshet a "tiszta -> Actions kikapcsolva" oldalra.
  if (trimmed === '' || trimmed === 'null') return { ok: true, diagnosis: 'UNKNOWN' }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, error: `a bemenet nem ervenyes JSON: ${/** @type {Error} */ (err).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'a bemenet nem objektum -- vart: {mergeable, mergeStateStatus}' }
  }
  return { ok: true, diagnosis: emptyRunDiagnosis(parsed.mergeable, parsed.mergeStateStatus) }
}

// --- CLI (csak kozvetlen inditasnal) ---
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { input += c })
  process.stdin.on('end', () => {
    const r = diagnosisFromText(input)
    if (!r.ok) {
      process.stderr.write(`empty-run-diagnosis: ertelmezhetetlen bemenet -- ${r.error}\n`)
      process.exit(2)
    }
    process.stdout.write(`${r.diagnosis}\n`)
  })
}
