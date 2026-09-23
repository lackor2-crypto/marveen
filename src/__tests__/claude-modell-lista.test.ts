/**
 * Boss, 2026-09-23 (Telegram 1196): "Miert nincs es miert nem frissul, pedig a
 * Cloud mar kiadta az Opus 5.5-ot. Itt latszania kellene, tehat ez egy bug, nem
 * frissiti a listat."
 *
 * Ket kulon hiba volt mogotte, es ez a fajl mindkettot lezarja:
 *   (1) a Claude-lista OT helyen allt kezzel beirva, es mar egymasnak is
 *       ellentmondott -> egyetlen forras lett belole;
 *   (2) `rankModelTier` nem ismerte a Fable csaladot -> a legerosebb modellen
 *       futo agens kapta a legrosszabb rangot.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_IDS,
  claudeModelLabel,
  claudeModelOptions,
  claudeVersionRank,
  isKnownClaudeModel,
  newestKnownInFamily,
  parseClaudeModelId,
} from '../claude-models.js'
import { newerThanKnown, prettyName } from '../claude-model-discovery.js'
import { rankModelTier } from '../web/smartest-worker.js'
import { SETTINGS_REGISTRY, effectiveValueSet, registerDiscoveredClaudeModels, validateSettingValue } from '../config-registry.js'

const ROOT = join(__dirname, '..', '..')
const INDEX = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const AGENTS_ROUTE = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')

describe('a gondozott lista tartalmazza, amit Boss keresett', () => {
  it('az Opus 5.5 benne van -- ez volt a bejelentes', () => {
    expect(CLAUDE_MODEL_IDS).toContain('claude-opus-5-5')
  })

  it('az 1M kontextusu Opus 5.5 es a Fable 5.1 is benne van', () => {
    expect(CLAUDE_MODEL_IDS).toContain('claude-opus-5-5[1m]')
    expect(CLAUDE_MODEL_IDS).toContain('claude-fable-5-1')
  })

  it('a ket Opus kulon cimket kap -- Boss epp azt nem tudta eldonteni, melyik melyik', () => {
    const opusok = CLAUDE_MODELS.filter((m) => m.name === 'Opus 5.5')
    expect(opusok.length).toBe(2)
    const cimkek = opusok.map((m) => claudeModelLabel(m, 'hu'))
    expect(new Set(cimkek).size).toBe(2)
    for (const c of cimkek) expect(c).not.toBe('Opus 5.5')
  })

  it('minden bejegyzes KETNYELVU -- kepernyore kerul', () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.hu.length, m.id).toBeGreaterThan(0)
      expect(m.en.length, m.id).toBeGreaterThan(0)
      expect(claudeModelLabel(m, 'en')).toContain(m.en)
    }
  })

  it('nincs ket azonos azonosito', () => {
    expect(new Set(CLAUDE_MODEL_IDS).size).toBe(CLAUDE_MODEL_IDS.length)
  })
})

describe('EGY forras: a lista nem tud tobb helyen szetcsuszni', () => {
  it('a szerver a katalogusbol adja a Claude-listat, nem kezzel beirva', () => {
    expect(AGENTS_ROUTE).toContain('claudeModelOptions(nyelv)')
    // A regi, kezzel beirt tomb tobbe nem all a routeban.
    expect(AGENTS_ROUTE).not.toContain("{ id: 'claude-opus-5', label: 'Opus 5 (legújabb Opus)' }")
  })

  it('a HTML-ben egyetlen statikus Claude-option sincs', () => {
    expect(INDEX).not.toMatch(/<option value="claude-/)
  })

  it('a harom legordulo mindegyikenek van feltoltheto csoportja', () => {
    for (const id of ['agentModelClaudeGroup', 'claudeModelGroup', 'cbModelClaudeGroup']) {
      expect(INDEX, id).toContain(`id="${id}"`)
    }
  })

  it('a Beallitasok harom modell-kulcsa is a katalogusbol olvas', () => {
    const kulcsok = ['DEFAULT_AGENT_MODEL', 'WORKBENCH_MODEL', 'MAIN_AGENT_MODEL', 'CODE_MODEL']
    for (const k of kulcsok) {
      const def = SETTINGS_REGISTRY.find((d) => d.key === k)
      expect(def, k).toBeTruthy()
      for (const id of CLAUDE_MODEL_IDS) {
        expect(def!.valueSet, `${k} / ${id}`).toContain(id)
      }
    }
  })

  it('a korabban hianyzo sonnet-4-6 is ott van mind a harom kulcsnal', () => {
    // Ez a konkret azonosito hianyzott mind a harom valueSet-bol, mikozben a
    // masik ket lista ismerte -- ez volt a bizonyiteka, hogy a kezi szinkron
    // nem "elromlott", hanem strukturalisan nem tud mukodni.
    for (const k of ['DEFAULT_AGENT_MODEL', 'WORKBENCH_MODEL', 'MAIN_AGENT_MODEL']) {
      const def = SETTINGS_REGISTRY.find((d) => d.key === k)!
      expect(def.valueSet, k).toContain('claude-sonnet-4-6')
    }
  })
})

describe('a felulet a szerverbol tolti fel a legordulot', () => {
  it('van feltolto fuggveny, es a Kod-hid MEGVARJA, mielott erteket ad', () => {
    expect(APP).toContain('function fillClaudeModelGroups(')
    expect(APP).toContain('await ensureClaudeModelOptions(); model.value = cfg.CODE_MODEL')
  })

  it('a NULLA ket dolgot jelenthet: a "nem lattam oda" ki van mondva', () => {
    expect(APP).toContain('data.claudeCliSeen === false')
    expect(APP).toContain("t('agents.model.claude_cli_unseen')")
    expect(HU).toContain("'agents.model.claude_cli_unseen'")
    expect(EN).toContain("'agents.model.claude_cli_unseen'")
  })

  it('a nyelv a gyorsitotar resze -- nyelvvaltas utan nem maradnak magyar cimkek', () => {
    expect(APP).toContain('_elerhetoModellekNyelv')
  })
})

describe('FRISSULES: eszreveszi, ha a telepitett program tobbet tud nalunk', () => {
  it('a mar ismert azonositot nem kinalja fel ujra', () => {
    expect(newerThanKnown(CLAUDE_MODEL_IDS)).toEqual([])
  })

  it('egy REGEBBI modellt nem kinal fel -- kulonben a Haiku 3.5-ig mindent felhozna', () => {
    const regi = ['claude-opus-4-0', 'claude-sonnet-3-7', 'claude-haiku-3-5']
    expect(newerThanKnown(regi)).toEqual([])
  })

  it('egy UJABB modellt felkinal, es ad neki nevet', () => {
    const ki = newerThanKnown(['claude-opus-6', 'claude-sonnet-4-6'])
    expect(ki.map((m) => m.id)).toEqual(['claude-opus-6'])
    expect(ki[0].name).toBe('Opus 6')
    expect(prettyName('claude-opus-5-5')).toBe('Opus 5.5')
  })

  it('egy teljesen UJ csalad is atjut (nem nyeli el az ismeretlen csalad)', () => {
    // A `fable` mar ismert; egy meg ismeretlen csaladnal a `newestKnownInFamily`
    // -1-et ad, es akkor sem szabad elnyelni.
    expect(newestKnownInFamily('fable')).toBeGreaterThan(0)
    expect(newerThanKnown(['claude-fable-6']).map((m) => m.id)).toEqual(['claude-fable-6'])
  })

  it('a datumos vegzodes NEM alverzio', () => {
    // `claude-haiku-4-5-20251001` kulonben 4.20251001-nek latszana, es minden
    // masnal ujabbnak -- igy egy Haiku verne az Opust.
    expect(parseClaudeModelId('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', major: 4, minor: 5 })
    expect(claudeVersionRank('claude-haiku-4-5-20251001')).toBeLessThan(claudeVersionRank('claude-opus-5-5'))
  })

  it('ismeretlen szoveg nem tor el semmit', () => {
    expect(parseClaudeModelId('valami-mas')).toBeNull()
    expect(claudeVersionRank('valami-mas')).toBe(-1)
    expect(isKnownClaudeModel('valami-mas')).toBe(false)
    expect(prettyName('valami-mas')).toBe('valami-mas')
  })

  it('a felfedezett modellt a MENTES is elfogadja, nem csak a legordulo mutatja', () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'MAIN_AGENT_MODEL')!
    expect(validateSettingValue(def, 'claude-opus-9').ok).toBe(false)
    try {
      registerDiscoveredClaudeModels(['claude-opus-9'])
      expect(effectiveValueSet(def)).toContain('claude-opus-9')
      expect(validateSettingValue(def, 'claude-opus-9').ok).toBe(true)
      // Csak a Claude-modelleket felsorolo kulcsokat bovitjuk.
      const nyelv = SETTINGS_REGISTRY.find((d) => d.key === 'APP_LANG')
      if (nyelv) expect(effectiveValueSet(nyelv)).toEqual(nyelv.valueSet)
    } finally {
      registerDiscoveredClaudeModels([])
    }
  })

  it('a meres a boot resze, es a Beallitasok is megkapja az eredmenyet', () => {
    const web = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('scanInstalledClaude()')
    expect(web).toContain('registerDiscoveredClaudeModels(')
  })
})

describe('rankModelTier: a Fable csalad is a rangsorban van', () => {
  it('a Fable a legerosebb csalad', () => {
    expect(rankModelTier('claude-fable-5-1')).toBeGreaterThan(rankModelTier('claude-opus-5-5'))
    expect(rankModelTier('claude-opus-5-5')).toBeGreaterThan(rankModelTier('claude-sonnet-5'))
    expect(rankModelTier('claude-sonnet-5')).toBeGreaterThan(rankModelTier('claude-haiku-4-5-20251001'))
  })

  it('a MERT regresszio: a Fable 5.1 nem eshet a Haiku ala', () => {
    // Merve 2026-09-23-an a leforditott dist-ben: rankModelTier('claude-fable-5-1')
    // = 105, a Haiku 4.5 = 245, egy ingyenes OpenRouter modell = 103.
    expect(rankModelTier('claude-fable-5-1')).toBeGreaterThan(rankModelTier('claude-haiku-4-5-20251001'))
    expect(rankModelTier('claude-fable-5-1')).toBeGreaterThan(rankModelTier('deepseek/deepseek-chat-v3.1'))
  })

  it('MINDEN gondozott modell a nem-Claude modellek folott van', () => {
    for (const id of CLAUDE_MODEL_IDS) {
      expect(rankModelTier(id), id).toBeGreaterThan(rankModelTier('nvidia/nemotron-3-ultra-550b-a55b:free'))
    }
  })

  it('csaladon belul az ujabb verzio nyer', () => {
    expect(rankModelTier('claude-opus-5-5')).toBeGreaterThan(rankModelTier('claude-opus-5'))
    expect(rankModelTier('claude-opus-5')).toBeGreaterThan(rankModelTier('claude-opus-4-8[1m]'))
    expect(rankModelTier('claude-fable-5-1')).toBeGreaterThan(rankModelTier('claude-fable-5'))
  })
})

describe('a legordulo cimkei', () => {
  it('a magyar es az angol cimke is a modell nevevel kezdodik', () => {
    const hu = claudeModelOptions('hu')
    const en = claudeModelOptions('en')
    expect(hu.length).toBe(CLAUDE_MODELS.length)
    expect(en.length).toBe(CLAUDE_MODELS.length)
    for (let i = 0; i < hu.length; i++) {
      expect(hu[i].id).toBe(CLAUDE_MODELS[i].id)
      expect(hu[i].label.startsWith(CLAUDE_MODELS[i].name)).toBe(true)
      expect(en[i].label.startsWith(CLAUDE_MODELS[i].name)).toBe(true)
      expect(en[i].label).not.toBe(hu[i].label)
    }
  })
})

describe('a meres nem fizetteti meg magat ujra minden legordulo-nyitasnal', () => {
  it('a masodik hivas a memobol jon (nem indit alfolyamatot)', async () => {
    const { scanInstalledClaude, resetClaudeScanMemo } = await import('../claude-model-discovery.js')
    resetClaudeScanMemo()
    const elso = await scanInstalledClaude()
    const t0 = Date.now()
    const masodik = await scanInstalledClaude()
    expect(Date.now() - t0).toBeLessThan(50)
    expect(masodik).toBe(elso)
    resetClaudeScanMemo()
  })
})
