// Mennyi hely van a Google-fiokon -- MERVE, nem sejtve.
//
// Boss, 2026-09-22: "mellesleg van hely rajtuk. mi az hogy nincs hely?" A
// felulet addig csak annyit allitott, hogy "megtelt a Drive", bizonyitek
// nelkul -- es egy bizonyitek nelkuli allitast joggal nem hisz el senki. A
// tenyleges meres (canadalackor: 16 106 127 360 bajtbol 53 bajt szabad, ebbol
// 898 069 337 bajt a Kukaban) mindket kerdest egy masodperc alatt eldonti:
// tele van-e, es hol lehet helyet felszabaditani.
//
// A mérés ott tortenik, ahol a hiba: a szinkron a kvota-403 pillanataban
// kerdezi le a Drive-tol, es IDE irja. Igy a kepernyo egy offline, gyors
// olvasasbol tud szamot mutatni, es nem a felulet frissitesekor halogat egy
// halozati hivast.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export const DRIVE_QUOTA_PATH = join(PROJECT_ROOT, 'store', 'drive-quota.json')

export interface DriveQuotaSnapshot {
  account: string
  /** Mikor mertuk (ISO). A kepernyo ebbol tudja, hogy nem tegnapi szamot mutat. */
  at: string
  /** A fiok teljes tarhelye bajtban. 0, ha a Google nem mondta meg (korlatlan). */
  limit: number
  /** Az OSSZES foglalt hely bajtban (Drive + Gmail + Fotok). */
  usage: number
  /** Ebbol a Kukaban allo resz bajtban -- ez a leggyorsabban felszabadithato. */
  trash: number
}

type QuotaFile = Record<string, DriveQuotaSnapshot>

/** A feljegyzett meresek fiokonkent. Hiba eseten ures -- a hianyzo szam nem hazugsag. */
export function loadDriveQuotas(path: string = DRIVE_QUOTA_PATH): QuotaFile {
  try {
    if (!existsSync(path)) return {}
    const o = JSON.parse(readFileSync(path, 'utf8'))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: QuotaFile = {}
    for (const [k, v] of Object.entries(o as Record<string, any>)) {
      if (!v || typeof v !== 'object') continue
      out[k] = {
        account: String(v.account || k),
        at: String(v.at || ''),
        limit: Number(v.limit) || 0,
        usage: Number(v.usage) || 0,
        trash: Number(v.trash) || 0,
      }
    }
    return out
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-quota] a tarhely-merest nem tudtam beolvasni')
    return {}
  }
}

/** Egy meres eltevese. Sose dob: a naplozas nem allithatja meg a mentest. */
export function recordDriveQuota(s: DriveQuotaSnapshot, path: string = DRIVE_QUOTA_PATH): void {
  try {
    const all = loadDriveQuotas(path)
    all[s.account] = s
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`)
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-quota] a tarhely-merest nem tudtam kiirni')
  }
}

/**
 * A Google valasza a sajat szavaival: `about?fields=storageQuota`.
 *
 * A `limit` hianyozhat (korlatlan tarhelynel) -- ilyenkor 0, es a kepernyo NEM
 * ir ki hanyadost. A nulla itt is ket dolgot jelenthet, ezert a hivo oldalon a
 * "nincs meresunk" es a "nulla bajt" kulon ag.
 */
export function parseStorageQuota(account: string, body: any, now: Date = new Date()): DriveQuotaSnapshot | null {
  const q = body?.storageQuota
  if (!q || typeof q !== 'object') return null
  const szam = (v: any): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return {
    account,
    at: now.toISOString(),
    limit: szam(q.limit),
    usage: szam(q.usage),
    trash: szam(q.usageInDriveTrash),
  }
}
