/**
 * EGY SZOLGALTATAS, TOBB KULCS -- a ferohelyek (slotok) modellje.
 *
 * Boss, 2026-09-02: "akar felvihetne kesobb egy legujabb glm elofizetest is.
 * masodikat. nem? tehat akkor miert tunne el onnan a listabol? szerintem lehet
 * hogy jobb lenne otthagyni. nem? es meg ha van tobb bekotesi lehetoseg akkor
 * azt is megjeleniteni ott."
 *
 * A hiba nem a feliraton volt. A trezor szolgaltatasonkent EGY nevet ismert
 * (`zai-coding-key`), es az egesz flotta azt az egy nevet olvasta -- egy
 * masodik GLM-elofizetes kulcsa tehat nem MELLE kerult volna, hanem FELULIRTA
 * volna az elsot, hibauzenet nelkul. Ez a teszt azt tartja, hogy tobb kulcs
 * elfer egymas mellett, hogy a valasztas nem tunhet el nemán, es hogy a nulla
 * itt sem keveredik ossze a "nem latok oda"-val.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { baseServiceId, isSlotOf, nextSlotId, keyServiceView } from '../web/key-service-slots.js'
import { readActiveMap, activeSlotFor, setActiveSlotFor } from '../web/key-service-active.js'
import { keySlotRows } from '../web/system-health.js'
import { impactOfRemoving, isKnownKeyService, KEY_SERVICE_CATALOG } from '../web/key-service-dependents.js'

const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')
const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')
const accounts = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'accounts.ts'), 'utf8')
const vaultSrc = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'vault.ts'), 'utf8')

/** Egy kozos tmp konyvtar az egesz fajlnak (nyomtalan munka). */
let _tmpDir: string | null = null
function tmp(): string {
  if (!_tmpDir) _tmpDir = mkdtempSync(join(tmpdir(), 'marveen-slot-'))
  return _tmpDir
}

/** Egy trezor-sor annyi mezovel, amennyit a nezet tenylegesen olvas. */
function row(id: string, label = id, fields?: Array<{ bindingId?: string; hasValue?: boolean }>) {
  return { id, label, updatedAt: '2026-09-02T00:00:00.000Z', fields }
}

/** A valaszto vegpont TELJES torzse -- az elso `return true` nem a vege. */
function activeHandler(): string {
  const start = accounts.indexOf("if (path === '/api/key-services/active'")
  if (start < 0) return ''
  const next = accounts.indexOf("\n  if (path === ", start + 10)
  return accounts.slice(start, next < 0 ? accounts.length : next)
}

describe('ferohely-nevek: melyik azonosito tartozik ugyanahhoz a szolgaltatashoz', () => {
  it('az alap-nev onmaga, a sorszamozott valtozat visszavezet ra', () => {
    expect(baseServiceId('zai-coding-key')).toBe('zai-coding-key')
    expect(baseServiceId('zai-coding-key.2')).toBe('zai-coding-key')
    expect(baseServiceId('zai-coding-key.17')).toBe('zai-coding-key')
  })

  it('csak sorszam lehet a pont utan -- a sajat nevu kartya NEM ferohely', () => {
    // Kulonben a felhasznalo "zai-coding-key.regi" nevu kartyaja hirtelen ennek
    // a szolgaltatasnak a kulcsakent viselkedne, anelkul hogy o ezt kerte volna.
    expect(isSlotOf('zai-coding-key', 'zai-coding-key')).toBe(true)
    expect(isSlotOf('zai-coding-key.2', 'zai-coding-key')).toBe(true)
    expect(isSlotOf('zai-coding-key.regi', 'zai-coding-key')).toBe(false)
    expect(isSlotOf('zai-coding-key-masolat', 'zai-coding-key')).toBe(false)
    expect(isSlotOf('openrouter-fleet-key', 'zai-coding-key')).toBe(false)
  })

  it('a kovetkezo szabad hely az elso URES nev, nem a darabszam+1', () => {
    // Ha a darabszambol szamolnank, a 2-es torlese utan a kovetkezo kulcs a
    // 3-asra menne, es a 2-es orokre uresen maradna.
    expect(nextSlotId('zai-coding-key', [])).toBe('zai-coding-key')
    expect(nextSlotId('zai-coding-key', ['zai-coding-key'])).toBe('zai-coding-key.2')
    expect(nextSlotId('zai-coding-key', ['zai-coding-key', 'zai-coding-key.2'])).toBe('zai-coding-key.3')
    expect(nextSlotId('zai-coding-key', ['zai-coding-key', 'zai-coding-key.3'])).toBe('zai-coding-key.2')
  })

  it('a mas szolgaltatasok nevei nem foglalnak helyet', () => {
    expect(nextSlotId('zai-coding-key', ['openrouter-fleet-key', 'groq-stt-key'])).toBe('zai-coding-key')
  })
})

describe('keyServiceView: mi all a szolgaltatas mogott', () => {
  it('a ferohelyek sorrendje: alap-hely, sorszam, vegul a kotott mezok', () => {
    const view = keyServiceView('zai-coding-key', [
      row('zai-coding-key.3'),
      row('kozos-kartya', 'Kozos kartya', [{ bindingId: 'zai-coding-key', hasValue: true }]),
      row('zai-coding-key.2'),
      row('zai-coding-key'),
    ], null)
    expect(view.slots.map(s => s.slotId)).toEqual([
      'zai-coding-key', 'zai-coding-key.2', 'zai-coding-key.3', 'kozos-kartya',
    ])
  })

  it('a masik kartya mezoje megmondja, MELYIK kartyan van', () => {
    // Kulonben a sor egy olyan nevre mutatna, amit a felhasznalo hiaba keresne
    // a trezorban.
    const view = keyServiceView('groq-stt-key', [
      row('kozos', 'Kozos kartya', [{ bindingId: 'groq-stt-key', hasValue: true }]),
    ], null)
    expect(view.slots[0].boundOn).toBe('Kozos kartya')
  })

  it('ures trezor: NULLA kulcs (friss telepites), nem ismeretlen', () => {
    const view = keyServiceView('zai-coding-key', [], null)
    expect(view.count).toBe(0)
    expect(view.slots).toEqual([])
    expect(view.activeMissing).toBe(false)
  })

  it('a valasztott hely eltunese NEM nemá visszaeses -- kimondjuk', () => {
    // Enelkul a flotta az alap-kulcson dolgozna tovabb: MASIK elofizetes
    // keretet koltene, hibauzenet nelkul.
    const view = keyServiceView('zai-coding-key', [row('zai-coding-key')], 'zai-coding-key.2')
    expect(view.activeMissing).toBe(true)
    expect(view.activeSlotId).toBe('zai-coding-key.2')
  })

  it('a meglevo valasztas nem billen at magatol activeMissing-be', () => {
    const view = keyServiceView('zai-coding-key', [row('zai-coding-key'), row('zai-coding-key.2')], 'zai-coding-key.2')
    expect(view.activeMissing).toBe(false)
    expect(view.count).toBe(2)
  })
})

describe('a valasztas fajlja: azonosito igen, titok soha', () => {
  let p = ''
  beforeEach(() => { p = join(tmp(), 'active-' + Math.random().toString(36).slice(2) + '.json') })

  it('a hianyzo fajl URES terkep -- a friss telepites pontosan a regi viselkedes', () => {
    expect(readActiveMap(p)).toEqual({})
    expect(activeSlotFor('zai-coding-key', p)).toBeNull()
  })

  it('a serult fajl sem dob: az alap-hely lep eletbe', () => {
    writeFileSync(p, '{ ez nem json', 'utf8')
    expect(readActiveMap(p)).toEqual({})
  })

  it('a nem-objektum tartalom sem valik szemetes terkeppe', () => {
    writeFileSync(p, '[1,2,3]', 'utf8')
    expect(readActiveMap(p)).toEqual({})
  })

  it('a valasztas visszaolvashato, es a null visszaall az alap-helyre', () => {
    setActiveSlotFor('zai-coding-key', 'zai-coding-key.2', p)
    expect(activeSlotFor('zai-coding-key', p)).toBe('zai-coding-key.2')
    setActiveSlotFor('zai-coding-key', null, p)
    expect(activeSlotFor('zai-coding-key', p)).toBeNull()
  })

  it('a fajlban CSAK azonosito all -- kulcs-ertek soha', () => {
    setActiveSlotFor('zai-coding-key', 'zai-coding-key.2', p)
    const raw = readFileSync(p, 'utf8')
    expect(JSON.parse(raw)).toEqual({ 'zai-coding-key': 'zai-coding-key.2' })
    // A modul semmilyen uton nem er a titkokhoz: a trezort nem is importalja.
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'key-service-active.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/from '\.\/vault\.js'/)
    expect(code).not.toContain('getSecret')
    expect(code).not.toContain('decrypt')
  })
})

describe('onellenorzes: az eltunt valasztas hangos, a friss telepites csendes', () => {
  it('senki nem valasztott -> egyetlen sor sem (friss telepites)', () => {
    expect(keySlotRows(() => ({}), () => ({ slots: [], count: 0 }))).toEqual([])
  })

  it('a valasztott hely megvan -> zold sor, nem csend', () => {
    // A jo utnak is nyomot kell hagynia: kulonben a "minden rendben" es a
    // "meg sem neztem" kivulrol egyforma.
    const rows = keySlotRows(
      () => ({ 'zai-coding-key': 'zai-coding-key.2' }),
      () => ({ slots: [{ slotId: 'zai-coding-key.2' }], count: 1 }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('key_slot_ok')
    expect(rows[0].status).toBe('ok')
  })

  it('a valasztott hely eltunt -> PIROS sor, a nevevel egyutt', () => {
    const rows = keySlotRows(
      () => ({ 'zai-coding-key': 'zai-coding-key.2' }),
      () => ({ slots: [{ slotId: 'zai-coding-key' }], count: 1 }),
    )
    expect(rows[0].id).toBe('key_slot_orphan')
    expect(rows[0].status).toBe('bad')
    expect(String(rows[0].params?.names)).toContain('zai-coding-key.2')
  })

  it('olvashatatlan trezor -> "nem latok oda", NEM zold es NEM piros', () => {
    const rows = keySlotRows(
      () => ({ 'zai-coding-key': 'zai-coding-key.2' }),
      () => ({ slots: [], count: null }),
    )
    expect(rows[0].id).toBe('key_slot_blind')
    expect(rows[0].status).toBe('warn')
  })

  it('a dobo forras sem valik csenddé', () => {
    const rows = keySlotRows(() => { throw new Error('nem olvashato') })
    expect(rows[0].id).toBe('key_slot_blind')
  })

  it('mind a harom sornak van szovege MINDKET nyelven', () => {
    for (const id of ['key_slot_ok', 'key_slot_orphan', 'key_slot_blind']) {
      for (const lang of [hu, en]) {
        expect(lang).toContain("'health." + id + "'")
        expect(lang).toContain("'health." + id + "_action'")
      }
    }
  })
})

describe('a ferohely UGYANAZ a szolgaltatas -- az elonezet nem felejti el', () => {
  it('a masodik GLM-kulcs kivetele ugyanazokat az ugynokoket allitja meg', () => {
    const agents = [{ name: 'kutato', model: 'glm-4.6' }, { name: 'iro', model: 'claude-sonnet-4' }]
    const base = impactOfRemoving('zai-coding-key', agents)
    const slot = impactOfRemoving('zai-coding-key.2', agents)
    expect(slot.known).toBe(true)
    expect(slot.agents).toEqual(base.agents)
    expect(slot.agents).toContain('kutato')
  })

  it('a ferohely ismert kulcs marad (nem esik a "nem tudom, mi hasznalja" agra)', () => {
    expect(isKnownKeyService('groq-stt-key.3')).toBe(true)
    expect(isKnownKeyService('valami-mas-kartya')).toBe(false)
  })
})

describe('egy lista, nem harom: a katalogus vezeti a feluletet is', () => {
  it('a Fiokok vegpontja a katalogusbol epul, nem kezzel felsorolt nevekbol', () => {
    expect(accounts).toContain('KEY_SERVICE_CATALOG.map')
    expect(KEY_SERVICE_CATALOG.map(c => c.id)).toContain('deepseek')
  })

  it('a ket uj vegpont letezik, es a valasztashoz a POST kell', () => {
    expect(accounts).toContain("path === '/api/key-services' && method === 'GET'")
    expect(accounts).toContain("path === '/api/key-services/active' && method === 'POST'")
  })

  it('olvashatatlan trezornal a valasztas NEM irodik ki -- amit nem tudok ellenorizni, azt nem rogzitem', () => {
    const fn = activeHandler()
    expect(fn.length).toBeGreaterThan(400)
    expect(fn).toContain("vaultFileState() === 'unreadable'")
    expect(fn).toContain('409')
  })

  it('kotott mezot NEM lehet aktivva tenni (a trezor a kartya sajat erteket olvasna)', () => {
    expect(activeHandler()).toContain('slot.boundOn')
  })
})

describe('a trezor a valasztott helyrol olvas -- es szol, ha az eltunt', () => {
  it('a getSecret ismeri a valasztast', () => {
    expect(vaultSrc).toContain('activeSlotFor')
  })

  it('az eltunt valasztas naplot hagy, nem nemán esik vissza', () => {
    const fn = /export function getSecret\(id: string\)[\s\S]*?\n}\n/.exec(vaultSrc)?.[0] ?? ''
    expect(fn.length).toBeGreaterThan(100)
    expect(fn).toMatch(/logger\.(warn|error)/)
  })

  it('a kulcs torlese a ra mutato valasztast is elviszi', () => {
    const fn = /export function deleteSecret[\s\S]*?\n}\n/.exec(vaultSrc)?.[0] ?? ''
    expect(fn).toContain('setActiveSlotFor')
  })
})

describe('a felulet: a masodik kulcs nem irhatja felul az elsot', () => {
  it('a "meg egy kulcs" gomb a SZERVERTOL kerdezi meg, hova kerul', () => {
    // Talalgatott ferohely-nevvel a beillesztes felulirhatna a meglevo kulcsot.
    expect(app).toContain("data-slot-id=\"${escapeAttr(k.nextSlotId)}\"")
    expect(app).toContain("t('acchub.key_add_btn')")
  })

  it('a 2 masodperces ujrarajzolas nem allithatja vissza a celt az alap-helyre', () => {
    // Enelkul: ranyomsz a "meg egy kulcs"-ra, beirod a masodik elofizetes
    // kulcsat, es mire mentesz, a cel mar megint az ELSO kulcs helye.
    expect(app).toContain('let _accKeySlotTarget = null')
    const sync = /function _claudeAuthSyncServiceUi\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(sync).toContain('_accKeySlotTarget')
    expect(sync).toContain('target ? target.slotId : chosen.vaultId')
  })

  it('a lemezre iras ELOTT kimondja, hova kerul a kulcs', () => {
    expect(html).toContain('id="claudeAuthKeySlotNote"')
    for (const lang of [hu, en]) expect(lang).toContain("'claudeauth.key_slot_note'")
  })

  it('a valasztas eldobodik szolgaltatas-valtaskor es sikeres mentes utan', () => {
    const wiring = /claudeAuthService'\)\.addEventListener\('change'[\s\S]{0,300}?\n  \}\)/.exec(app)?.[0] ?? ''
    expect(wiring.length).toBeGreaterThan(40)
    expect(wiring).toContain('_accKeySlotTarget = null')
    const save = /claudeAuthKeySaveBtn'\)\.addEventListener[\s\S]*?\n  \}\)/.exec(app)?.[0] ?? ''
    expect(save).toContain('_accKeySlotTarget = null')
  })

  it('az olvashatatlan trezor a Fiokok soran is kimondott mondat, nem "nincs kulcs"', () => {
    const renderer = /function _accHubRenderKeys\(\)[\s\S]*?\n}\n/.exec(app)?.[0] ?? ''
    expect(renderer.length).toBeGreaterThan(1000)
    expect(renderer).toContain('k.count === null')
    expect(renderer).toContain("t('acchub.key_count_unknown')")
    for (const lang of [hu, en]) expect(lang).toContain("'acchub.key_count_unknown'")
  })

  it('a fiok-sorok (GitHub, Google, Telegram) NEM valnak kulcs-urlappa', () => {
    // A CAPABILITY_INFO azota fiokokat is tartalmaz; ha a `vaultId` nelkuli
    // sorokat is kulcsnak nezne a lap, a GitHub a kulcs-beilleszto legorduloben
    // kotne ki -- egy gomb, ami nem tudja befejezni, amit igér.
    expect(app).toContain('function _keyCapabilityFor(id)')
    expect(app).toContain('return info && info.vaultId ? info : null')
  })
})

describe('nyomtalan munka: a proba nem hagy maga utan semmit', () => {
  it('a tmp konyvtar torolheto', () => {
    if (_tmpDir) {
      rmSync(_tmpDir, { recursive: true, force: true })
      _tmpDir = null
    }
    expect(true).toBe(true)
  })
})

/**
 * A KET GOMB SOSE IGERHET UGYANAZT.
 *
 * A sor-rajzolot itt tenylegesen LEFUTTATJUK (a szokasos idiom: a fuggvenyt
 * kiemeljuk a web/app.js-bol es egy hamis DOM folott ertekeljuk), mert ez a
 * hiba forras-olvasassal nem latszott: mindket gomb szabalyos volt kulon-kulon,
 * csak EGYMASHOZ kepest mondtak mast. Az elo feluleten az OpenRouter sorban a
 * "Kulcs csereje" es a "Meg egy kulcs" ugyanarra a ferohelyre mutatott.
 */
function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs meg a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() nem kiegyensulyozott`)
}

interface KeyRow {
  id: string
  label: string
  kind: string
  addable: boolean
  configured: boolean
  count: number | null
  accounts: string[]
  defaultAccount?: string | null
  vaultId: string
  slots: Array<{ slotId: string; label: string; boundOn?: string }>
  activeSlotId: string | null
  activeMissing: boolean
  nextSlotId: string | null
}

/** A rajzolt sor gombjai: osztaly + cel-ferohely + felirat. */
function renderRow(row: Partial<KeyRow>): Array<{ cls: string; slot: string; label: string }> {
  const full: KeyRow = {
    id: 'zai', label: 'GLM', kind: 'key', addable: true, configured: true,
    count: 1, accounts: [], defaultAccount: null, vaultId: 'zai-coding-key',
    slots: [{ slotId: 'zai-coding-key', label: 'GLM' }],
    activeSlotId: null, activeMissing: false, nextSlotId: 'zai-coding-key.2',
    ...row,
  } as KeyRow
  let html = ''
  const el = {
    dataset: { wired: '1' },
    addEventListener() {},
    set innerHTML(v: string) { html = v },
    get innerHTML() { return html },
  }
  const fn = new Function(
    'document', 't', 'escapeHtml', 'escapeAttr', '_claudeAuthKeyServices',
    `${extractFn(app, '_accHubRenderKeys')}\nreturn _accHubRenderKeys`,
  )(
    { getElementById: (id: string) => (id === 'accountsKeyList' ? el : null) },
    (k: string) => k,
    (v: string) => String(v),
    (v: string) => String(v),
    [full],
  )
  fn()
  const out: Array<{ cls: string; slot: string; label: string }> = []
  const re = /<button[^>]*class="([^"]*)"[^>]*data-slot-id="([^"]*)"[^>]*>([^<]*)</g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push({ cls: m[1], slot: m[2], label: m[3] })
  return out
}

describe('a ket gomb sose mutat ugyanarra a ferohelyre', () => {
  it('egy kozvetlen kulcsnal: csere az alap-helyre, "meg egy" a kovetkezore', () => {
    const btns = renderRow({})
    expect(btns.map(b => b.slot)).toEqual(['zai-coding-key', 'zai-coding-key.2'])
    expect(btns[0].label).toContain('key_replace_btn')
    expect(btns[1].label).toContain('key_add_btn')
  })

  it('kotott mezon lako kulcsnal EGY gomb van -- nincs mit "cserelni" innen', () => {
    // Ez az elo OpenRouter-sor: a kulcs egy masik kartya mezojen lakik, ezert
    // az alap-nev szabad. Ket gomb ilyenkor ugyanoda irna.
    const btns = renderRow({
      label: 'OpenRouter', vaultId: 'openrouter-fleet-key',
      slots: [{ slotId: 'openrouter', label: 'OpenRouter', boundOn: 'OpenRouter' }],
      nextSlotId: 'openrouter-fleet-key',
    })
    expect(btns.length).toBe(1)
    expect(btns[0].slot).toBe('openrouter-fleet-key')
    // ...es nem hazudik cseret: nincs ezen a helyen mit felulirni.
    expect(btns[0].label).toContain('key_add_btn')
  })

  it('ha a valasztott hely a .2, a csere ODA megy -- nem az alap-nevre', () => {
    // Elerheto allapot: felvitted a masodikat, kivalasztottad, majd az elsot
    // kitorolted. A `getSecret` a valasztott helyet olvassa, tehat az alap-nevre
    // irt kulcsot figyelmen kivul hagyna -- nemán.
    const btns = renderRow({
      count: 1,
      slots: [{ slotId: 'zai-coding-key.2', label: 'GLM 2' }],
      activeSlotId: 'zai-coding-key.2',
      nextSlotId: 'zai-coding-key',
    })
    expect(btns[0].slot).toBe('zai-coding-key.2')
    expect(btns[0].label).toContain('key_replace_btn')
    expect(btns[1].slot).toBe('zai-coding-key')
  })

  it('meg nincs kulcs: egyetlen "bejelentkezes" gomb, az alap-helyre', () => {
    const btns = renderRow({ configured: false, count: 0, slots: [], nextSlotId: 'zai-coding-key' })
    expect(btns.length).toBe(1)
    expect(btns[0].slot).toBe('zai-coding-key')
    expect(btns[0].label).toContain('key_login_btn')
  })

  it('SOHA nem keletkezik ket beillesztő gomb azonos cellal', () => {
    const cases: Array<Partial<KeyRow>> = [
      {},
      { configured: false, count: 0, slots: [], nextSlotId: 'zai-coding-key' },
      { slots: [{ slotId: 'openrouter', label: 'OR', boundOn: 'OpenRouter' }], nextSlotId: 'zai-coding-key' },
      { slots: [{ slotId: 'zai-coding-key.2', label: 'GLM 2' }], activeSlotId: 'zai-coding-key.2', nextSlotId: 'zai-coding-key' },
      { nextSlotId: null },
      { count: null, configured: false, slots: [], nextSlotId: null },
    ]
    for (const c of cases) {
      const slots = renderRow(c).filter(b => b.cls.includes('acc-key-login')).map(b => b.slot)
      expect(new Set(slots).size).toBe(slots.length)
    }
  })

  it('a felulirasnak SAJAT mondata van (nem a "melle kerul" szoveg)', () => {
    // Ket kulonbozo igeret, ket kulonbozo mondat -- az egyik
    // visszafordithatatlan, es ezt a felhasznalo a mentes ELOTT olvassa.
    expect(app).toContain(`claudeauth.key_replace_note`)
    for (const src of [hu, en]) expect(src).toContain(`'claudeauth.key_replace_note'`)
  })
})
