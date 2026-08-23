// Rálát-e a dashboard a VS Code-projekt MAPPÁJÁRA -- és ha nem, miért nem.
//
// Ez a modul azért létezik külön, mert a kód-híd két gépen ül: a Claude Code a
// Windowson fut, Marveen (itt) a WSL-ben. A worker `F:\Marveen\...` alakban
// jelenti a workspace-t; ha a dashboard bele akar írni (skill-fájl), előbb le
// kell fordítania `/mnt/f/Marveen/...`-re, ÉS meg kell néznie, hogy tényleg
// odalát-e.
//
// ★ A NULLA KÉT DOLGOT JELENTHET. Egy `readdir` nulla találata itt kétféle
// dolgot takar: „még nincs egyetlen skill sem" vagy „nem látok oda". A kettőt
// NEM a találatok számából döntjük el, hanem megkérdezzük magát a forrást:
// létezik-e a mappa, és ha nem, mit mond az operációs rendszer. Ezért ad ez a
// függvény `reachable` + `reason` párost, és ezért a `reason` MINDIG a
// tényleges hibaüzenet -- sosem tipp. (2026-08-23-ig a code-bridge-store.ts
// fejlécében az állt, hogy a /mnt/c és /mnt/d minden hozzáférésre EIO-t ad;
// most mérve mindhárom meghajtó olvasható, tehát a jóslás helyett kizárólag a
// mérés dönthet.)

import { statSync } from 'node:fs'
import { platform } from 'node:os'
import { APP_LANG } from '../config.js'

// A `reason` a FELULETRE kerul, tehat ketnyelvunek kell lennie -- a szerverrol
// jovo cimke ugyanugy kepernyore kerulo szoveg, mint barmelyik gomb felirata.
// A telepites nyelvet hasznaljuk (`APP_LANG`), ugyanugy, mint a `life-tree.ts`
// mappanev-tablaja. (A Node sajat hibauzenete -- ENOENT/EACCES/EIO -- marad
// angolul: az a rendszer szo szerinti valasza, nem a mi mondatunk.)
const HU = APP_LANG === 'hu'

export type WorkspaceProbe = {
  /** Amit a worker jelentett, változatlanul (`F:\Marveen\...` vagy `/home/...`). */
  workspacePath: string
  /** Ugyanaz ennek a gépnek a szemével -- `null`, ha le sem tudtuk fordítani. */
  localPath: string | null
  /** Odalátunk-e TÉNYLEG. Nem következtetés: egy `statSync` mérte. */
  reachable: boolean
  /** A TÉNYLEGES ok, ha nem látunk oda. Sosem tipp; `null`, ha minden rendben. */
  reason: string | null
}

/** `F:\Marveen\X` -> `/mnt/f/Marveen/X`. Csak WSL/Linux alatt van értelme:
 *  Windowson maga az eredeti út a helyes, Linuxon meg nincs mit fordítani. */
export function toLocalWorkspacePath(windowsPath: string): string | null {
  const p = (windowsPath || '').trim()
  if (p === '') return null
  // Windowson a jelentett út MÁR a helyi út.
  if (platform() === 'win32') return p
  // Már POSIX alak (Linux-gépen futó Claude Code, vagy WSL-beli mappa).
  if (p.startsWith('/')) return p
  // UNC a WSL saját fájlrendszerére: `\\wsl.localhost\Ubuntu\home\boss\x`.
  const unc = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i)
  if (unc) return (unc[1] ?? '\\').replace(/\\/g, '/') || '/'
  // Meghajtóbetűs Windows-út.
  const drive = p.match(/^([A-Za-z]):[\\/](.*)$/)
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`
  // Hálózati megosztás vagy ismeretlen alak: nem találjuk ki, mi lenne.
  return null
}

/**
 * Odalát-e a dashboard erre a workspace-re. MÉR, nem következtet.
 *
 * A hívó ebből tudja megmondani a felhasználónak a kettő közül a helyeset:
 *   reachable && skills.length === 0  -> „még nincs egyetlen skill sem"
 *   !reachable                        -> „nem látok oda: <valódi ok>"
 */
export function probeWorkspace(workspacePath: string): WorkspaceProbe {
  const localPath = toLocalWorkspacePath(workspacePath)
  if (localPath === null) {
    return {
      workspacePath,
      localPath: null,
      reachable: false,
      // Ez NEM tipp: tényszerűen annyi történt, hogy az útnak nincs olyan
      // alakja, amit erről a gépről meg lehetne nyitni.
      reason: HU
        ? `Ezt az útvonalat innen nem lehet megnyitni: ${workspacePath}`
        : `This path cannot be opened from here: ${workspacePath}`,
    }
  }
  try {
    const st = statSync(localPath)
    if (!st.isDirectory()) {
      return {
        workspacePath, localPath, reachable: false,
        reason: HU ? `${localPath}: nem mappa` : `${localPath}: not a directory`,
      }
    }
    return { workspacePath, localPath, reachable: true, reason: null }
  } catch (err) {
    // A TÉNYLEGES hibaüzenet megy tovább (ENOENT / EACCES / EIO), mert a
    // következő lépés mindháromnál más. Találgatott ok rosszabb a semminél.
    return {
      workspacePath,
      localPath,
      reachable: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
