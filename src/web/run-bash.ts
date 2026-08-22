/**
 * Egy hejparancs futtatasa ugy, hogy KOZBEN a vezerlopult el.
 *
 * Ugyanaz a hiba ket kulon helyen ult: a parancs-kartyaknal
 * (`command-task.ts`) es az utemezesek elo-ellenorzojenel (`runPreCheck`,
 * `schedule-runner.ts`) is `spawnSync` futott. A `spawnSync` MEGALLITJA a
 * Node esemenyhurkot, amig a gyerekfolyamat el:
 *
 *  - egy 10 masodperces elo-ellenorzo szkript 10 masodpercre befagyasztotta a
 *    teljes feluletet -- minden percben, minden utemezett feladatnal;
 *  - egy parancs, ami VISSZAHIV a Marveenbe (a napi git-lehuzas pontosan
 *    ilyen: `curl` a sajat vegpontunkra), holtpontra futott, mert a szerver
 *    nem tudott valaszolni, amig a valaszra varo parancsot futtatta. A kartya
 *    ettol "hibasnak" latszott, holott a parancs vegig jo volt.
 *
 * Egy helyen javitva, hogy ne lehessen harmadszor is elrontani.
 */
import { spawn } from 'node:child_process'

export interface BashEredmeny {
  /** Kilepesi kod. `null`, ha el sem indult, vagy mi oltuk meg. */
  code: number | null
  stdout: string
  stderr: string
  /** Csak akkor van kitoltve, ha el sem indult vagy idotullepesbe futott. */
  error?: string
}

/** Korlatok, hogy egy elszabadult szkript kimenete ne egye meg a memoriat. */
const MAX_STDOUT = 64_000
const MAX_STDERR = 8_000

/**
 * `bash <args>` a hatterben. A valasz MINDIG megjon: hibara, idotullepesre es
 * sikerre is -- a hivonak sose kell kulon idozitot tennie mellé.
 */
export function runBash(args: string[], timeoutMs: number): Promise<BashEredmeny> {
  return new Promise<BashEredmeny>((resolve) => {
    let lezart = false
    let out = ''
    let err = ''
    const vege = (r: BashEredmeny): void => {
      if (lezart) return
      lezart = true
      resolve(r)
    }

    let ch
    try {
      ch = spawn('bash', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      vege({ code: null, stdout: '', stderr: '', error: (e as Error).message })
      return
    }

    ch.stdout?.on('data', (d) => { if (out.length < MAX_STDOUT) out += String(d) })
    ch.stderr?.on('data', (d) => { if (err.length < MAX_STDERR) err += String(d) })

    // Sajat ora: a `spawn`-nak nincs olyan `timeout`-ja, mint a sync valtozatnak.
    const ora = setTimeout(() => {
      try { ch.kill('SIGKILL') } catch { /* mar halott */ }
      vege({ code: null, stdout: out, stderr: err, error: `timeout ${timeoutMs}ms` })
    }, timeoutMs)

    ch.on('error', (e) => {
      clearTimeout(ora)
      vege({ code: null, stdout: out, stderr: err, error: e.message })
    })
    ch.on('close', (code) => {
      clearTimeout(ora)
      vege({ code, stdout: out, stderr: err })
    })
  })
}
