// A DEPO LESZAKADT CSATOLASANAK HELYREALLITASA.
//
// A MERT ESET (2026-08-26). Reggel a depo (`/mnt/f`) elerhetetlen volt, es a
// git-lehuzas minden tarolot elavultnak latott. Nem a lemez tunt el es nem a
// Marveen romlott el: a WSL 9p csatornaja szakadt el. Ugyanaznap 08:40-kor
// ugyanez a `/mnt/c`-vel is megtortent -- `Input/output error` --, mikozben a
// `/proc/mounts` szerint a csatolas "ott volt". Az elso mereskor ez latszott:
//
//   C:\134 /mnt/c 9p ... trans=fd,rfd=12,wfd=12    <- eredeti automount, HALOTT
//   F:     /mnt/f 9p ... trans=fd,rfd=3,wfd=3      <- kezi ujracsatolas, EL
//
// Vagyis az eredeti csatorna (rfd=12) vitte magaval az osszes rajta logo
// meghajtot.
//
// AZ OK NEM A MARVEEN, ES NEM IS TALALGATAS. Ez a WSL2 egy ismert hibamodja: a
// Windows-meghajtok 9p kapcsolata nem all helyre rendesen ujrainditas utan, ha
// az `LxssManager` szolgaltatas hamarabb indul, mint ahogy a Windows a
// meghajtokat felcsatolja. A tipikus kivalto ok a Windows GYORS INDITAS
// (hybrid shutdown), ami a leallitaskori allapotot menti ki, es ezzel
// felemas allapotban hagyja az erintett szolgaltatasokat.
// (microsoft/WSL#4377; linuxvox.com WSL2 fast-startup elemzes.)
//
// Ezen a gepen a kivalto ok MERVE megvan: `HiberbootEnabled = 1`.
//
// A KET JAVITAS SORRENDJE, ahogy a szakma ajanlja:
//   1. `wsl --shutdown` a Windows oldalarol, majd ujraindul a WSL. Ez az igazi
//      javitas: MINDEN meghajto csatolasat ujraepiti. Cserebe leall minden, ami
//      a WSL-ben fut -- a Marveen is --, ezert nem a Marveen indithatja el
//      magan.
//   2. Celzott ujracsatolas (ez a modul). Csak a depot erinti, semmi mas nem
//      all le. Ezt lehet kozben, uzem alatt hasznalni.
//
// A TARTOS MEGELOZES a Gyors inditas kikapcsolasa -- de az rendszerbeallitas a
// felhasznalo gepen, ezert a Marveen csak JAVASOLJA, sosem allitja at magatol.
//
// AMIT EZ A MODUL CSINAL. Osszeallitja a PONTOS ujracsatolo parancsot -- a
// MERT beallitasokbol, nem sablonbol. Ez nem szoreszhasogatas: reggel a
// kezenfekvo parancsba bekerult egy `metadata` kapcsolo, ami az eredeti
// csatolason NEM volt rajta, es ezzel eszrevetlenul megvaltoztatta volna a
// jogosultsag-kezelest az egesz depon.
//
// A "nem tudom" itt is kulon allapot: ha egyetlen Windows-meghajto csatolasat
// sem latjuk, azt megmondjuk, nem tippelunk helyette alapertelmezest.

import { readFileSync } from 'node:fs'

/** Egy Windows-meghajto csatolasa, ahogy a `/proc/mounts` mutatja. */
export interface MountInfo {
  /** A csatolasi pont, pl. `/mnt/f`. */
  mountpoint: string
  /** Amit a kernel eszkoznek lat, pl. `F:` vagy `C:\` (visszaperjellel). */
  device: string
  /** A nyers opcio-lista. */
  raw: string
}

/**
 * Honnan tudjuk a csatolasi beallitasokat. A felulet KIMONDJA a felhasznalonak,
 * mert a harom eset kulonbozo bizalmat erdemel.
 */
export type OptionSource =
  /** Magarol a depo csatolasarol olvastuk le (a legjobb eset). */
  | 'measured'
  /** Egy MASIK, meg elo Windows-meghajto csatolasarol -- ugyanaz a WSL adja. */
  | 'sibling'
  /** Egyetlen Windows-csatolast sem latunk. NEM tippelunk: ezt kimondjuk. */
  | 'unknown'

export interface RemountPlan {
  /** A meghajtobetu nagybetuvel, pl. `F`. */
  drive: string
  /** A csatolasi pont, pl. `/mnt/f`. */
  mountpoint: string
  /** A `-o` utan menö opciok, vesszovel, pl. `uid=1000,gid=1000`. */
  options: string
  optionSource: OptionSource
  /**
   * A teljes, beilesztheto parancs. Szandekosan EGY sor es `;`-vel valaszt, nem
   * `&&`-vel: ha az `umount` azt mondja, "nincs is csatolva", az `&&` ELNYELNE
   * a lenyeget, magat a `mount`-ot (merve 2026-08-26).
   */
  command: string
}

const MOUNTS = '/proc/mounts'

/**
 * A Windows-meghajtok csatolasai. Ures tomb KET dolgot jelenthet -- nincs
 * ilyen csatolas, vagy nem tudtuk elolvasni a `/proc/mounts`-ot --, ezert a
 * masodikat kulon jelezzuk `null`-lal.
 */
export function listDrvfsMounts(text?: string): MountInfo[] | null {
  let tartalom = text
  if (tartalom === undefined) {
    try {
      tartalom = readFileSync(MOUNTS, 'utf8')
    } catch {
      return null
    }
  }
  const ki: MountInfo[] = []
  for (const sor of tartalom.split('\n')) {
    const [device, mountpoint, tipus, raw] = sor.split(/\s+/)
    if (!mountpoint || !raw) continue
    // A `9p` a WSL2 Windows-meghajtoinak tipusa, a `drvfs` a regebbi/WSL1
    // valtozate. Az `aname=drvfs` mindkettonel ott van, ezert arra szurunk.
    if (tipus !== '9p' && tipus !== 'drvfs') continue
    if (!raw.includes('drvfs')) continue
    if (!/^\/mnt\/[a-z]$/i.test(mountpoint)) continue
    ki.push({ mountpoint, device, raw })
  }
  return ki
}

/**
 * A csatolasi opciokbol az, ami az UJRACSATOLASHOZ kell.
 *
 * A `/proc/mounts` sok olyat is mutat, amit a `mount` nem fogad el vagy magatol
 * beallit (`rfd`, `wfd`, `trans`, `aname`, `symlinkroot`, `cache`, `msize`,
 * `access`, `path`). Ezeket kihagyjuk. Ami MARAD, azt viszont visszük -- es
 * amit nem latunk, azt nem talaljuk ki: ha az eredeti csatolason nem volt
 * `metadata`, akkor a javitasba sem kerulhet bele.
 */
export function usefulMountOptions(raw: string): string {
  const KIHAGY = new Set([
    'rfd', 'wfd', 'trans', 'aname', 'symlinkroot', 'cache', 'msize', 'access',
    'path', 'rw', 'ro', 'relatime', 'noatime', 'nosuid', 'nodev', 'noexec',
  ])
  const ki: string[] = []
  // A WSL a 9p opciokat pontosvesszovel is tagolja az `aname=` blokkon belul,
  // ezert mind a ketto hatarolot bontjuk.
  for (const darab of raw.split(/[,;]/)) {
    const d = darab.trim()
    if (!d) continue
    const kulcs = d.split('=')[0]!.toLowerCase()
    if (KIHAGY.has(kulcs)) continue
    if (ki.includes(d)) continue
    ki.push(d)
  }
  return ki.join(',')
}

/**
 * Terv a depo ujracsatolasara.
 *
 * `null`, ha a depo NEM Windows-meghajton van (pl. sima Linux-utvonal vagy
 * kulso lemez) -- olyankor az ujracsatolas nem a valasz, es nem is szabad
 * ilyet javasolni.
 */
export function depotRemountPlan(root: string, mounts?: MountInfo[] | null): RemountPlan | null {
  const m = /^\/mnt\/([a-z])(\/|$)/i.exec(root)
  if (!m) return null
  const betu = m[1]!.toLowerCase()
  const mountpoint = `/mnt/${betu}`
  const lista = mounts === undefined ? listDrvfsMounts() : mounts

  let options = ''
  let optionSource: OptionSource = 'unknown'
  if (lista) {
    const sajat = lista.find((x) => x.mountpoint === mountpoint)
    if (sajat) {
      options = usefulMountOptions(sajat.raw)
      optionSource = 'measured'
    } else {
      // A depo csatolasa eltunt. Egy MASIK Windows-meghajto viszont ugyanezt a
      // WSL-t hasznalja, tehat ugyanazokat az opciokat kapta -- ez meres, nem
      // tipp. A felulet ezt kulon ki is mondja.
      const testver = lista[0]
      if (testver) {
        options = usefulMountOptions(testver.raw)
        optionSource = 'sibling'
      }
    }
  }

  const drive = betu.toUpperCase()
  const opcioResz = options ? ` -o ${options}` : ''
  const command =
    `sudo umount ${mountpoint} ; sudo mount -t drvfs '${drive}:' ${mountpoint}${opcioResz}`

  return { drive, mountpoint, options, optionSource, command }
}

/**
 * A ket lepes ARGV-ben, hejj nelkul.
 *
 * Miert nem a `command` sztringet futtatjuk: az beilesztesre keszult, es hejj
 * ertelmezi (idezojel, pontosvesszo). Ha a Marveen maga futtatja, minden ilyen
 * ertelmezes egy lehetoseg arra, hogy MAS parancs fusson, mint amit a sudoers
 * engedelyezett. Az argv-nel nincs mit felreerteni.
 *
 * A ket lepes KULON fut, es a masodik akkor is elindul, ha az elso elhasal:
 * egy "nincs is csatolva" umount nem hiba, hanem eppen a kiindulasi allapot.
 */
export function remountArgv(plan: RemountPlan): string[][] {
  const mount = ['mount', '-t', 'drvfs', `${plan.drive}:`, plan.mountpoint]
  if (plan.options) mount.push('-o', plan.options)
  return [['umount', plan.mountpoint], mount]
}

/**
 * A sudoers-sor, ami PONTOSAN ezt a ket parancsot engedi -- semmi mast.
 *
 * Ez a legszukebb hatokor, amivel az onjavitas mukodhet: nev szerint a ket
 * binaris, rogzitett argumentumokkal, erre az egy csatolasi pontra. Nem
 * `ALL=(ALL) NOPASSWD: ALL`, es nem is a teljes `mount` szabadon.
 *
 * A vesszot KI KELL VEDENI: a sudoers-ben a vesszo parancsokat valaszt el, az
 * opcio-listankban viszont (`uid=1000,gid=1000`) adat. Escape nelkul a sor
 * mast engedelyezne, mint amit latszik.
 */
export function remountSudoersLine(plan: RemountPlan, user: string): string {
  const eleresi: Record<string, string> = { umount: '/usr/bin/umount', mount: '/usr/bin/mount' }
  const reszek = remountArgv(plan).map((argv) => {
    const [prog, ...args] = argv
    return [eleresi[prog!] || prog!, ...args.map((a) => a.replace(/,/g, '\\,'))].join(' ')
  })
  return `${user} ALL=(root) NOPASSWD: ${reszek.join(', ')}`
}
