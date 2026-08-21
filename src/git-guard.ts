/**
 * GIT-OR: mit szabad az Intezoben egy git-repoval csinalni.
 *
 * Boss, 2026-08-21: "talan az hogy atmozgassa valaki vagy torolje, szerkessze
 * azt lehet le kellene tiltani. nem? vagy neha lesz ra szukseg ... hiszen
 * ezeket csak olvasni kell. a gitrol lehuzott filek ezek."
 *
 * Harom kulon eset van, es mind a haromra mas a helyes valasz:
 *
 *  1. A repon BELULI fajlok (`GIT_REPOS/<repo>/src/valami.ts`) -- TILTVA.
 *     Aki itt kezzel atnevez vagy athelyez, az a git szemeben torlest es egy
 *     ismeretlen uj fajlt csinal: a kovetkezo `pull` vagy visszasirja, vagy
 *     csendben eldobja. Marveenbol erre soha nincs szukseg -- a helyes ut a
 *     szerkeszto -> commit -> push. NEMAN viszont soha nem tiltunk: az uzenet
 *     megmondja, mit tegyen helyette.
 *
 *  2. Maga a repo-mappa torlese -- SZABAD, de merunk elotte. Egy klon
 *     eldobhato es ujra lehuzhato; a veszely nem a torles, hanem a benne levo
 *     EL NEM KULDOTT munka. Ezert nem tiltunk, hanem megnezzuk (`git status`,
 *     hany commit van a tavoli elott), es emberi mondatban kimondjuk.
 *
 *  3. A bekotes megszuntetese -- szabad, es ez az ELSO ajanlat. Semmit nem
 *     torol, csak eltunik a fabol.
 *
 * Amit SZANDEKOSAN nem csinalunk: teljes irasvedelem az egesz `GIT_REPOS`
 * agra. Egyreszt a friss telepitesnek is a feluletrol kell mukodnie -- ha a
 * repo sehogy nem takarithato, terminal kell hozza. Masreszt a globalis tiltas
 * keruloutra kenyszerit (Intezo helyett Windows Intezo), ahol mar SEMMILYEN
 * figyelmeztetes nincs. Jobb bent tartani az embert, es a veszelyes
 * pillanatban merni.
 */

import { execFile } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { explorerRoot, resolveLifePath, toLifeRel } from './life-explorer.js'
import { listMounts, removeMount } from './life-mounts.js'
import { logger } from './logger.js'

/** A `GIT_REPOS` mappa neve. Nem forditodik -- lasd `life-tree.ts`. */
export const GIT_REPOS_DIR = 'GIT_REPOS'

/** Egy megtalalt repo: hol all a munkapeldany gyokere. */
export interface RepoAt {
  /** A repo gyokerenek abszolut utvonala. */
  abs: string
  /** Ugyanaz a fan belul. */
  rel: string
  /** Maga a vizsgalt tetel A REPO GYOKERE-e (nem valami benne). */
  isRoot: boolean
}

/**
 * Melyik repoban all ez az utvonal -- ha egyaltalan.
 *
 * Felfele lepked a `.git` utan, de SOSE lep ki a depobol: egy depon kivuli
 * `.git` (peldaul a felhasznalo home-jaban) nem tehet ora alatt egy egesz agat.
 */
export function repoAt(rel: string): RepoAt | null {
  const root = explorerRoot()
  const abs = resolveLifePath(rel)
  if (!root || !abs) return null
  let cur = abs
  for (let i = 0; i < 40; i++) {
    if (!cur.startsWith(root)) return null
    if (existsSync(join(cur, '.git'))) {
      return { abs: cur, rel: toLifeRel(cur), isRoot: cur === abs }
    }
    const up = dirname(cur)
    if (up === cur || up.length < root.length) return null
    cur = up
  }
  return null
}

/**
 * Szabad-e kezzel MEGVALTOZTATNI (athelyezni, atnevezni, ide letrehozni)?
 *
 * Ures szoveg = szabad. Kulonben a visszaadott mondat MEGMONDJA, mit tegyen
 * helyette -- ez a lenyege: nem falat huzunk, hanem utat mutatunk.
 */
export function writeBlockReason(rel: string): string {
  const at = repoAt(rel)
  if (!at) return ''
  // Magat a repo-mappat lehet mozgatni es torolni: az egy klon, nem a
  // tartalma. A tiltas csak a repon BELULRE szol.
  if (at.isRoot) return ''
  return 'Ez egy git-repó belseje, ezért innen nem mozgatok és nem hozok létre semmit. '
    + 'Szerkeszd a szerkesztőben, aztán commit + push — kézzel mozgatva a git elveszíti a fájl történetét, '
    + 'és a következő letöltés vagy visszasírja, vagy csendben eldobja. '
    + `A repó: ${at.rel}`
}

/** Egy repo allapota emberi mondatban. */
export interface RepoStatus {
  isRepo: boolean
  rel: string
  branch: string
  remote: string
  /** Modositott vagy uj, nem kommitolt fajlok szama. */
  dirty: number
  /** Hany commit van keszen, de nincs feltolva. */
  ahead: number
  /** Van-e egyaltalan tavoli ag, ahova fel lehetne tolni. */
  hasUpstream: boolean
  /** Nyugodtan torolheto-e: minden munka biztonsagban van valahol maskor is. */
  safe: boolean
  /** Emberi mondat a feluletre. */
  sentence: string
  /** Ha a git maga nem volt elerheto vagy hibazott. */
  error: string
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '').trim() })
    })
  })
}

/**
 * Megmeri, elveszne-e barmi a repo torlesevel.
 *
 * Nem tippelunk: `git status` es a tavoli ag elotti commitok szama dont. Ez
 * tobbet er a tiltasnal, mert a VALODI kockazatot meri.
 */
export async function repoStatus(rel: string): Promise<RepoStatus> {
  const base: RepoStatus = {
    isRepo: false, rel: '', branch: '', remote: '', dirty: 0, ahead: 0,
    hasUpstream: false, safe: false, sentence: '', error: '',
  }
  const at = repoAt(rel)
  if (!at) return { ...base, sentence: 'Ez nem git-repó.' }
  const cwd = at.abs

  const [st, br, rm, up] = await Promise.all([
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
  ])
  if (!br.ok && !st.ok) {
    return {
      ...base, isRepo: true, rel: at.rel,
      error: 'nem sikerült megkérdezni a gitet',
      sentence: 'Ez git-repó, de nem tudtam megkérdezni a gitet az állapotáról. '
        + 'Amíg ez így van, ne töröld — nem tudom megmondani, van-e benne feltöltetlen munka.',
    }
  }

  const dirty = st.out ? st.out.split('\n').filter((l) => l.trim()).length : 0
  const hasUpstream = up.ok && Boolean(up.out)
  let ahead = 0
  if (hasUpstream) {
    const a = await git(cwd, ['rev-list', '--count', '@{upstream}..HEAD'])
    ahead = a.ok ? Number(a.out) || 0 : 0
  }

  const safe = dirty === 0 && ahead === 0 && hasUpstream
  let sentence: string
  if (safe) {
    sentence = `Nyugodtan törölhető: minden fel van töltve${rm.out ? ' ide: ' + rm.out : ''}, bármikor visszahúzható.`
  } else if (!hasUpstream) {
    sentence = '⚠ Ennek a repónak nincs távoli ága, ahova fel lenne töltve'
      + (dirty ? `, és ${dirty} fájl módosítva van` : '')
      + '. Ha törlöd, ami itt van, az elveszik.'
  } else {
    const parts: string[] = []
    if (ahead) parts.push(`${ahead} commit nincs feltolva`)
    if (dirty) parts.push(`${dirty} fájl módosítva`)
    sentence = `⚠ ${parts.join(' és ')} — ha törlöd, ez a munka elvész.`
  }

  return {
    ...base, isRepo: true, rel: at.rel, branch: br.out, remote: rm.out,
    dirty, ahead, hasUpstream, safe, sentence,
  }
}

export interface RepoDeleteResult {
  ok: boolean
  code?: string
  message: string
  status?: RepoStatus
}

/**
 * A repo-mappa torlese.
 *
 * Ketto is vedi: (1) csak a repo GYOKERET lehet igy torolni, (2) ha a meres
 * szerint elveszne munka, kulon `force` kell hozza -- amit a felulet csak a
 * mondat kiirasa UTAN ker.
 */
export async function deleteRepo(rel: string, opts: { force?: boolean } = {}): Promise<RepoDeleteResult> {
  const at = repoAt(rel)
  if (!at) return { ok: false, code: 'not_repo', message: 'Ez nem git-repó, ezért így nem törlöm.' }
  if (!at.isRoot) {
    return {
      ok: false, code: 'not_root',
      message: `Ez a repón belül van. Az egész repót törölni innen lehet: ${at.rel}`,
    }
  }
  let isDir = false
  try { isDir = statSync(at.abs).isDirectory() } catch { isDir = false }
  if (!isDir) return { ok: false, code: 'missing', message: 'Ez a mappa már nincs meg. Frissítsd a listát.' }

  const status = await repoStatus(rel)
  if (!status.safe && !opts.force) {
    return { ok: false, code: 'unsafe', message: status.sentence, status }
  }

  try {
    rmSync(at.abs, { recursive: true, force: true })
  } catch (err: any) {
    return { ok: false, code: 'failed', message: `Nem sikerült törölni: ${String(err?.code || err?.message || err)}` }
  }

  // A ra mutato bekotesek kulonben egy nem letezo helyre mutatnanak: egy ures
  // mappa latszana, es a felhasznalo azt hinne, elvesztek a fajljai.
  let unmounted = 0
  for (const m of listMounts()) {
    const t = resolveLifePath(m.target)
    if (!t) continue
    if (t === at.abs || t.startsWith(at.abs + sep)) { removeMount(m.rel); unmounted++ }
  }

  logger.info({ rel: at.rel, unmounted, forced: Boolean(opts.force) }, '[intezo] git-repo torolve')
  return {
    ok: true,
    message: `Törölve: ${at.rel}.`
      + (unmounted ? ` A rá mutató ${unmounted} bekötést is megszüntettem.` : '')
      + (status.safe ? ' Bármikor visszahúzható a távoli tárolóból.' : ''),
    status,
  }
}
