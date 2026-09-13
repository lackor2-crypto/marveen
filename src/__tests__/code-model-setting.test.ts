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

  it('a claim valasz elviszi a workerhez (a permissionMode mellett)', () => {
    expect(ROUTES).toMatch(/permissionMode: CODE_PERMISSION_MODE, model: CODE_MODEL/)
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
