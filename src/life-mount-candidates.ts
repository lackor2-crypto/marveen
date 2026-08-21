// MIT LEHET BEKOTNI? -- a felajanlott celok osszeszedese.
//
// A terv 5-7. fazisa (Google Drive / Google Photos / Git) gyakorlatilag EGY
// kerdes a felhasznalo feloel: "melyik mappat kossem ide?". Ennek pedig nem
// szabad gepelessel jarnia: a felhasznalo NEM programozo, nem tudja fejbol,
// hogy `drive/lackor2/Dokumentumok`, es nem is kene tudnia.
//
// Ezert a Marveen VEGIGNEZI, mi all mar a lemezen -- a Drive-szinkron mappai,
// a letoltott fotok, a git repok --, es egy listat ad: kattints ra.
//
// Ami itt nincs: semmi hivas a Google fele. Csak azt ajanljuk fel, ami MAR
// letoltve all a gepen, mert csak azt tudjuk bekotni. Ha egy Drive-mappa meg
// nincs szinkronizalva, eloszor a Drive oldalon kell felvenni -- es a
// felajanlott lista uzenete pontosan ezt is mondja meg.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { depotRoot, DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS } from './depot.js'

export interface MountCandidate {
  /** A depo gyokerehez kepesti utvonal -- ezt kuldi vissza a felulet. */
  target: string
  /** Emberi felirat: "lackor2 — Google Drive / Dokumentumok". */
  label: string
  kind: 'drive' | 'photos' | 'git'
  /** Hany tetel van benne kozvetlenul. Segit felismerni, melyik az igazi. */
  items: number
}

function countItems(abs: string): number {
  try { return readdirSync(abs).filter((n) => !n.startsWith('.')).length } catch { return 0 }
}

function subdirs(abs: string): string[] {
  try {
    return readdirSync(abs).filter((n) => {
      if (n.startsWith('.')) return false
      try { return statSync(join(abs, n)).isDirectory() } catch { return false }
    })
  } catch { return [] }
}

/**
 * Minden bekotheto hely, egy listaban.
 *
 * A sorrend nem veletlen: eloszor a Drive-mappak (ide kerul a dokumentumok
 * tulnyomo resze), utana a fotok, vegul a fejlesztoi repok -- ez utobbibol van
 * a legtobb, es a legritkabban kell bekotni.
 */
export function mountCandidates(): MountCandidate[] {
  const root = depotRoot()
  if (!root) return []
  const out: MountCandidate[] = []

  // 5. fazis -- Google Drive. Ket szint: a fiok, es a fiok alatti mappak.
  // Mindketto felajanlhato: van, aki az EGESZ Drive-jat koti be egy agra, es
  // van, aki csak a "Dokumentumok" mappat.
  const driveRoot = join(root, DEPOT_DRIVE)
  if (existsSync(driveRoot)) {
    for (const account of subdirs(driveRoot)) {
      const accAbs = join(driveRoot, account)
      out.push({
        target: `${DEPOT_DRIVE}/${account}`,
        label: `${account} — a teljes Google Drive`,
        kind: 'drive',
        items: countItems(accAbs),
      })
      for (const folder of subdirs(accAbs)) {
        out.push({
          target: `${DEPOT_DRIVE}/${account}/${folder}`,
          label: `${account} — Google Drive / ${folder}`,
          kind: 'drive',
          items: countItems(join(accAbs, folder)),
        })
      }
    }
  }

  // 6. fazis -- Google Photos. Itt csak fiok-szint van: a kepeket nem
  // rendezgetjuk almappakba, mert a Photos sajat rendezese (datum, album) nem
  // fordithato le mappakra ugy, hogy az utana is igaz maradjon.
  const photoRoot = join(root, DEPOT_PHOTOS)
  if (existsSync(photoRoot)) {
    for (const account of subdirs(photoRoot)) {
      out.push({
        target: `${DEPOT_PHOTOS}/${account}`,
        label: `${account} — Google Fotók`,
        kind: 'photos',
        items: countItems(join(photoRoot, account)),
      })
    }
  }

  // 7. fazis -- git repok. CSAK azt ajanljuk fel, ami tenyleg repo (`.git`):
  // egy fel-masolt mappa bekotese kesobb megmagyarazhatatlan lenne.
  //
  // A repo SAJAT dokumentacios retegehez nem nyulunk -- a terv kikotese --,
  // ezert itt csak MUTATOT keszitunk ra, semmi mast.
  //
  // KET SZINT, mert a git is TOBBFIOKOS (Boss, 2026-08-21: "drive fotok es git
  // is! tobb fiokkal"): `Git/<fiok>/<repo>`. A REGI, lapos `Git/<repo>` is
  // felajanlhato marad -- egy mar bekotott repo nem tunhet el csak azert, mert
  // kesobb bevezettuk a fiok-szintet.
  const projRoot = join(root, DEPOT_PROJECTS)
  if (existsSync(projRoot)) {
    for (const name of subdirs(projRoot)) {
      const abs = join(projRoot, name)
      if (existsSync(join(abs, '.git'))) {
        // Lapos, fiok nelkuli repo -- a fiok-szint elotti telepitesekbol.
        out.push({
          target: `${DEPOT_PROJECTS}/${name}`,
          label: `${name} — Git repository`,
          kind: 'git',
          items: countItems(abs),
        })
        continue
      }
      // Nem repo -> fiok-mappa: a repok egy szinttel lejjebb allnak. Igy egy
      // fel-masolt, `.git` nelkuli mappa sem kerul a listaba tevedesbol.
      for (const repo of subdirs(abs)) {
        const repoAbs = join(abs, repo)
        if (!existsSync(join(repoAbs, '.git'))) continue
        out.push({
          target: `${DEPOT_PROJECTS}/${name}/${repo}`,
          label: `${name} / ${repo} — Git repository`,
          kind: 'git',
          items: countItems(repoAbs),
        })
      }
    }
  }

  return out
}
