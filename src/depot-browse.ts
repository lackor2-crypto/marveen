// Mappa-valaszto a depohoz: lemezek es mappak felsorolasa, emberi utvonalakkal.
//
// Miert kell ez egyaltalan (Boss, 2026-08-15): "/mnt/d/Marveen. szerinted a
// komuves erti hogy ez mi? jobb lenne ha ki lehetne valasztani ugy mint amikor
// fel akarok tolteni egy filet vagy mappat. nem kezzel beirni meg per jel
// stb... a hulyebiztossag az nem itt kezdodik."
//
// Igaza van. Ket kulon dolgot kell megoldani:
//
//  1. NE KELLJEN GEPELNI. A bongeszo nem tud igazi Windows-mappavalasztot
//     nyitni ugy, hogy az utvonalat vissza is adja (a File System Access API
//     szandekosan nem adja oda az utvonalat, es amugy sem minden bongeszoben
//     van meg). De nekunk nem is kell: a KISZOLGALO maga a gep. Tehat a
//     Marveen sorolja fel a lemezeket es a mappakat, a felhasznalo pedig
//     kattintgat -- ugyanaz az elmeny, mint egy feltoltes-ablak, csak nem a
//     bongeszo csinalja.
//
//  2. NE LATSSON PER-JELES UTVONALAT. Belul a Marveen Linuxban fut, es ott a
//     D: lemez `/mnt/d` neven latszik -- ezt a kodnak tudnia kell, a
//     felhasznalonak nem. A felulet mindenutt `D:\Marveen` alakot mutat, es a
//     ket alak kozott ez a modul fordit oda-vissza. Ha valaki megis begepel
//     egy `D:\Marveen`-t a Beallitasoknal, azt is elfogadjuk.
import { readFileSync } from 'node:fs'
import { statfs as statfsAsync, readdir as readdirAsync, stat as statAsync } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** Egy csatolt Windows-lemez, ahogy a WSL latja. */
export interface DriveInfo {
  /** A linuxos csatolasi pont, pl. `/mnt/d`. Ezzel dolgozik a kod. */
  path: string
  /** Amit a felhasznalo lat, pl. `D:`. */
  display: string
  /** Emberi cimke a listahoz, pl. `D: lemez`. */
  label: string
  /** Szabad hely bajtban, vagy null, ha nem tudtuk megallapitani. */
  freeBytes: number | null
  /** Teljes meret bajtban, vagy null. */
  totalBytes: number | null
}

/**
 * A Windows-lemezek, amiket a Marveen valoban elér.
 *
 * A `/proc/mounts`-bol dolgozunk, nem a `/mnt` listazasabol: a `/mnt/d` mappa
 * ATTOL MEG ott lehet, hogy a lemez lecsatolodott (eppen ez a mert hibamod --
 * a drvfs-atjaro meghal, a mappa marad, es minden muvelet hibara fut). Ami a
 * `/proc/mounts`-ban drvfs-kent szerepel, az tenylegesen csatolva van.
 */
// ASZINKRON, szandekosan: a `statfs` egy lassu halozati csatolason (9p, drvfs)
// nehany szaz ms-ig is elhuzodhat. A dashboard EGY szalon fut, igy egy szinkron
// statfs a mappavalasztokor az OSSZES tobbi kerest es a hatter-pollokat is
// megfagyasztana. Az aszinkron valtozat csak ezt a valaszt kesleltetheti.
export async function listDrives(mountsFile = '/proc/mounts'): Promise<DriveInfo[]> {
  let text = ''
  try { text = readFileSync(mountsFile, 'utf8') } catch { return [] }
  const picked: { mount: string; letter: string }[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const [, mountRaw, type] = parts
    if (type !== 'drvfs' && type !== '9p') continue
    // A /proc/mounts a szokozt \040-kent irja.
    const mount = mountRaw.replace(/\\040/g, ' ')
    const m = /^\/mnt\/([a-z])$/.exec(mount)
    if (!m || seen.has(mount)) continue
    seen.add(mount)
    picked.push({ mount, letter: m[1].toUpperCase() })
  }
  // A lemezek szabad-helyet parhuzamosan merjuk: igy ket lemeznel nem adodik
  // ossze a ket statfs varakozasa.
  const out = await Promise.all(picked.map(async ({ mount, letter }) => {
    const { freeBytes, totalBytes } = await diskSpace(mount)
    return {
      path: mount,
      display: `${letter}:`,
      label: `${letter}: lemez`,
      freeBytes,
      totalBytes,
    }
  }))
  return out.sort((a, b) => a.display.localeCompare(b.display))
}

/** Szabad/teljes hely, ha a Node-unk tudja. Sose dob. Aszinkron: lasd listDrives. */
export async function diskSpace(path: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    if (typeof statfsAsync !== 'function') return { freeBytes: null, totalBytes: null }
    const s = await statfsAsync(path)
    return { freeBytes: s.bsize * s.bavail, totalBytes: s.bsize * s.blocks }
  } catch {
    return { freeBytes: null, totalBytes: null }
  }
}

/**
 * Linuxos utvonal -> amit a felhasznalo lat.
 *
 * `/mnt/d/Marveen` -> `D:\Marveen`. Ami nem egy csatolt lemezen van, az marad,
 * ahogy van: nem talalunk ki neki hamis Windows-utvonalat.
 */
export function toDisplayPath(p: string): string {
  const s = String(p || '')
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(s)
  if (!m) return s
  const rest = (m[2] || '').replace(/\//g, '\\')
  return `${m[1].toUpperCase()}:${rest}`
}

/**
 * Amit a felhasznalo beir -> amivel a kod dolgozik.
 *
 * `D:\Marveen`, `d:/Marveen`, `D:` mind mukodik. Ami mar linuxos utvonal, az
 * valtozatlanul megy tovabb -- igy a Beallitasok mezoje mindket alakot
 * elfogadja, es senkinek nem kell tudnia, melyik a "helyes".
 */
export function fromDisplayPath(s: string): string {
  const raw = String(s || '').trim()
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(raw)
  if (!m) return raw
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return `/mnt/${m[1].toLowerCase()}${rest ? '/' + rest : ''}`
}

/**
 * A beallitasokban tarolt depo-utvonal -> amivel a kod dolgozik.
 *
 * A `D: -> /mnt/d` forditas CSAK Linuxon (WSL) ertelmes: ott latszik igy egy
 * Windows-lemez. Egy macOS-telepitesen egy `D:`-vel kezdodo utvonal nem
 * Windows-lemez, es ott ebbol a forditasbol csak kar szarmazna -- ezert a
 * rendszer nevet is megkerdezzuk, nem csak az utvonal alakjat nezzuk.
 */
export function normalizeDepotPath(raw: string, platform: string = process.platform): string {
  const s = String(raw || '').trim()
  if (!s || platform !== 'linux') return s
  return fromDisplayPath(s)
}

export interface FolderEntry {
  name: string
  path: string
  display: string
}

export interface BrowseResult {
  /** Ahol allunk (linuxos alak), vagy null a legfelso szinten. */
  path: string | null
  /** Ahol allunk, emberi alakban -- ez megy a felulet cimsoraba. */
  display: string
  /** A szulomappa, vagy null, ha innen mar csak a lemezlistara lehet vissza. */
  parent: string | null
  /** A lemezek listaja (csak a legfelso szinten toltjuk ki). */
  drives: DriveInfo[]
  /** Az itteni almappak. */
  folders: FolderEntry[]
  /** Emberi mondat, ha valami nem sikerult (nem hiba: uzenet a felulet szamara). */
  message: string | null
}

/**
 * Egy szint felsorolasa a valasztohoz.
 *
 * `path` nelkul a lemezlista jon (ez a "Sajat gep" szint). Csak MAPPAKAT
 * adunk vissza -- a valaszto mappat valaszt, a fajlneveknek itt semmi
 * keresnivalojuk, es igy a vegpont nem is valik altalanos fajlbongeszove.
 */
// ASZINKRON, szandekosan: a readdir + mappankenti stat egy lassu csatolason
// (9p/drvfs) blokkolna az egyetlen Node-szalat, es vele az egesz dashboardot.
// Igy a lassu meghajto csak ezt a valaszt kesleltetheti, a tobbit nem.
export async function browseFolders(path: string | null | undefined): Promise<BrowseResult> {
  const drives = await listDrives()
  if (!path) {
    return { path: null, display: 'Saját gép', parent: null, drives, folders: [], message: null }
  }
  const target = fromDisplayPath(path)
  const base: BrowseResult = {
    path: target,
    display: toDisplayPath(target),
    // A lemez gyokerebol a lemezlistara megyunk vissza, nem a `/mnt`-be:
    // a `/mnt` egy linuxos reszlet, aminek a felhasznalo szamara nincs erteme.
    parent: /^\/mnt\/[a-z]$/.test(target) ? null : dirname(target),
    drives,
    folders: [],
    message: null,
  }
  // Egyetlen stat donti el: letezik-e, es mappa-e. ENOENT -> "nincs meg";
  // barmi mas hiba (pl. jogosultsag, lecsatolt atjaro) -> "most nem érhető el".
  try {
    const st = await statAsync(target)
    if (!st.isDirectory()) {
      return { ...base, message: 'Ez nem mappa, hanem fájl.' }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ...base, message: `Ez a mappa nincs meg: ${toDisplayPath(target)}` }
    }
    return { ...base, message: `Ez a mappa most nem érhető el: ${toDisplayPath(target)}` }
  }
  let names: string[] = []
  try {
    names = await readdirAsync(target)
  } catch {
    return { ...base, message: 'Ebbe a mappába nincs betekintési jogom.' }
  }
  // A rejtett es rendszermappak csak zajt visznek a listaba -- ezeket meg a
  // (draga) stat ELOTT kiszurjuk.
  const candidates = names.filter(
    (name) => !(name.startsWith('.') || name === '$RECYCLE.BIN' || name === 'System Volume Information'),
  )
  // A statokat korlatozott parhuzamossaggal, a readdir sorrendjeben futtatjuk,
  // es amint 500 mappat osszegyujtottunk, megallunk: egy tulzsufolt mappa
  // (tizezernyi bejegyzes) igy sem futtat tizezernyi statot egyszerre.
  const folders: FolderEntry[] = []
  const CAP = 500
  const CONCURRENCY = 16
  for (let i = 0; i < candidates.length && folders.length < CAP; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)
    const checked = await Promise.all(
      batch.map(async (name) => {
        const full = join(target, name)
        try {
          return (await statAsync(full)).isDirectory() ? { name, full } : null
        } catch {
          return null
        }
      }),
    )
    for (const hit of checked) {
      if (!hit) continue
      folders.push({ name: hit.name, path: hit.full, display: toDisplayPath(hit.full) })
      // Egy tulzsufolt mappa listaja se a felulet, se az ember szamara nem
      // hasznalhato; a valasztashoz boven eleg ennyi.
      if (folders.length >= CAP) break
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  return { ...base, folders }
}

/** Emberi meretkiiras a lemezlistahoz. */
export function humanBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '?'
  const gb = n / 1024 ** 3
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`
  if (gb >= 10) return `${Math.round(gb)} GB`
  return `${gb.toFixed(1)} GB`
}
