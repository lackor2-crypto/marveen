/**
 * A "Mi változott az upstreamben?" lista beolvasása a dashboardnak.
 *
 * A fájlt a scripts/upstream-changelog.ts írja (git + egyszeri fordítás,
 * sha-ra gyorsítótárazva). Itt csak olvasunk: se git, se hálózat, se modell --
 * az Áttekintés betöltése nem várhat egy külső hívásra.
 *
 * Ugyanaz a szabály, mint az upstream-sync-status-io.ts-nél: a lista mellett
 * mindig ott a KORA és az, hogy MIHEZ KÉPEST készült. Egy dátumtalan lista a
 * kilencedik napon is ugyanolyan hitelesnek látszik, mint az elsőn -- ez volt
 * az eredeti hiba, és nem ismételjük meg egy másik fájllal.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { ageInDays } from './upstream-sync-status-io.js'
import { groupCommits, type UpstreamCommit, type ChangeKind } from '../upstream-changelog.js'

const CHANGES_PATH = join(PROJECT_ROOT, 'store', 'upstream-changes.json')

export interface UpstreamChangesView {
  generatedAt: string | null
  ageDays: number | null
  localRef: string | null
  upstreamRef: string | null
  total: number
  /** Hány tételhez nincs még magyar szöveg (fordítás nélkül is teljes a lista). */
  missingSummaries: number
  groups: Record<ChangeKind, UpstreamCommit[]>
  counts: Record<ChangeKind, number>
}

export function readUpstreamChanges(now: number = Date.now()): UpstreamChangesView | null {
  if (!existsSync(CHANGES_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CHANGES_PATH, 'utf-8')) as Record<string, unknown>
    const commits = Array.isArray(raw.commits) ? (raw.commits as UpstreamCommit[]) : []
    if (commits.length === 0) return null
    const groups = groupCommits(commits)
    const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : null
    return {
      generatedAt,
      ageDays: ageInDays(generatedAt, now),
      localRef: typeof raw.localRef === 'string' ? raw.localRef : null,
      upstreamRef: typeof raw.upstreamRef === 'string' ? raw.upstreamRef : null,
      total: commits.length,
      missingSummaries: commits.filter(c => !c.hu).length,
      groups,
      counts: {
        javitas: groups.javitas.length,
        fejlesztes: groups.fejlesztes.length,
        egyeb: groups.egyeb.length,
      },
    }
  } catch {
    return null
  }
}
