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
import {
  groupCommits, fileCounts,
  type UpstreamCommit, type ChangeKind, type UpstreamFile,
} from '../upstream-changelog.js'

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
  /** A másik nézet: melyik fájl változott, és melyik commitok nyúltak hozzá.
   *  Üres tömb, ha a listát még a fájl-nézet előtti írás készítette. */
  files: UpstreamFile[]
  fileCounts: { total: number; conflict: number; clean: number }
}

export function readUpstreamChanges(now: number = Date.now()): UpstreamChangesView | null {
  if (!existsSync(CHANGES_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CHANGES_PATH, 'utf-8')) as Record<string, unknown>
    // Csak azt számoljuk bele, amit meg is tudunk mutatni: egy romlott elem
    // (null, szám, string) ne vigye magával az egész listát, és a fejléc száma
    // se mondhasson többet, mint ahány sor lesz alatta.
    const nyers = Array.isArray(raw.commits) ? (raw.commits as unknown[]) : []
    const commits = nyers.filter((c): c is UpstreamCommit => !!c && typeof c === 'object')
    if (commits.length === 0) return null
    const groups = groupCommits(commits)
    // Egy regebbi iras meg nem tartalmazza a fajl-nezetet. Ilyenkor ures lista
    // megy ki, nem hiba: a valtozas-nezet ettol meg teljes, es a felulet ki
    // tudja irni, hogy ez a resz a kovetkezo frissiteskor keszul el.
    const files = Array.isArray(raw.files) ? (raw.files as UpstreamFile[]) : []
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
      files,
      fileCounts: fileCounts(files),
    }
  } catch {
    return null
  }
}
