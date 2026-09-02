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
 * mi fogyasztja, vagy hogy NEM LÁTTUNK ODA (olvashatatlan ágens-mappa). Négy
 * eset, négy külön mondat, ezért a válasz nem egy szám, hanem:
 * `agents` + `featureKeys` + `known` + `blind`/`rosterOk`. A felület soha nem a
 * lista hosszából következtet.
 *
 * Fájl-alapú, hálózat nélkül, korlátos munka -- ugyanaz a szerződés, mint a
 * default-login-dependents.ts-nél.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { AGENTS_BASE_DIR, readAgentModel } from './agent-config.js'
import { resolveOpenRouterModel, AUTO_PREFIX } from './openrouter-models.js'
import { isGlmModel, GLM_VAULT_KEY } from './glm-models.js'

/** Vault-azonosítók egy helyen, hogy a string ne szóródjon szét a kódban. */
export const OPENROUTER_VAULT_KEY = 'openrouter-fleet-key'
export const DEEPSEEK_VAULT_KEY = 'DEEPSEEK_API_KEY'
export const GROQ_VAULT_KEY = 'groq-stt-key'

export interface KeyServiceImpact {
  vaultId: string
  /** false = nem tudjuk, mi használja. NEM azonos a "senki"-vel. */
  known: boolean
  /** Nevek, nem darabszám: a "két ügynök" nem mondja meg, hogy a tiéd benne van-e. */
  agents: string[]
  /** i18n-kulcsok azokról a NEM ágens hatásokról, amiket ez a kulcs kiszolgál. */
  featureKeys: string[]
  /** Régi mező, hogy egy nyitva felejtett lap se maradjon néma. featureKeys[0]. */
  featureKey: string | null
  /** Hány ágensbe nem láttunk bele. 0 = mindegyiket megnéztük. */
  blind: number
  /** false = az ágens-mappát magát nem tudtuk beolvasni. Ilyenkor a 0 semmit nem jelent. */
  rosterOk: boolean
}

export interface AgentRoster {
  models: Array<{ name: string; model: string }>
  blind: number
  rosterOk: boolean
}

/**
 * MELYIK KULCS KELL EHHEZ A MODELLHEZ -- egyetlen helyen.
 *
 * A sorrend és a feltételek SZÁNDÉKOSAN ugyanazok, mint amivel az indító
 * (agent-process.ts) választ szolgáltatót. Ha a kettő szétcsúszik, az előnézet
 * másról beszél, mint ami valójában megáll, az önellenőrző sor meg rossz
 * ágensre mutat. Ezt teszt köti össze.
 *
 * `null` = ehhez a modellhez NEM kell beillesztett kulcs (Claude-előfizetés
 * vagy helyi Ollama). A "nincs kulcs" itt nem hiba, hanem a normális eset.
 */
export function requiredKeyForModel(model: string): string | null {
  const m = (model ?? '').trim()
  if (m === '') return null
  if (m.startsWith('claude-')) return null
  if (m.startsWith('deepseek-')) return DEEPSEEK_VAULT_KEY
  if (isGlmModel(m)) return GLM_VAULT_KEY
  // Az `openrouter-auto:` előtag feloldás ELŐTT is OpenRouter -- ha egy hívó
  // elfelejtette feloldani, akkor sem eshet a helyi Ollama-ágra.
  if (m.startsWith(AUTO_PREFIX)) return OPENROUTER_VAULT_KEY
  if (m.includes('/')) return OPENROUTER_VAULT_KEY
  return null
}

/**
 * Melyik kulcson NEM (csak) ágens lóg, hanem egy funkció.
 *
 * Enélkül a Groq-kulcs kivétele "0 ágens áll meg" volna, vagyis "nyugodtan
 * töröld" -- pedig a hangüzenetek átírása múlik rajta. Az OpenRouter-kulcson
 * ágensek ÉS funkciók is lógnak (levélfordítás, modell-tükrözés), ezért lista
 * és nem egyetlen kulcs.
 */
const FEATURE_KEYS: Record<string, string[]> = {
  [GROQ_VAULT_KEY]: ['acchub.key_impact.groq_stt'],
  [OPENROUTER_VAULT_KEY]: ['acchub.key_impact.openrouter_feature'],
}

/** Amit modell-oldalról ismerünk. A FEATURE_KEYS-szel együtt adja az "ismert" halmazt. */
const KEY_SERVICE_IDS = new Set([GLM_VAULT_KEY, DEEPSEEK_VAULT_KEY, OPENROUTER_VAULT_KEY])

/** Ismerjük-e egyáltalán ezt a kulcsot? */
export function isKnownKeyService(vaultId: string): boolean {
  return KEY_SERVICE_IDS.has(vaultId) || vaultId in FEATURE_KEYS
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
  roster: { blind: number; rosterOk: boolean } = { blind: 0, rosterOk: true },
): KeyServiceImpact {
  const featureKeys = FEATURE_KEYS[vaultId] ?? []
  const modelSide = KEY_SERVICE_IDS.has(vaultId)
  const blind = roster.blind
  const rosterOk = roster.rosterOk
  if (!modelSide && featureKeys.length === 0) {
    // Nem ismerjük. Ilyenkor a HALLGATÁS a rossz válasz: az üres lista
    // "semmi nem áll meg"-nek olvasódna, holott csak nem láttunk oda.
    return { vaultId, known: false, agents: [], featureKeys: [], featureKey: null, blind, rosterOk }
  }
  const agents = modelSide
    ? agentModels.filter(a => requiredKeyForModel(a.model) === vaultId).map(a => a.name)
    : []
  return {
    vaultId,
    known: true,
    agents,
    featureKeys,
    featureKey: featureKeys[0] ?? null,
    blind,
    rosterOk,
  }
}

/**
 * Minden ágens (a fő ágenssel együtt) és a feloldott modellje.
 *
 * SZÁNDÉKOSAN nem a dashboard névsorát használja: az elrejti a technikai
 * ágenseket (`.hidden-from-dashboard` sentinel). Egy rejtett ágens is éget
 * kulcsot és le is áll a kulcs kivételétől -- attól, hogy a dashboardon nem
 * látszik, a törlés még megállítja. A rejtés megjelenítési döntés, nem
 * hatás-döntés, ezért itt a mappát magát járjuk be.
 *
 * A `blind`/`rosterOk` a nulla két jelentését választja szét: ha az
 * ágens-mappát nem tudjuk beolvasni, az üres lista NEM azt jelenti, hogy
 * senki nem használja.
 */
export function allAgentModels(): AgentRoster {
  const out: Array<{ name: string; model: string }> = []
  let blind = 0
  let names: string[] = []
  let rosterOk = true
  if (existsSync(AGENTS_BASE_DIR)) {
    try {
      names = readdirSync(AGENTS_BASE_DIR).filter(f => {
        try {
          return statSync(join(AGENTS_BASE_DIR, f)).isDirectory()
        } catch {
          blind++
          return false
        }
      })
    } catch {
      // Nem láttunk oda. Friss telepítésen a mappa HIÁNYZIK (az a rendben lévő
      // eset, fentebb kezelve); itt a mappa létezik, de nem olvasható.
      rosterOk = false
    }
  }
  for (const name of [MAIN_AGENT_ID, ...names]) {
    try {
      out.push({ name, model: resolveOpenRouterModel(readAgentModel(name)) })
    } catch {
      blind++
    }
  }
  return { models: out, blind, rosterOk }
}

/** A lemezes változat: ezt hívja a route. */
export function keyServiceImpact(vaultId: string): KeyServiceImpact {
  const roster = allAgentModels()
  return impactOfRemoving(vaultId, roster.models, roster)
}
