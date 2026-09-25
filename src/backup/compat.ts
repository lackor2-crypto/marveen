/**
 * Can this Marveen restore that backup? (#396 Phase 4, plan §2 Gitea/Forgejo:
 * restore with the same version that made the dump, or a newer one.)
 *
 *   format newer than we know      -> refuse (update Marveen first)
 *   backup made by a NEWER Marveen -> refuse (the old code cannot know its columns)
 *   backup made by an older one    -> allowed; the normal idempotent migrations in
 *                                     src/db.ts bring the DB up on the next start
 */
import { MANIFEST_FORMAT } from './create.js'

export interface CompatResult {
  ok: boolean
  reason?: 'backup_newer' | 'format_unknown'
  needsMigration: boolean
}

/** -1 / 0 / 1 for dotted numeric versions; non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export function checkCompat(
  manifest: { format?: number; appVersion?: string; db?: { schemaFingerprint?: string } | null },
  currentVersion: string,
  currentFingerprint: string | null,
): CompatResult {
  if (typeof manifest.format !== 'number' || manifest.format > MANIFEST_FORMAT) {
    return { ok: false, reason: 'format_unknown', needsMigration: false }
  }
  if (compareVersions(manifest.appVersion ?? '0', currentVersion) > 0) {
    return { ok: false, reason: 'backup_newer', needsMigration: false }
  }
  const same = compareVersions(manifest.appVersion ?? '0', currentVersion) === 0
  const fpSame = !!currentFingerprint && manifest.db?.schemaFingerprint === currentFingerprint
  return { ok: true, needsMigration: !(same && fpSame) }
}
