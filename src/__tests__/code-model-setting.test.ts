// A KIADOTT MUNKA MODELLJE A FELULETROL ALLITHATO.
//
// Boss, 2026-09-13: "nem egyszerubb lenne ha a kartyaban a beallitasokban
// tudnam allitani hogy melyik model legyen? opus vagy mas? ... ugyanugy ahogy a
// tobbi agent nel is lehet allitani?"
//
// Eddig nem lehetett: a headless CLI a telepites alapertelmezett modelljet
// kapta (a projekt `.claude/settings.json` `model` mezojet), es errol a
// feluleten semmi nem szolt. Egy kiadott munka igy akkor is haikuval futott
// volna, ha a tulaj a VS Code-ban mar Opusra valtott.
//
// KET KULON DOLOG, es a felulet is kimondja a kulonbseget:
//   * ez a beallitas = a KIADOTT munka modellje (`--model` a CLI-nek);
//   * a kartyan latszo modell = MERES (a naplo mondja meg, mivel valaszolt a
//     beszelgetes utoljara) -- azt leolvasni lehet, beallitani nem.
//
// AZ URES ERTEK ERVENYES VALASZTAS, nem hianyzo adat: olyankor NEM adunk
// `--model` kapcsolot, es a Claude Code sajat valasztasa marad ervenyben.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingDefinition } from '../config-registry.js'

const ROOT = join(__dirname, '..', '..')
const PS1 = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
const ROUTES = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

describe('a beallitas vegig megy: sema -> API -> worker -> CLI', () => {
  it('a CODE_MODEL benne van a beallitas-semaban, ures alapertekkel', () => {
    const entry = getSettingDefinition('CODE_MODEL')
    expect(entry, 'a CODE_MODEL hianyzik a config-registry-bol').toBeTruthy()
    // Az URES az alapertek: nem egetunk be konkret modellt, mert azzal olyat
    // irnank felul, amirol a tulajt nem kerdeztuk meg.
    expect(entry!.default).toBe('')
    expect(entry!.valueSet, 'a valueSet-nek tartalmaznia kell az ures valasztast').toContain('')
    expect(entry!.valueSet).toContain('claude-opus-5')
  })

  it('a GET /api/code/config visszaadja, a POST menteni engedi', () => {
    expect(ROUTES).toContain("CODE_MODEL: String(getEffectiveSettingValue('CODE_MODEL'))")
    expect(ROUTES).toMatch(/'CODE_PERMISSION_MODE', 'CODE_MODEL'/)
  })

  it('a claim valasz elviszi a workerhez (a permissionMode mellett), ELOBOL olvasva', () => {
    // Boss, 2026-09-13: a rejtett dispatch-session modelljet CSAK a dashboardrol
    // lehet allitani, ezert a claim NEM a boot-ideju CODE_MODEL konstanst adja
    // (az csak restart utan valtozna -> disz), hanem az elo override-ot.
    expect(ROUTES).toMatch(/permissionMode: CODE_PERMISSION_MODE, model: effectiveDispatchModel\(\)/)
    // A helper tenylegesen az elo beallitas-tarbol olvas, nem a konstansbol.
    expect(ROUTES).toMatch(/function effectiveDispatchModel\(\)[\s\S]*getEffectiveSettingValue\('CODE_MODEL'\)/)
    // Regresszio-orzes: a claim-valasz NE a puszta boot-konstanst adja vissza.
    expect(ROUTES).not.toMatch(/model: CODE_MODEL,/)
  })

  it('a GET live.model is elobol jon (nincs hamis "ujrainditas kell" a modellnel)', () => {
    // A live blokk model mezoje az effektiv erteket adja, igy a stored == live
    // -> a felulet nem jelez ujrainditast egy modell-valtas utan.
    expect(ROUTES).toMatch(/model: effectiveDispatchModel\(\),/)
  })

  it('a POST restartRequired FALSE, ha csak a CODE_MODEL valtozott', () => {
    expect(ROUTES).toMatch(/restartRequired = saved\.some\(\(k\) => k !== 'CODE_MODEL'\)/)
  })

  it('a worker atadja a CLI-nek, ha van ertek', () => {
    expect(PS1).toMatch(/\$modelArg = ' --model ' \+ \$wantModel/)
    // Mindket ag (uj beszelgetes es folytatas) megkapja.
    const args = PS1.split('\n').filter((l) => l.includes('--permission-mode ') && l.includes('$modelArg'))
    expect(args.length, 'nem mindket indito ag kapja meg a modellt').toBe(2)
  })

  it('URES ertek = NINCS --model kapcsolo (a CLI sajat valasztasa marad)', () => {
    const i = PS1.indexOf('$modelArg = \'\'')
    expect(i).toBeGreaterThan(0)
    // Az ures ag nem ir semmit a parancssorra; csak a nem-ures kap kapcsolot.
    expect(PS1).toMatch(/if \(\$wantModel\) \{/)
  })

  it('a modellnevet MEGSZURI, mielott parancssorra teszi', () => {
    // A nev a hid felol jon es egyenesen a parancssorra kerul. Csak az a
    // karakterkeszlet mehet at, amibol a modellnevek allnak.
    expect(PS1).toMatch(/\$wantModel -match '\^\[A-Za-z0-9\._-\]\{1,64\}\$'/)
  })
})

describe('a felulet: valaszthato, es kimondja, mi NEM ez', () => {
  it('van valaszto a kod-hid beallitasai kozott', () => {
    expect(INDEX).toContain('id="cbModel"')
    expect(INDEX).toContain('value="claude-opus-5"')
  })

  it('az app betolti es menti', () => {
    expect(APP).toContain("document.getElementById('cbModel')")
    expect(APP).toMatch(/CODE_MODEL: model \? model\.value : ''/)
  })

  it('a sugoszoveg MEGKULONBOZTETI a beallitast a kartyan latszo merestol', () => {
    // Ez a felreertes maga volt a kerdes kiindulopontja -- a szovegnek ki kell
    // mondania, kulonben a tulaj ujra azt hiszi, a kartya erteket allitja.
    const hu = /'cb\.ops\.model_help': '([^']*)'/.exec(HU)
    expect(hu, 'nincs magyar sugo a modell-valasztohoz').not.toBeNull()
    expect(hu![1]).toMatch(/mérés/)
  })

  it('minden uj kulcs megvan magyarul ES angolul', () => {
    for (const key of ['cb.ops.model_label', 'cb.ops.model_default', 'cb.ops.model_help']) {
      expect(HU.includes(`'${key}'`), `hianyzik a magyar ${key}`).toBe(true)
      expect(EN.includes(`'${key}'`), `hianyzik az angol ${key}`).toBe(true)
    }
  })
})

// Kanban #281 (Boss #947): a kartya a BEALLITOTT kiadasi-modellt mutassa
// AZONNAL, ne a per-session merest. A tulaj Opus 5-re valtott, de a kartya
// tovabbra is "nem latok oda"-t irt, mert a jelveny a merest (`modelBySession`,
// `null` amig nem valaszolt a beszelgetes) olvasta, nem a beallitott
// CODE_MODEL-t. Az ar-jelveny is a beallitott modellbol jon (Boss 5635).
describe('kanban #281: a kartya a BEALLITOTT modellt mutatja, nem a merest', () => {
  it('a /api/code/projects valasz elviszi a BEALLITOTT modellt es annak arat', () => {
    // A global (nem projektenkenti) beallitott modell, ELOBOL olvasva -- igy a
    // "meg nincs projekt" (friss telepites) kartya is ki tudja irni.
    expect(ROUTES).toMatch(/const releaseModel = effectiveDispatchModel\(\)/)
    // Ures beallitas -> `null`, NEM kitalalt nev (fresh-install: a nulla ket
    // dolgot jelenthet, itt az "alapertelmezett" cimke a helyes).
    expect(ROUTES).toMatch(/releaseModel: releaseModel \|\| null/)
    // Az ar a BEALLITOTT modellbol jon (nem a meresbol); ismeretlen -> null.
    expect(ROUTES).toMatch(/const releaseCostPerMInput = releaseModel \? knownModelCostPerM\(releaseModel\) : null/)
    expect(ROUTES).toContain('releaseCostPerMInput')
  })

  it('a kartya-render a BEALLITOTT modellt es annak arat rajzolja (nem a merest)', () => {
    // A modell-jelveny a beallitott modellt mutatja, ures beallitasnal az
    // "alapertelmezett" cimket -- NEM a regi "nem latok oda"-t.
    expect(APP).toContain("codeBridgeCards.releaseModel || t('cb.card.model_default')")
    expect(APP).toContain("codeBridgeCards.releaseModel ? t('cb.card.model_set_help') : t('cb.card.model_default_help')")
    // Az ar-jelveny is a beallitott modellbol (releaseCostPerMInput), nem a
    // per-session meresbol (e.costPerMInput).
    expect(APP).toContain('costBadgeHtml(codeBridgeCards.releaseCostPerMInput)')
    // A betolto elteszi a valaszbol a beallitott modellt es arat.
    expect(APP).toContain('releaseModel: (projects && typeof projects.releaseModel')
    expect(APP).toContain('releaseCostPerMInput: (projects && typeof projects.releaseCostPerMInput')
  })

  it('az uj kartya-kulcsok megvannak magyarul ES angolul', () => {
    for (const key of ['cb.card.model_default', 'cb.card.model_set_help', 'cb.card.model_default_help']) {
      expect(HU.includes(`'${key}'`), `hianyzik a magyar ${key}`).toBe(true)
      expect(EN.includes(`'${key}'`), `hianyzik az angol ${key}`).toBe(true)
    }
  })
})
