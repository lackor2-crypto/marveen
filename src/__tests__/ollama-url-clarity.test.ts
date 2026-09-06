// Kanban #136 (d9cb27ec). Ket dolgot ver le ez a fajl, mert egyik sem latszott
// semmilyen zold teszten:
//
// 1. A beallitas LEIRASA negybol ket hasznalatot emlitett, es epp a legnagyobb
//    kovetkezmenyut hagyta ki (egy agens teljesen helyi modellen fut). A
//    felhasznalo abbol dontott, hogy kell-e neki Ollama -- rossz alapon.
// 2. A helyi modell-lista URES allapota nema volt: ugyanaz az ures tomb jott ki
//    abbol, hogy nem fut a szerver, es abbol, hogy fut, de csak beagyazo modell
//    van benne. Ez pontosan a "a nulla ket dolgot jelenthet" csapda.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeOllamaModels, isEmbeddingModel } from '../ollama-model-list.js'
import { getSettingDefinition } from '../config-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf-8')

let hu: Record<string, string>
let en: Record<string, string>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

/** A negy tenyleges hasznalat, ahogy a felhasznalo nyelven meg lehet nevezni.
 *  Nem egy konkret mondatot varunk el, hanem azt, hogy mind a negy szoba
 *  keruljon -- kulonben a leiras ujra hianyos lehetne egy atfogalmazastol. */
const HU_USAGES: [string, RegExp][] = [
  ['szemantikus kereses', /keres/i],
  ['emlek-besorolas importalaskor', /besorol|warm/i],
  ['modell-lista a feluleten', /modell-list/i],
  ['agens helyi modellen', /ágens/i],
]
const EN_USAGES: [string, RegExp][] = [
  ['semantic search', /search/i],
  ['memory sorting on import', /sort|warm/i],
  ['model list in the UI', /model list/i],
  ['agent on a local model', /agent/i],
]

describe('OLLAMA_URL: a leiras mind a negy hasznalatot megnevezi', () => {
  it('a registry leirasa (a forditas tartaleka) teljes', () => {
    const def = getSettingDefinition('OLLAMA_URL')
    expect(def, 'OLLAMA_URL nincs a registryben').toBeTruthy()
    const desc = def!.description || ''
    for (const [what, re] of HU_USAGES) expect(re.test(desc), `hianyzik a leirasbol: ${what}`).toBe(true)
  })

  it('a kepernyon lathato magyar szoveg teljes', () => {
    const desc = hu['settings.desc.OLLAMA_URL']
    expect(desc, 'nincs magyar kulcs').toBeTruthy()
    for (const [what, re] of HU_USAGES) expect(re.test(desc), `hianyzik a hu szovegbol: ${what}`).toBe(true)
  })

  it('az angol szoveg ugyanazt mondja el', () => {
    const desc = en['settings.desc.OLLAMA_URL']
    expect(desc, 'nincs angol kulcs').toBeTruthy()
    for (const [what, re] of EN_USAGES) expect(re.test(desc), `hianyzik az en szovegbol: ${what}`).toBe(true)
  })

  it('a regi, hianyos mondat egyik helyen sem maradt ott', () => {
    const old = 'Memória-embedding és modell-javaslat ezt használja'
    expect(read('src/config-registry.ts')).not.toContain(old)
    expect(hu['settings.desc.OLLAMA_URL']).not.toContain(old)
    expect(en['settings.desc.OLLAMA_URL']).not.toContain('Used for memory embedding and model suggestions')
  })
})

describe('a modell-lista nullaja megmondja, MELYIK nulla', () => {
  const url = 'http://localhost:11434'

  it('nem lattunk oda: unreachable, totalModels null, es a VALODI hibauzenet', () => {
    const out = summarizeOllamaModels({ url, reachable: false, tags: null, error: 'fetch failed' })
    expect(out.verdict).toBe('unreachable')
    expect(out.totalModels).toBeNull()
    expect(out.error).toBe('fetch failed')
    expect(out.models).toEqual([])
  })

  it('hibauzenet nelkul sem allitja, hogy tudja az okot', () => {
    const out = summarizeOllamaModels({ url, reachable: false, tags: null })
    expect(out.verdict).toBe('unreachable')
    expect(out.error).toBe('ismeretlen hiba')
  })

  it('fut, de ures: no_models, es a darabszam MERT nulla', () => {
    const out = summarizeOllamaModels({ url, reachable: true, tags: [] })
    expect(out.verdict).toBe('no_models')
    expect(out.totalModels).toBe(0)
    expect(out.error).toBeNull()
  })

  it('fut, de csak beagyazo modell van benne: embed_only, a darabszam megmarad', () => {
    const out = summarizeOllamaModels({
      url, reachable: true,
      tags: [{ name: 'nomic-embed-text:latest', size: 274 * 1024 * 1024 }, { name: 'MXBAI-EMBED-large', size: 0 }],
    })
    expect(out.verdict).toBe('embed_only')
    expect(out.totalModels).toBe(2)
    expect(out.models).toEqual([])
  })

  it('van beszelgeto modell: ok, a beagyazo kiesik a listabol', () => {
    const out = summarizeOllamaModels({
      url, reachable: true,
      tags: [
        { name: 'nomic-embed-text', size: 274 * 1024 * 1024 },
        { name: 'llama3.2', size: 2 * 1024 * 1024 * 1024, details: { parameter_size: '3B' } },
      ],
    })
    expect(out.verdict).toBe('ok')
    expect(out.totalModels).toBe(2)
    expect(out.models.map((m) => m.name)).toEqual(['llama3.2'])
    expect(out.models[0].size).toBe('2 GB')
    expect(out.models[0].params).toBe('3B')
  })

  it('a meret hianya nem lesz "NaN GB"', () => {
    const out = summarizeOllamaModels({ url, reachable: true, tags: [{ name: 'llama3.2' }] })
    expect(out.models[0].size).toBe('')
  })

  it('az embed-felismeres kis- es nagybetutol fuggetlen', () => {
    expect(isEmbeddingModel('nomic-embed-text')).toBe(true)
    expect(isEmbeddingModel('MXBAI-EMBED-LARGE')).toBe(true)
    expect(isEmbeddingModel('llama3.2')).toBe(false)
  })
})

describe('a szal a vegpont es a felulet kozott ossze van kotve', () => {
  it('a vegpont a tiszta fuggvenyt hasznalja, es nem ad vissza csupasz ures tombot', () => {
    const src = read('src/web/routes/connectors.ts')
    // A kezelo tobb `return true`-t is tartalmaz (korai kilepes a nem-OK
    // valasznal), ezert a blokk vegét a lezaro sor keresi, nem az elso return.
    const from = src.indexOf("'/api/ollama/models'")
    const endpoint = src.slice(from, src.indexOf('\n  }\n', from))
    expect(endpoint).toContain('summarizeOllamaModels')
    expect(endpoint).not.toMatch(/json\(res, \[\]\)/)
    // A hibaag a TENYLEGES uzenetet adja tovabb, nem nyeli el.
    expect(endpoint).toContain('err instanceof Error ? err.message')
  })

  it('a felulet mindharom okot ki tudja irni', () => {
    const src = read('web/app.js')
    for (const key of ['agents.model.ollama_unreachable', 'agents.model.ollama_no_models', 'agents.model.ollama_embed_only']) {
      expect(src, `${key} nincs bekotve az app.js-be`).toContain(key)
    }
    expect(read('web/index.html')).toContain('id="ollamaModelHint"')
  })

  it('mindharom uzenet megvan MINDKET nyelven, azonos helyorzokkel', () => {
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    for (const key of ['agents.model.ollama_unreachable', 'agents.model.ollama_no_models', 'agents.model.ollama_embed_only']) {
      expect(hu[key], `hianyzik hu: ${key}`).toBeTruthy()
      expect(en[key], `hianyzik en: ${key}`).toBeTruthy()
      expect(tokens(hu[key]), `elteroe helyorzok: ${key}`).toBe(tokens(en[key]))
    }
  })
})
