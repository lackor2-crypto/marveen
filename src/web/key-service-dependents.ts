/**
 * MI ÁLL MEG, ha egy beillesztett kulcsot kiveszünk?
 *
 * Boss, 2026-09-02: "nem értem, hogy miért nincs kijelentkezés gomb (...) Hogyha
 * például éppen ki akarom jelentkeztetni, akkor nem tudom. Akkor csak úgy ott
 * van és nem tudok vele mit csinálni. Hát ilyet ne csináljunk már."
 *
 * Igaza volt. A kulcsos szolgáltatások sora eddig CSAK állapotot mutatott
 * ("beállítva" / "nincs beállítva"), gomb nélkül -- a kód meg is indokolta
 * magának, hogy "a kulcs nem ember, ezért nincs mit leválasztani". Ez
 * önigazolás volt: a kulcs kivétele pontosan ugyanaz a művelet, mint egy fiók
 * kijelentkeztetése, csak más a mechanizmusa. Aki bekötötte, ki is akarja
 * tudni venni -- a felületről, terminál nélkül.
 *
 * Ez a modul a KIJELENTKEZTETÉS ELŐNÉZETE. Nem töröl semmit: megmondja, kit
 * érint. A Claude-oldalon ugyanez a szabály (agentsUsingLogin) már megvolt, és
 * ugyanaz az indoka: a törlés visszafordíthatatlan, tehát előtte LÁTSZANIA
 * kell, mit állít meg.
 *
 * A NULLA ITT KÉT DOLGOT JELENTHET, és ez a modul legfontosabb része.
 * Egy üres ágens-lista jelentheti azt, hogy tényleg senki nem használja -- de
 * jelentheti azt is, hogy ezt a kulcsot nem ágensek használják (a Groq-kulcson
 * a hangüzenet-átírás lóg, nem egy modell), vagy hogy egyszerűen NEM TUDJUK,
 * mi fogyasztja. A három eset háromféle mondatot érdemel, ezért a válasz nem
 * egy szám, hanem: `agents` + `featureKey` + `known`. A felület soha nem a
 * lista hosszából következtet.
 *
 * Fájl-alapú, hálózat nélkül, korlátos munka -- ugyanaz a szerződés, mint a
 * default-login-dependents.ts-nél.
 */
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentModel } from './agent-config.js'
import { resolveOpenRouterModel } from './openrouter-models.js'
import { isGlmModel } from './glm-models.js'

export interface KeyServiceImpact {
  vaultId: string
  /** false = nem tudjuk, mi használja. NEM azonos a "senki"-vel. */
  known: boolean
  /** Nevek, nem darabszám: a "két ügynök" nem mondja meg, hogy a tiéd benne van-e. */
  agents: string[]
  /** i18n-kulcs arról a NEM ágens hatásról, amit ez a kulcs kiszolgál. */
  featureKey: string | null
}

/**
 * Melyik kulcs melyik modellt szolgálja ki.
 *
 * A feltételek SZÁNDÉKOSAN ugyanazok, mint amivel az indító (agent-process.ts)
 * választ szolgáltatót -- ha a kettő szétcsúszik, az előnézet másról beszél,
 * mint ami valójában megáll. Ezt teszt köti össze.
 */
const MODEL_KEYS: Record<string, (model: string) => boolean> = {
  'zai-coding-key': m => isGlmModel(m),
  DEEPSEEK_API_KEY: m => m.startsWith('deepseek-'),
  'openrouter-fleet-key': m =>
    !m.startsWith('claude-') && !m.startsWith('deepseek-') && !isGlmModel(m) && m.includes('/'),
}

/**
 * Melyik kulcson NEM ágens lóg, hanem egy funkció.
 *
 * Enélkül a Groq-kulcs kivétele "0 ágens áll meg" volna, vagyis "nyugodtan
 * töröld" -- pedig a hangüzenetek átírása múlik rajta.
 */
const FEATURE_KEYS: Record<string, string> = {
  'groq-stt-key': 'acchub.key_impact.groq_stt',
}

/** Ismerjük-e egyáltalán ezt a kulcsot? */
export function isKnownKeyService(vaultId: string): boolean {
  return vaultId in MODEL_KEYS || vaultId in FEATURE_KEYS
}

/**
 * A döntés maga, lemez nélkül -- ez az, amit tesztelni érdemes.
 *
 * A modellek listáját a hívó adja (név -> feloldott modell), így ez a
 * függvény tiszta marad.
 */
export function impactOfRemoving(
  vaultId: string,
  agentModels: Array<{ name: string; model: string }>,
): KeyServiceImpact {
  const matches = MODEL_KEYS[vaultId]
  const featureKey = FEATURE_KEYS[vaultId] ?? null
  if (!matches && featureKey === null) {
    // Nem ismerjük. Ilyenkor a HALLGATÁS a rossz válasz: az üres lista
    // "semmi nem áll meg"-nek olvasódna, holott csak nem láttunk oda.
    return { vaultId, known: false, agents: [], featureKey: null }
  }
  const agents = matches ? agentModels.filter(a => matches(a.model)).map(a => a.name) : []
  return { vaultId, known: true, agents, featureKey }
}

/** Minden ágens (a fő ágenssel együtt) és a feloldott modellje. */
export function allAgentModels(): Array<{ name: string; model: string }> {
  const out: Array<{ name: string; model: string }> = []
  for (const name of [MAIN_AGENT_ID, ...listAgentNames()]) {
    try {
      out.push({ name, model: resolveOpenRouterModel(readAgentModel(name)) })
    } catch {
      /* egy olvashatatlan ágens-konfig nem dönthet a mondatról */
    }
  }
  return out
}

/** A lemezes változat: ezt hívja a route. */
export function keyServiceImpact(vaultId: string): KeyServiceImpact {
  return impactOfRemoving(vaultId, allAgentModels())
}
