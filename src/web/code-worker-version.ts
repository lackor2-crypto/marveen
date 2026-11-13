import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

/** A Windows-oldali szkript a SAJAT gepen fut, egy MASOLATBAN
 *  (`%USERPROFILE%\\marvin-code-worker\\`). Amit a repoban javitunk, az ott csak
 *  akkor van meg, ha valaki atmasolta -- es eddig semmi nem szolt, ha nem.
 *  Egy elavult peldany nem hibauzenettel bukik meg, hanem NEMAN regi adatot
 *  kuld (2026-08-23: a rossz beszelgetes-cimeket pontosan ez okozta).
 *
 *  Ezert jelenti a worker a sajat verziojat, es ezert olvassuk ki a VARTAT
 *  ugyanabbol a fajlbol, amit a felulet letoltesre kinal -- igy a ketto nem
 *  tud szetcsuszni.
 *
 *  A visszateres `null` = NEM LATUNK ODA (nincs meg a szkript, vagy nincs
 *  benne verziojeloles). Ez mas, mint a "regi verzio", es a hivo oldalon is
 *  kulon agon kell kezelni. */
let memo: { at: number; value: string | null } | null = null
/** The script only changes with a deploy, which restarts the server: a worker polls every few
 *  seconds, and reading the file for each poll held the thread whenever the disk was busy (#897). */
const MEMO_MS = 60_000
export function _resetExpectedWorkerVersionForTest(): void { memo = null }

export function expectedWorkerVersion(now = Date.now()): string | null {
  if (memo && now - memo.at < MEMO_MS && now >= memo.at) return memo.value
  let value: string | null = null
  try {
    const text = readFileSync(join(PROJECT_ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
    const m = /\$script:WorkerVersion\s*=\s*'([^']{1,40})'/.exec(text)
    value = m && m[1] ? m[1] : null
  } catch {
    value = null
  }
  memo = { at: now, value }
  return value
}
