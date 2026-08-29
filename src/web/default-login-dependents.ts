/**
 * KIT állít meg valójában, ha a gép saját Claude-bejelentkezése elszáll?
 *
 * Boss, 2026-08-21, a varázsló szövegéről ("Ez a gép jelenleg NINCS
 * bejelentkezve. Emiatt egyik ügynök sem tud dolgozni."): "ez hamis allitas.
 * mert most is tudok veled dolgozni! csak a marvin nem dolgozik de attol mag a
 * tobiek tudnak!"
 *
 * Igaza volt, és pontosan az a hibafajta, amit a legnehezebb észrevenni: a
 * mondat MAGABIZTOS és HAMIS. A flottában két ágensnek saját Claude-fiókja van
 * (store/accounts/<id>, külön CLAUDE_CONFIG_DIR), a többi pedig nem is
 * Claude-modellt futtat, hanem OpenRouteren keresztül mást -- egyiküket sem
 * érinti a gép alapértelmezett bejelentkezése.
 *
 * Ezért ez a modul nem állít, hanem MEGSZÁMOL. A felület onnan veszi a
 * mondatot, tehát a szöveg nem tud elavulni attól, hogy valaki új fiókot köt
 * be vagy modellt vált.
 *
 * Egy ágens akkor és csak akkor függ az alapértelmezett bejelentkezéstől, ha
 * mindhárom igaz:
 *   1. nincs saját terve/config-könyvtára (resolveAgentConfigDir -> null),
 *   2. Claude-modellt futtat (a launcher is ezzel dönt: model.startsWith
 *      ('claude-') -- ami nem az, az Ollamára/OpenRouterre/DeepSeekre megy a
 *      saját kulcsával),
 *   3. nem saját API-kulccsal fut (authMode !== 'api').
 *
 * Fájl-alapú, hálózat nélkül, korlátos munka -- a system-health.ts szerződése.
 */
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentModel, readAgentAuthMode } from './agent-config.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { resolveOpenRouterModel } from './openrouter-models.js'

/**
 * A döntés maga, a lemeztől elválasztva -- ez az, amit tesztelni érdemes.
 *
 * A `model.startsWith('claude-')` nem itt kitalált szabály: pontosan ezzel
 * dönt az indító is (agent-process.ts), tehát nem tud kettéválni a kettő.
 */
export function dependsOnDefaultLogin(
  configDir: string | null,
  authMode: string,
  resolvedModel: string,
): boolean {
  if (configDir !== null) return false
  if (authMode === 'api') return false
  return resolvedModel.startsWith('claude-')
}

/** Az ágensek, amelyek a gép saját (~/.claude) bejelentkezését használják. */
export function defaultLoginDependents(): string[] {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  const out: string[] = []
  for (const name of names) {
    try {
      const configDir = resolveAgentConfigDir(name).configDir
      const model = resolveOpenRouterModel(readAgentModel(name))
      if (dependsOnDefaultLogin(configDir, readAgentAuthMode(name), model)) out.push(name)
    } catch { /* egy olvashatatlan ágens-konfig nem dönthet a mondatról */ }
  }
  return out
}

/**
 * KI hasznalja EZT a bejelentkezest -- nem csak a gep sajatjat.
 *
 * Boss, 2026-08-29: kijelentkeztetni is lehessen a feluletrol, de csak ugy,
 * hogy elotte LATSZIK, kit allit meg. Ugyanaz a szamolas, mint a gep sajat
 * bejelentkezesenel, csak nem a `null` config-konyvtarra, hanem a megadottra:
 * ha `configDir` null, ez pontosan a defaultLoginDependents() halmaza.
 */
export function agentsUsingLogin(configDir: string | null): string[] {
  const names = [MAIN_AGENT_ID, ...listAgentNames()]
  const out: string[] = []
  for (const name of names) {
    try {
      const own = resolveAgentConfigDir(name).configDir
      const model = resolveOpenRouterModel(readAgentModel(name))
      if (readAgentAuthMode(name) === 'api') continue
      if (!model.startsWith('claude-')) continue
      if (own !== configDir) continue
      out.push(name)
    } catch { /* egy olvashatatlan agens-konfig nem donthet a mondatrol */ }
  }
  return out
}

/** Az ágensek, amelyek EZ ALATT IS dolgoznak: saját fiók vagy más szolgáltató. */
export function unaffectedByDefaultLogin(): string[] {
  const dependents = new Set(defaultLoginDependents())
  return [MAIN_AGENT_ID, ...listAgentNames()].filter(n => !dependents.has(n))
}
