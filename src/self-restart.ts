// "Újraindítás után lép életbe" -- de mit, es hogyan?
//
// Boss, 2026-08-15: "Ujrainditas utan lep eletbe. sok helyen ez van. igen de a
// komuvesunk hogyan inditsa ujra es mit? tudnal egy gombot oda tenni hogy
// ujraindit. es akor amit kell azt inditja ujra..."
//
// Igaza van: a felulet eddig kimondta a feltetelt, de nem adta hozza az
// eszkozt. Aki nem tudja, hogy a Marveen egy `systemd --user` szolgaltatas,
// annak ez a mondat egy zsakutca.
//
// EZ A MODUL EGYETLEN DOLGOT CSINAL: ujrainditja ONMAGAT (a vezerlopultot).
//
// Miert csak azt? Mert a masik szolgaltatast megbolygatni SULYOS kar:
// a csatorna-unit `KillMode=control-group`-pal fut, es a kozos tmux SZERVER az
// o cgroupjaban el -- egy `systemctl --user restart` ott megolne a tmux
// szervert, azzal EGYUTT MINDEN agens munkamenetet, nem csak a foagenset
// (lasd a figyelmeztetest: src/web/channel-monitor.ts:1048). Ezert:
//
//   - a unit nevet NEM a felhasznalotol, nem is talalgatasbol vesszuk, hanem a
//     sajat `/proc/self/cgroup`-unkbol. Igy fogalmilag keptelen mast
//     ujrainditani, mint azt a folyamatot, amelyik a kerest kiszolgalja;
//   - es meg erre is teszunk egy kifejezett tiltast a "channels" nevre, hogy
//     ha valaha egy telepites osszevonna a kettot, inkabb NE induljon ujra
//     semmi, mint hogy tmux-szervert oljunk.
//
// A beallitasok TOBBSEGE ebben a folyamatban el (MARVEEN_DEPOT, WEB_PORT,
// OLLAMA_URL...), tehat rajuk a vezerlopult ujrainditasa a helyes valasz.
//
// De NEM MINDEGYIKRE, es ezt 2026-08-16-ig a felulet elhallgatta. A
// MAIN_AGENT_CONFIG_DIR es tarsai a fo agens SAJAT folyamataban ervenyesulnek:
// azokon ez a modul semmit nem valtoztat, es Boss pontosan ezt tapasztalta
// ("sokszor ujra lett mar inditva a marvin es megis itt vannak ezek a sarga
// betuk") -- a rossz gombot nyomta, mert csak egy gomb volt. Ezert minden
// beallitas megmondja a sajat celpontjat (`restartTarget`,
// src/config-registry.ts), es a Beallitasok oldal ahhoz valasztja a vezerlot:
// 'main-agent' eseten a POST /api/marveen/restart megy, nem ez a modul.
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { logger } from './logger.js'

/** Amit a felulet tudni akar, mielott gombot mutat. */
export interface RestartAvailability {
  /** Meg lehet-e nyomni a gombot? */
  possible: boolean
  /** A szolgaltatas neve, amit ujra fogunk inditani (vagy null). */
  unit: string | null
  /** Emberi mondat -- ez megy ki a feluletre, ha nem lehet. */
  reason: string
}

/**
 * Melyik systemd-szolgaltatasban futunk?
 *
 * A `/proc/self/cgroup` utolso `*.service` szelete a valasz, pl.
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/lackor2-bot-dashboard.service`
 * -> `lackor2-bot-dashboard.service`. A `user@1000.service`-t at kell lepni:
 * az a felhasznaloi systemd-menedzser, nem mi -- azt ujrainditani annyi, mint
 * mindent leloni. Ezert HATULROL keresunk, es a `user@...`-t kihagyjuk.
 *
 * A szoveget parameterkent is at lehet adni: igy a tesztek valodi cgroup-fajlok
 * tartalman merhetik a viselkedest, gep- es kornyezetfuggetlenul.
 */
export function ownSystemdUnit(cgroupText?: string): string | null {
  let text = cgroupText
  if (text === undefined) {
    try { text = readFileSync('/proc/self/cgroup', 'utf8') } catch { return null }
  }
  for (const line of String(text).split('\n')) {
    // A sor alakja `hierarchia:vezerlok:utvonal` -- minket az utvonal erdekel.
    const path = line.split(':').slice(2).join(':')
    if (!path) continue
    const parts = path.split('/').filter(Boolean)
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i]
      if (!seg.endsWith('.service')) continue
      // A felhasznaloi menedzser sajat unitja nem a mi szolgaltatasunk.
      if (/^user@[0-9]+\.service$/.test(seg)) continue
      return seg
    }
  }
  return null
}

/**
 * Szabad-e ezt a unitot ujrainditani?
 *
 * Egyetlen tiltas van, es az nem izlesbeli: a csatorna-unit ujrainditasa
 * megolne a kozos tmux szervert es vele minden agens munkamenetet.
 */
export function unitIsSafeToRestart(unit: string | null): boolean {
  if (!unit || !unit.endsWith('.service')) return false
  if (/channels/i.test(unit)) return false
  return true
}

/** Ki tudja-e magat egyaltalan indítani ez a telepites? */
export function restartAvailability(cgroupText?: string): RestartAvailability {
  if (process.platform !== 'linux') {
    return {
      possible: false,
      unit: null,
      reason: 'Ez a gép nem systemd-vel indítja a Marveent, ezért innen nem tudom újraindítani. Indítsd újra úgy, ahogy elindítottad.',
    }
  }
  const unit = ownSystemdUnit(cgroupText)
  if (!unit) {
    return {
      possible: false,
      unit: null,
      reason: 'A Marveen most nem szolgáltatásként fut, ezért innen nem tudom újraindítani. Zárd be és indítsd el újra ugyanúgy, ahogy elindítottad.',
    }
  }
  if (!unitIsSafeToRestart(unit)) {
    return {
      possible: false,
      unit,
      reason: 'Ezt a szolgáltatást szándékosan nem indítom újra innen, mert az összes futó ügynök munkamenetét megszakítaná.',
    }
  }
  return { possible: true, unit, reason: '' }
}

/**
 * Az ujrainditas parancsa.
 *
 * Kulon fuggveny, hogy a teszt LATHASSA, mit fogunk futtatni -- egy
 * ujrainditasi parancsot nem lehet "kiprobalni" egy tesztben.
 *
 * Miert `systemd-run`, es miert nem egyszeruen `systemctl --user restart`?
 * Mert az ujrainditas azt a folyamatot oli meg, amelyik a parancsot inditotta.
 * A `systemd-run` egy KULON, atmeneti unitban futtatja a parancsot (a mi
 * cgroupunkon kivul), igy a leallasunk nem viszi magaval. A fel masodperc
 * varakozas arra kell, hogy a bongeszo meg megkapja a valaszt.
 *
 * A tiltast ITT IS megismeteljuk, nem csak a hivo helyen. Ket okbol: egy
 * kesobbi atirasnal a hivo oldali ellenorzes elveszhet, es mert a parancs
 * osszerakasakor mar egy elgepelt toldalek is mas unitot celozna.
 */
export function restartCommand(unit: string): { cmd: string; args: string[] } {
  if (!unitIsSafeToRestart(unit)) {
    throw new Error(`Ezt a szolgaltatast nem szabad innen ujrainditani: ${unit}`)
  }
  return {
    cmd: 'systemd-run',
    args: [
      '--user', '--collect', '--quiet',
      `--description=Marveen ujrainditas (${unit})`,
      '/bin/sh', '-c', `sleep 1; systemctl --user restart ${unit}`,
    ],
  }
}

/**
 * Inditsuk el az ujrainditast -- de csak azutan, hogy valaszoltunk.
 *
 * A hivo eloszor kikuldi a HTTP-valaszt, es csak utana hivja ezt; a parancs
 * maga is var egy masodpercet, mielott hozzanyulna a szolgaltatashoz.
 */
export function performSelfRestart(
  cgroupText?: string,
  // A `spawn`-t kivulrol is at lehet adni. Nem szepsegbol: egy ujrainditast
  // nem lehet "kiprobalni" egy tesztben, viszont MEG KELL tudni merni, hogy
  // tiltott esetben tenylegesen el sem indul semmi -- ehhez latni kell, hivtuk-e.
  spawnFn: typeof spawn = spawn,
): RestartAvailability {
  const avail = restartAvailability(cgroupText)
  if (!avail.possible || !avail.unit) return avail
  try {
    // A parancs osszerakasa is ITT van, a vedohalon belul: a `restartCommand`
    // tiltott unitra kivetelt dob, es ezt a fuggvenyt a valasz KIKULDESE UTAN
    // hivjuk -- ott egy elszabadult kivetel az egesz folyamatot vinne.
    const { cmd, args } = restartCommand(avail.unit)
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
    logger.warn({ unit: avail.unit }, '[ujrainditas] a vezerlopult ujraindul, a felulet kerte')
  } catch (err: any) {
    logger.error({ err: err?.message, unit: avail.unit }, '[ujrainditas] nem sikerult elinditani')
    return { possible: false, unit: avail.unit, reason: 'Az újraindítást nem sikerült elindítani. Nézd meg a naplót.' }
  }
  return avail
}
