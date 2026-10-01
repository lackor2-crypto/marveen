// WINDOWS-HIVATKOZAS A BEKOTESEKHEZ: a Windows Intezo is lassa a bekotott repot.
//
// A bekotes (life-mounts.ts) csak Marveen fejeben letezik: a fa egy pontja
// "mutat" egy masik helyre. A Windows Intezo ezt nem ismeri, ezert a projekt
// alatt (pl. Tozsde/Fejlesztes/GIT_REPOS) ures mappat lat, a repo viszont
// ott van a raktar `Rendszer/Tarolok/Git` aga alatt (Boss, 2026-10-01).
//
// Megoldas: a bekotes helyen egy valodi Windows-junction all a cel fele.
// A junction nem masolat, nem kell hozzajuk jogosultsag, mindket oldalrol
// (Windows es WSL) ugyanazt a mappat mutatja, a git a repo VALODI helyen marad.
//
// Szandekosan SZUK:
//   - csak `git` bekotesre (a Drive/Fotok walkerek ketszer jarnak be egy linket),
//   - csak ha a raktar Windows-meghajton all (`/mnt/<betu>/...`) -- ott van mit lathatni,
//   - csak uj helyre vagy ures mappa helyere; tartalmas mappat soha nem csere,
//   - ha a bekotes szulo/gyereke egy masik bekotesnek, kihagyjuk (a link
//     belsejebe irnank a cel mappaba),
//   - a link torlese csak a hivatkozast viszi el, a repo a helyen marad.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { depotRoot } from './depot.js'
import { isWsl } from './web/scheduled-tasks-io.js'
import { logger } from './logger.js'
import type { LifeMount } from './life-mounts.js'

const CMD_EXE = '/mnt/c/Windows/System32/cmd.exe'

export type LinkOutcome = 'created' | 'present' | 'removed' | 'skipped'
export interface LinkResult { rel: string; outcome: LinkOutcome; reason?: string }

/** `/mnt/f/Marveen/x` -> `F:\Marveen\x`; null, ha nem Windows-meghajto. */
export function toWindowsDrivePath(abs: string): string | null {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(abs)
  if (!m) return null
  return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`
}

function linksSupported(root: string): boolean {
  return isWsl() && existsSync(CMD_EXE) && toWindowsDrivePath(root) !== null
}

function lst(p: string) { try { return lstatSync(p) } catch { return null } }

/** A link helye alatt nincs-e mar egy link az utvonal egy szulojen (akkor a cel mappaba irnank). */
function ancestorIsLink(root: string, rel: string): boolean {
  const parts = rel.split('/')
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i])
    const st = lst(cur)
    if (st && st.isSymbolicLink()) return true
  }
  return false
}

function overlaps(m: LifeMount, all: LifeMount[]): boolean {
  return all.some((o) => o.rel !== m.rel && (o.rel.startsWith(m.rel + '/') || m.rel.startsWith(o.rel + '/')))
}

function sameTarget(link: string, target: string): boolean {
  try { return realpathSync(link) === realpathSync(target) } catch { return false }
}

/** Egy bekotes hivatkozasanak letrehozasa (ha kell es lehet). Sosem dob. */
export function ensureMountLink(m: LifeMount, all: LifeMount[]): LinkResult {
  const skip = (reason: string): LinkResult => ({ rel: m.rel, outcome: 'skipped', reason })
  try {
    if (m.kind !== 'git') return skip('not_git')
    const root = depotRoot()
    if (!root || !linksSupported(root)) return skip('unsupported')
    if (overlaps(m, all)) return skip('nested_mount')
    const link = join(root, ...m.rel.split('/'))
    const target = join(root, ...m.target.split('/'))
    const tst = lst(target)
    if (!tst || !tst.isDirectory()) return skip('target_missing')
    if (ancestorIsLink(root, m.rel)) return skip('inside_link')

    const st = lst(link)
    if (st) {
      if (st.isSymbolicLink()) return sameTarget(link, target) ? { rel: m.rel, outcome: 'present' } : skip('link_elsewhere')
      if (!st.isDirectory()) return skip('occupied')
      if (readdirSync(link).length > 0) return skip('not_empty')
      rmdirSync(link)
    } else {
      mkdirSync(dirname(link), { recursive: true })
    }
    const r = spawnSync(CMD_EXE, ['/c', 'mklink', '/J', toWindowsDrivePath(link) as string, toWindowsDrivePath(target) as string], { cwd: '/mnt/c', encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) {
      // Az ures mappa, amit kivettunk, kerüljön vissza: egy rossz link jobb ne legyen, mint a hianyzo mappa.
      try { if (!lst(link)) mkdirSync(link, { recursive: true }) } catch { /* nincs mit tenni */ }
      return skip(`mklink_failed:${r.status}`)
    }
    logger.info({ rel: m.rel }, '[eletfa] Windows-hivatkozas letrehozva a bekoteshez')
    return { rel: m.rel, outcome: 'created' }
  } catch (err: any) {
    logger.warn({ rel: m.rel, err: err?.message }, '[eletfa] a Windows-hivatkozas nem sikerult')
    return skip('error')
  }
}

/** A bekotes megszunesekor a hivatkozas is tunjon el -- a repo marad. */
export function removeMountLink(m: LifeMount): LinkResult {
  try {
    const root = depotRoot()
    if (!root || m.kind !== 'git') return { rel: m.rel, outcome: 'skipped', reason: 'n/a' }
    const link = join(root, ...m.rel.split('/'))
    const target = join(root, ...m.target.split('/'))
    const st = lst(link)
    if (!st || !st.isSymbolicLink()) return { rel: m.rel, outcome: 'skipped', reason: 'no_link' }
    // Csak a SAJAT hivatkozasunkat visszuk el: ha mashova mutat, nem mienk.
    if (!sameTarget(link, target) && readlinkSync(link) !== target) return { rel: m.rel, outcome: 'skipped', reason: 'foreign_link' }
    unlinkSync(link)
    return { rel: m.rel, outcome: 'removed' }
  } catch (err: any) {
    logger.warn({ rel: m.rel, err: err?.message }, '[eletfa] a Windows-hivatkozas torlese nem sikerult')
    return { rel: m.rel, outcome: 'skipped', reason: 'error' }
  }
}

/** Indulaskor: minden meglevo git-bekotes hivatkozasa meglegyen (friss es regi telepiteseken is). */
export function reconcileMountLinks(all: LifeMount[]): LinkResult[] {
  return all.filter((m) => m.kind === 'git').map((m) => ensureMountLink(m, all))
}
