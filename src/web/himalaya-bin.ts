// A himalaya (email-kliens) helye -- NEM egy fix ut (#358, friss telepites).
//
// Linuxon a telepito a ~/.local/bin-be tolti le (nincs hozza rendszercsomag),
// macOS-en viszont `brew install himalaya` rakja fel, vagyis /opt/homebrew/bin
// (Apple Silicon) vagy /usr/local/bin (Intel) ala. A korabbi fix
// `~/.local/bin/himalaya` ut macOS-en ENOENT-tel bukott: a Kulso programok
// lista (system-deps.ts, ami a PATH-on is keres) "telepitve"-t mutatott,
// kozben az Email oldal egyetlen levelet sem tudott megnyitni.
//
// Sorrend: MARVEEN_HIMALAYA, a telepito sajat helye, majd a PATH + az ismert
// telepitesi mappak (platform.ts) -- ugyanaz a minta, mint az rcloneBin()-nel.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tryResolveFromPath } from '../platform.js'

export interface HimalayaBinDeps {
  env: NodeJS.ProcessEnv
  exists: (p: string) => boolean
  resolve: (name: string) => string | null
  home: string
}

const realDeps = (): HimalayaBinDeps => ({
  env: process.env,
  exists: existsSync,
  resolve: tryResolveFromPath,
  home: homedir(),
})

/**
 * A himalaya abszolut utja. Ha sehol nincs meg, a telepito sajat helyet adja
 * vissza: a hivo ekkor a valodi ENOENT-hibat kapja (az utvonallal), nem egy
 * kitalalt "nincs levele" allapotot.
 */
export function findHimalayaBin(deps: HimalayaBinDeps = realDeps()): { path: string; found: boolean } {
  const local = join(deps.home, '.local', 'bin', 'himalaya')
  const env = deps.env.MARVEEN_HIMALAYA
  if (env) return { path: env, found: deps.exists(env) }
  if (deps.exists(local)) return { path: local, found: true }
  const onPath = deps.resolve('himalaya')
  if (onPath) return { path: onPath, found: true }
  return { path: local, found: false }
}

let cached: string | null = null

/** Megtalalt utat megjegyzi; a hianyt NEM, hogy egy utolagos telepites restart nelkul is eletbe lepjen. */
export function himalayaBin(): string {
  if (cached) return cached
  const r = findHimalayaBin()
  if (r.found) cached = r.path
  return r.path
}
