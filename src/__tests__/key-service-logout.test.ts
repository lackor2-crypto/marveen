// Kulcsos szolgáltatások ki- és bejelentkeztetése.
//
// Boss, 2026-09-02: "mi az, hogy nem lehet kijelentkeztetni egy fiokot? meg
// bejelentkeztetni". A sor eddig csak állapotot mutatott, gomb nélkül.
//
// Két dolgot köt le ez a fájl, és egyik sem stílus-kérdés:
//
// 1. A KULCS KIVÉTELE VISSZAFORDÍTHATATLAN. A régi érték nem jön vissza, tehát
//    a törlés előtt látszania kell, mit állít meg -- ugyanaz a kapu, mint a
//    Claude-kijelentkezésnél. Ha egy későbbi szerkesztés az előnézetet
//    kihagyja, az itt bukik el, nem élesben.
//
// 2. A NULLA KÉT DOLGOT JELENTHET. Az üres ágens-lista jelentheti, hogy tényleg
//    senki nem használja -- de jelentheti azt is, hogy nem ágens használja
//    (Groq), vagy hogy nem ismerjük a kulcsot. A három eset három külön
//    mondatot kap; a `known` mező az, ami elválasztja a "senki"-t a "nem látok
//    oda"-tól.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { impactOfRemoving, isKnownKeyService } from '../web/key-service-dependents.js'
import { GLM_VAULT_KEY } from '../web/glm-models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')
const APP_JS = readFileSync(join(SRC, '..', 'web', 'app.js'), 'utf-8')

// Egy vegyes flotta: minden szolgáltatóból egy, hogy a szűrés hibája kilógjon.
const FLEET = [
  { name: 'marvin', model: 'claude-opus-5' },
  { name: 'glm-agens', model: 'glm-5.3' },
  { name: 'glm-gyors', model: 'glm-5.3-flash' },
  { name: 'deepseek-agens', model: 'deepseek-v4-pro' },
  { name: 'or-agens', model: 'meta-llama/llama-4-70b' },
  { name: 'helyi', model: 'qwen3.6:27b' },
]

describe('kit állít meg egy kulcs kivétele', () => {
  it('a GLM-kulcs pontosan a GLM-ágenseket viszi', () => {
    const impact = impactOfRemoving(GLM_VAULT_KEY, FLEET)
    expect(impact.known).toBe(true)
    expect(impact.agents).toEqual(['glm-agens', 'glm-gyors'])
  })

  it('az OpenRouter-kulcs nem viszi el a GLM-et, a DeepSeeket és a Claude-ot', () => {
    // Ez a valódi veszély: a GLM-modell nem tartalmaz '/'-t, de ha valaki a
    // feltételt lazítja, a GLM-ágens az OpenRouter előnézetében is megjelenne,
    // és a Boss egy rossz listát látna a törlés előtt.
    const impact = impactOfRemoving('openrouter-fleet-key', FLEET)
    expect(impact.agents).toEqual(['or-agens'])
  })

  it('a DeepSeek-kulcs csak a DeepSeek-ágenst viszi', () => {
    expect(impactOfRemoving('DEEPSEEK_API_KEY', FLEET).agents).toEqual(['deepseek-agens'])
  })

  it('a helyi (Ollama) ágenst egyik kulcs sem viszi', () => {
    for (const id of [GLM_VAULT_KEY, 'openrouter-fleet-key', 'DEEPSEEK_API_KEY', 'groq-stt-key']) {
      expect(impactOfRemoving(id, FLEET).agents).not.toContain('helyi')
    }
  })
})

describe('a nulla két dolgot jelenthet', () => {
  it('a Groq-kulcson nem ágens lóg, hanem egy funkció -- és ezt meg is mondja', () => {
    // Enélkül a Groq kivétele "0 ágens áll meg" volna, vagyis "nyugodtan
    // töröld" -- pedig a hangüzenetek átírása múlik rajta.
    const impact = impactOfRemoving('groq-stt-key', FLEET)
    expect(impact.known).toBe(true)
    expect(impact.agents).toEqual([])
    expect(impact.featureKey).toBe('acchub.key_impact.groq_stt')
  })

  it('ismeretlen kulcsnál NEM mondja azt, hogy senki nem használja', () => {
    const impact = impactOfRemoving('valami-ismeretlen-kulcs', FLEET)
    expect(impact.known).toBe(false)
    expect(impact.agents).toEqual([])
    expect(impact.featureKey).toBe(null)
  })

  it('üres flottánál a GLM-kulcs ismert marad, csak nincs kit megállítania', () => {
    // "Ismerem és senki nem használja" != "nem tudom, mi használja".
    const impact = impactOfRemoving(GLM_VAULT_KEY, [])
    expect(impact.known).toBe(true)
    expect(impact.agents).toEqual([])
  })

  it('az ismertség kérdezhető külön is', () => {
    expect(isKnownKeyService(GLM_VAULT_KEY)).toBe(true)
    expect(isKnownKeyService('groq-stt-key')).toBe(true)
    expect(isKnownKeyService('nincs-ilyen')).toBe(false)
  })
})

describe('a besorolás nem csúszhat el az indítótól', () => {
  const launcher = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')

  it('az indító ugyanazzal a három feltétellel válogat', () => {
    // Ha az indító feltételei megváltoznak, az előnézet MÁSRÓL beszélne, mint
    // ami valójában megáll. Ez a teszt a drift ellen szól: a két hely
    // szövegszerű egyezését nem tudjuk kikényszeríteni, de azt igen, hogy
    // mindkettőben ott legyen a három megkülönböztetés.
    expect(launcher).toContain("model.startsWith('claude-')")
    expect(launcher).toContain("model.startsWith('deepseek-')")
    expect(launcher).toContain('isGlmModel(model)')
    const dependents = readFileSync(join(SRC, 'web', 'key-service-dependents.ts'), 'utf-8')
    expect(dependents).toContain("m.startsWith('claude-')")
    expect(dependents).toContain("m.startsWith('deepseek-')")
    expect(dependents).toContain('isGlmModel(m)')
  })
})

describe('a felületen tényleg ott a két gomb', () => {
  it('a kulcs-sor be- és kijelentkeztető gombot is kap', () => {
    expect(APP_JS).toContain('acc-key-login')
    expect(APP_JS).toContain('acc-key-logout')
    expect(APP_JS).toContain('acchub.key_login_btn')
    expect(APP_JS).toContain('acchub.key_logout_btn')
  })

  it('a bejelentkezés a MEGLÉVŐ kulcs-űrlapot nyitja meg, arra a szolgáltatásra', () => {
    // Nem új űrlap: a lap már tud kulcsot fogadni, csak meg kellett keresni a
    // legördülőben. A gomb odaviszi ÉS kiválasztja.
    const fn = APP_JS.match(/function _accKeyLogin\([\s\S]*?\n}/)?.[0] ?? ''
    expect(fn).not.toBe('')
    expect(fn).toContain("sel.value = 'key:' + vaultId")
    expect(fn).toContain('_claudeAuthSyncServiceUi()')
    expect(fn).toContain('details.open = true')
  })
})

describe('törölni csak előnézet után lehet', () => {
  const fn = APP_JS.match(/async function _accKeyLogout\([\s\S]*?\n}/)?.[0] ?? ''

  it('a kijelentkeztető függvény megvan', () => {
    expect(fn).not.toBe('')
  })

  it('előbb kérdez, aztán töröl -- ebben a sorrendben', () => {
    const preview = fn.indexOf('/api/accounts/key/impact')
    const confirmAt = fn.indexOf('confirm(')
    const del = fn.indexOf("method: 'DELETE'")
    expect(preview).toBeGreaterThan(-1)
    expect(confirmAt).toBeGreaterThan(preview)
    expect(del).toBeGreaterThan(confirmAt)
  })

  it('elbukott előnézet nem válhat némán törléssé', () => {
    // A `catch` elnyeli a hálózati hibát, ezért a `!impact.ok` ág KELL: enélkül
    // a null-ból "nincs kit megállítani" lenne, és a törlés kérdés nélkül menne.
    expect(fn).toContain('!impact || !impact.ok')
    expect(fn).toContain('acchub.key_impact_failed')
    const fail = fn.indexOf('acchub.key_impact_failed')
    const del = fn.indexOf("method: 'DELETE'")
    expect(fail).toBeLessThan(del)
  })

  it('a nemleges válasz megállítja', () => {
    expect(fn).toContain('if (!confirm(msg)) return')
  })

  it('mind a négy esetre külön mondat jut', () => {
    for (const key of [
      'acchub.key_logout_confirm_unknown',
      'acchub.key_logout_confirm_agents',
      'acchub.key_logout_confirm_feature',
      'acchub.key_logout_confirm_none',
    ]) {
      expect(fn).toContain(key)
    }
  })

  it('az ismeretlen esetet a lista hossza ELŐTT dönti el', () => {
    // Ha a sorrend megfordul, egy ismeretlen kulcs a "senki nem használja"
    // mondatot kapná -- pont az a hamis megnyugtatás, ami ellen a mező van.
    expect(fn.indexOf('!impact.known')).toBeLessThan(fn.indexOf('agents.length'))
  })

  it('ha ágens IS és funkció IS lóg rajta, mindkettőt kimondja', () => {
    // Az OpenRouter-kulcson akkor is dolgozik a levél-fordítás és a
    // modell-összemérés, ha épp egy ágens is fut rajta. A régi lánc az első
    // találatnál megállt, és a funkciót elhallgatta.
    expect(fn).toContain('acchub.key_logout_confirm_both')
    const both = fn.indexOf('acchub.key_logout_confirm_both')
    const csakAgens = fn.indexOf('acchub.key_logout_confirm_agents')
    expect(both).toBeLessThan(csakAgens)
  })

  it('a tömbös featureKeys mellett a régi mezőre is visszaesik', () => {
    // Egy meg nem frissített (nyitva felejtett) oldal se essen vissza némán a
    // "senki nem használja" mondatra egy frissebb szerver mellett.
    expect(fn).toContain('Array.isArray(impact.featureKeys)')
    expect(fn).toContain('impact.featureKey')
  })

  it('a hiányos ágens-lista figyelmeztetést kap a kérdés ELŐTT', () => {
    // A NULLA KÉT DOLOG. Ha egy ágenshez nem tudtunk odanézni, a felsorolás
    // hiányos lehet -- ezt a törlés előtt kell kimondani, nem utána.
    expect(fn).toContain('impact.rosterOk === false')
    expect(fn).toContain('acchub.key_logout_blind_note')
    expect(fn.indexOf('acchub.key_logout_blind_note')).toBeLessThan(fn.indexOf('if (!confirm(msg)) return'))
  })

  it('a törlés a meglévő vault-úton megy, nem egy másodikon', () => {
    expect(fn).toContain("'/api/vault/' + encodeURIComponent(vaultId)")
  })
})

describe('mindkét nyelv leírja', () => {
  const KEYS = [
    'acchub.key_login_btn',
    'acchub.key_replace_btn',
    'acchub.key_logout_btn',
    'acchub.key_impact_failed',
    'acchub.key_logout_confirm_agents',
    'acchub.key_logout_confirm_feature',
    'acchub.key_logout_confirm_none',
    'acchub.key_logout_confirm_unknown',
    'acchub.key_logout_confirm_both',
    'acchub.key_logout_blind_note',
    'acchub.key_logout_done',
    'acchub.key_impact.groq_stt',
    'acchub.key_impact.openrouter_feature',
  ]

  for (const lang of ['hu.js', 'en.js']) {
    it(`${lang}: minden kulcs megvan`, () => {
      const src = readFileSync(join(SRC, '..', 'web', 'lang', lang), 'utf-8')
      for (const k of KEYS) expect(src).toContain(`'${k}'`)
    })
  }

  it('a bevezető már nem állítja, hogy nincs mit leválasztani', () => {
    // A régi szöveg ("olyan szolgáltatások, amiknél nincs mit leválasztani")
    // pont azt tanította a felhasználónak, amit a Boss kifogásolt.
    const hu = readFileSync(join(SRC, '..', 'web', 'lang', 'hu.js'), 'utf-8')
    expect(hu).not.toContain('nincs mit leválasztani')
  })
})
