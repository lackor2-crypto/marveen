// A GLM-beépítés hibakeresésének és hatásvizsgálatának eredménye.
//
// Boss, 2026-09-02: "csinalj erre az egesz glm implementalasra bugkeresest es
// hatasvizsgalatot. jo melyen es szelesen."
//
// Minden itteni teszt EGY megtalált hibához tartozik, és mindegyik olyan
// hibához, ami HIBAÜZENET NÉLKÜL tud elromlani -- ezért nem elég megjavítani,
// meg is kell fogni, hogy ne jöhessen vissza:
//
//  1. A kártya jelvénye MINDEN nem-Claude ágensre "OpenRouter"-t írt ki. Egy
//     GLM-ágensről tehát azt állította, hogy egy másik (token-alapon
//     számlázott) szolgáltató alatt fut -- pont az az összemosás, ami miatt a
//     GLM egyáltalán külön útra került.
//  2. Kulcs nélküli GLM/DeepSeek/OpenRouter ágens ELINDUL, üres tokennel, és a
//     401 csak a saját tmux-paneljében látszik. A kijelentkeztető gomb óta ezt
//     az állapotot két kattintással elő lehet állítani, tehát az önellenőrzésnek
//     ki kell mondania.
//  3. Az OpenRouter-kulcs törlés-előnézete "0 ágens" esetén azt mondta, semmi
//     nem áll meg -- holott a levél-fordítás és a modell-összemérés is rajta van.
//  4. A törlés-előnézet a rejtett (sentinel) ágenseket kihagyta a listából,
//     pedig azok is fogyasztják a kulcsot.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { requiredKeyForModel, impactOfRemoving, OPENROUTER_VAULT_KEY, DEEPSEEK_VAULT_KEY } from '../web/key-service-dependents.js'
import { providerKeyRows } from '../web/system-health.js'
import { GLM_VAULT_KEY } from '../web/glm-models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')
const APP_JS = readFileSync(join(SRC, '..', 'web', 'app.js'), 'utf-8')

describe('1. a jelvény nem állíthat rosszat a szolgáltatóról', () => {
  const fn = APP_JS.match(/function providerBadgeLabel\([\s\S]*?\n}/)?.[0] ?? ''

  it('a függvény megvan, és a modellből dönt', () => {
    expect(fn).not.toBe('')
    expect(fn).toContain("m.startsWith('glm-')")
    expect(fn).toContain('GLM (Z.ai)')
    expect(fn).toContain('DeepSeek')
  })

  it('a GLM-et az OpenRouter ÉS az Ollama ág ELŐTT dönti el', () => {
    // A `glm-5.3`-ban nincs '/', tehát ha a sorrend megfordul, a GLM-ágens
    // "helyi modell" (vagy OpenRouter) jelvényt kapna. Ugyanaz a sorrend-hiba,
    // ami az indítóban a localhost:11434-re küldte volna.
    expect(fn.indexOf("m.startsWith('glm-')")).toBeLessThan(fn.indexOf("m.includes('/')"))
    expect(fn.indexOf("m.startsWith('glm-')")).toBeLessThan(fn.indexOf('account_badge_local'))
  })

  it('a kártya át is adja a modellt -- különben a jelvény sosem tudná', () => {
    expect(APP_JS).toContain('accountBadgeHtml(agent.claudePlan, false, agent.model, agent.authMode)')
  })

  it('a súgó már nem csak Claude-ot és OpenRoutert emleget', () => {
    for (const nyelv of ['hu', 'en']) {
      const s = readFileSync(join(SRC, '..', 'web', 'lang', `${nyelv}.js`), 'utf-8')
      const sor = s.split('\n').find(l => l.includes("'agents.account_badge_tip'")) ?? ''
      expect(sor, nyelv).toContain('GLM')
    }
  })
})

describe('2. kulcs nélküli ágens nem maradhat néma', () => {
  const roster = (models: Array<{ name: string; model: string }>, blind = 0, rosterOk = true) =>
    () => ({ models, blind, rosterOk })

  it('friss telepítésen HALLGAT (nincs saját kulcsos ágens)', () => {
    // Se piros, se zöld: ha nincs ilyen ágens, ez a sor nem tartozik semmire.
    expect(providerKeyRows(roster([{ name: 'marveen', model: 'claude-opus-5' }]), () => false)).toEqual([])
    expect(providerKeyRows(roster([]), () => false)).toEqual([])
  })

  it('hiányzó kulcsnál PIROS, és megnevezi az ágenst', () => {
    const r = providerKeyRows(roster([
      { name: 'marveen', model: 'claude-opus-5' },
      { name: 'glm-agens', model: 'glm-5.3' },
    ]), () => false)
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('bad')
    expect(r[0].id).toBe('provider_key_missing')
    // Nevek, nem darabszám: az "1 ágens" nem mondja meg, hogy melyik.
    expect(String(r[0].params.names)).toContain('glm-agens')
    expect(String(r[0].params.keys)).toContain(GLM_VAULT_KEY)
  })

  it('meglévő kulcsnál ZÖLD sort ad (a némaság itt nem elég)', () => {
    const r = providerKeyRows(roster([{ name: 'glm-agens', model: 'glm-5.3' }]), () => true)
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('ok')
    expect(r[0].params.n).toBe(1)
  })

  it('a Claude- és a helyi ágens nem kerül a számba', () => {
    const r = providerKeyRows(roster([
      { name: 'a', model: 'claude-sonnet-5' },
      { name: 'b', model: 'qwen3.6:27b' },
      { name: 'c', model: 'deepseek-v4-pro' },
    ]), () => true)
    expect(r[0].params.n).toBe(1)
  })

  it('ha nem látok oda, NEM mondom rendben lévőnek', () => {
    // A NULLA KÉT DOLGOT JELENTHET: se a hallgatás, se a zöld nem jár ilyenkor.
    expect(providerKeyRows(roster([{ name: 'a', model: 'glm-5.3' }], 0, false), () => true)[0].id)
      .toBe('provider_key_blind')
    expect(providerKeyRows(roster([{ name: 'a', model: 'glm-5.3' }], 1, true), () => true)[0].id)
      .toBe('provider_key_blind')
    expect(providerKeyRows(() => { throw new Error('olvashatatlan') }, () => true)[0].id)
      .toBe('provider_key_blind')
    expect(providerKeyRows(roster([{ name: 'a', model: 'glm-5.3' }]), () => { throw new Error('vault') })[0].id)
      .toBe('provider_key_blind')
  })

  it('az üres kulcs ugyanaz, mint a hiányzó', () => {
    // A Vaultban ott lehet a bejegyzés üres értékkel; az indító ilyenkor is
    // üres tokennel indul. A sor a VALÓS állapotot mutassa, ne a bejegyzést.
    const rows = providerKeyRows(roster([{ name: 'a', model: 'glm-5.3' }]), id => id === 'soha')
    expect(rows[0].id).toBe('provider_key_missing')
  })

  it('a sor be van kötve az Áttekintés önellenőrzésébe', () => {
    const sh = readFileSync(join(SRC, 'web', 'system-health.ts'), 'utf-8')
    expect(sh).toContain('...providerKeyRows(),')
  })
})

describe('3. a törlés-előnézet nem hallgathatja el a funkciókat', () => {
  it('az OpenRouter-kulcson ágens NÉLKÜL is lóg valami', () => {
    const impact = impactOfRemoving(OPENROUTER_VAULT_KEY, [])
    expect(impact.known).toBe(true)
    expect(impact.agents).toEqual([])
    expect(impact.featureKeys).toContain('acchub.key_impact.openrouter_feature')
  })

  it('ágenssel EGYÜTT is megmarad a funkció-mondat', () => {
    const impact = impactOfRemoving(OPENROUTER_VAULT_KEY, [{ name: 'or', model: 'meta-llama/llama-4-70b' }])
    expect(impact.agents).toEqual(['or'])
    expect(impact.featureKeys.length).toBeGreaterThan(0)
  })

  it('a régi mező a tömb első elemét adja vissza', () => {
    const impact = impactOfRemoving('groq-stt-key', [])
    expect(impact.featureKey).toBe(impact.featureKeys[0])
  })
})

describe('4. a vakság átmegy az előnézetre', () => {
  it('alapból nem vak, és a hívó felülírhatja', () => {
    const alap = impactOfRemoving(GLM_VAULT_KEY, [])
    expect(alap.blind).toBe(0)
    expect(alap.rosterOk).toBe(true)
    const vak = impactOfRemoving(GLM_VAULT_KEY, [], { blind: 2, rosterOk: false })
    expect(vak.blind).toBe(2)
    expect(vak.rosterOk).toBe(false)
  })

  it('a rejtett ágenseket is számba veszi a névsor', () => {
    // A `listAgentNames()` szándékosan elrejti a sentinellel jelölt technikai
    // ágenseket a felületről -- de egy rejtett ágens ugyanúgy elfogyasztja a
    // kulcsot, tehát a TÖRLÉS előtti listából nem maradhat ki.
    const s = readFileSync(join(SRC, 'web', 'key-service-dependents.ts'), 'utf-8')
    expect(s).not.toContain('listAgentNames')
    expect(s).toContain('AGENTS_BASE_DIR')
  })
})

describe('5. a besorolás egyetlen helyen él', () => {
  it('minden szolgáltató a maga kulcsát kéri', () => {
    expect(requiredKeyForModel('glm-5.3')).toBe(GLM_VAULT_KEY)
    expect(requiredKeyForModel('glm-5.3-flash')).toBe(GLM_VAULT_KEY)
    expect(requiredKeyForModel('deepseek-v4-pro')).toBe(DEEPSEEK_VAULT_KEY)
    expect(requiredKeyForModel('meta-llama/llama-4-70b')).toBe(OPENROUTER_VAULT_KEY)
    // A `z-ai/glm-...` az OpenRouteren fut, TOKEN-alapon: az nem az előfizetés.
    expect(requiredKeyForModel('z-ai/glm-5v-turbo')).toBe(OPENROUTER_VAULT_KEY)
    expect(requiredKeyForModel('openrouter-auto:tier1')).toBe(OPENROUTER_VAULT_KEY)
    expect(requiredKeyForModel('claude-opus-5')).toBe(null)
    expect(requiredKeyForModel('qwen3.6:27b')).toBe(null)
    expect(requiredKeyForModel('')).toBe(null)
  })

  it('az indító ugyanazt a sorrendet használja', () => {
    const launcher = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')
    const glm = launcher.indexOf('isGlmModel(model)')
    const or = launcher.indexOf("model.includes('/')")
    expect(glm).toBeGreaterThan(-1)
    expect(glm).toBeLessThan(or)
  })
})

describe('6. Claude-hitelesítés nem mehet idegen végpontra', () => {
  const launcher = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')

  it('a flotta OAuth-tokenjét csak Claude-ágens kapja meg', () => {
    // Egy GLM/DeepSeek/OpenRouter ágens IDEGEN base URL-lel fut. Egy
    // Claude-hitelesítő adatot odaadni neki a legjobb esetben fölösleges.
    expect(launcher).toContain('if (!claudeConfigDir && needsFleetOauth && hasFleetOauthToken())')
  })

  it('a GLM a kulcsot AUTH_TOKEN-ben kapja, és az API_KEY-t kiüti', () => {
    // A Z.ai-integráció legtöbbet elrontott pontja: ANTHROPIC_API_KEY-ben a
    // kulcs 401-et ad, ami rossz kulcsnak látszik.
    expect(launcher).toContain('export ANTHROPIC_AUTH_TOKEN="${glmKey}" && unset ANTHROPIC_API_KEY')
  })
})

describe('7. a modell-legördülő nem írhatja felül a kiválasztást', () => {
  it('mindkét betöltést megvárja', () => {
    // A két betöltés ugyanazt a <select>-et írja. Ha a modell-lista ér be
    // másodikként, kitörli a kiválasztott <option>-t, a select az ELSŐ opcióra
    // ugrik, és a "Modell mentése" csendben más modellt mentene.
    expect(APP_JS).toContain('Promise.allSettled([loadAvailableModels(), loadOllamaModels()])')
  })

  it('közbeni ügynökváltásnál nem ír bele a másik ügynök mezőjébe', () => {
    expect(APP_JS).toContain('currentAgent !== agentAtModelLoad')
  })
})

describe('8. a GLM-tipp nem a lista hosszából következtet', () => {
  it('a szerver külön megmondja, be van-e kötve', () => {
    expect(APP_JS).toContain('data.glmConfigured === true')
  })
})

describe('9. friss klónon a telepítő nem eshet el a kulcs beírása után', () => {
  const setup = readFileSync(join(SRC, '..', 'scripts', 'setup.ts'), 'utf-8')

  it('a Vaultot a forrásból tölti be, nem a le sem fordított dist-ből', () => {
    // A `npm run setup` tsx-szel fut, build nélkül; a dist/ nincs a repóban.
    expect(setup).toContain("'../src/web/vault.js'")
    expect(setup).not.toMatch(/await import\('\.\.\/dist\/web\/vault\.js'\)/)
  })

  it('ha mégsem megy, megmondja -- nem hallgat és nem áll le', () => {
    expect(setup).toContain('A kulcsot nem tudtam a Vaultba menteni')
  })
})
