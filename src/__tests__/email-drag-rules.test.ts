// Email: tobb kijelolt level huzasa + rendszermappak celpontkent + tanult
// felado-szabalyok.
//
// Boss, 2026-08-15: "ha egyet huzok at akor jo. ateszi. de ha kijelolok
// mondjuk kettot akkor is csak az t huzza at amit megfogtam. nem az osszeset
// amit kijeloltem. es csinlad meg hogy kukaba, spam, promociokba , es fontos
// ba, is at tudjam huzni a leveveleket. es ha spambe huzom akkor jeloje meg es
// a jovobeni leveleket azonnal a spambe iranyitsa."
//
// Amit ez a fajl ved, harom kulon dolog:
//   1. A HUZOTT HALMAZ. Egy kijelolt sort megfogva az EGESZ kijeloles utazik;
//      egy ki NEM jelolt sort megfogva csak az az egy (kulonben egy figyelmetlen
//      huzas eltuntetne egy korabbi kijelolest is).
//   2. MAPPANKENT MAS MUVELET. Kuka/Spam = valodi athelyezes, Fontos = jeloles
//      (a level MARAD), Promociok = nem is mappa, csak a felado megjegyzese.
//      Ha ezek osszekeverednek, levelek tunnek el a postafiokbol.
//   3. VISSZAVONHATOSAG. Amit a Marveen megtanul, azt el is kell tudni
//      felejteni -- kulonben egy elhibazott huzas orokre elnemitana egy feladot.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  normalizeSender,
  envelopeSender,
  addRule,
  removeRule,
  rulesFor,
  matchesRule,
  type EmailRule,
} from '../email-rules.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'email.ts'), 'utf8')

/** Egy fuggveny torzse az app.js-bol, zarojel-parositassal. */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const from = src.indexOf('{', start.index + start[0].length - 1)
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start.index, i + 1) }
  }
  throw new Error(`nem zarodik be: ${name}`)
}

// ---------------------------------------------------------------------------
// 1. A tanult szabalyok tiszta logikaja (halozat es IMAP nelkul)
// ---------------------------------------------------------------------------

describe('normalizeSender: mi szamit feladonak', () => {
  it('a "Nev <cim>" alakbol a cimet veszi ki, kisbetusen', () => {
    expect(normalizeSender('Akcio Hirlevel <Info@Bolt.HU>')).toBe('info@bolt.hu')
    expect(normalizeSender('  INFO@bolt.hu  ')).toBe('info@bolt.hu')
  })

  it('ami nem cim, abbol nem lesz szabaly', () => {
    // Egy hianyos vagy elgepelt mezobol szuletett szabaly egesz feladokat
    // nemitana el nemaul -- inkabb ne szulessen szabaly.
    for (const bad of ['', '   ', 'Akcio Hirlevel', 'info@bolt', 'a@b@c.hu', '@bolt.hu', 'info@.hu', null, undefined, 42]) {
      expect(normalizeSender(bad as unknown), `nem lehet cim: ${String(bad)}`).toBe('')
    }
  })

  it('a boritek feladoja ugyanezen az uton megy at', () => {
    expect(envelopeSender({ from: [{ name: 'Bolt', email: 'INFO@Bolt.hu' }] })).toBe('info@bolt.hu')
    expect(envelopeSender({ from: [] })).toBe('')
    expect(envelopeSender({})).toBe('')
    expect(envelopeSender(null)).toBe('')
  })
})

describe('szabalylista: hozzaadas, torles, fiokonkent', () => {
  const base: EmailRule[] = []

  it('ugyanaz a szabaly ketszer nem kerul be (a Boss ketszer is rahuzhat)', () => {
    const once = addRule(base, 'spam', 'lackor2', 'Info@Bolt.hu')
    const twice = addRule(once, 'spam', 'lackor2', 'info@bolt.hu')
    expect(once).toHaveLength(1)
    expect(twice).toHaveLength(1)
    expect(twice[0].sender).toBe('info@bolt.hu')
  })

  it('ervenytelen cim vagy hianyzo fiok nem hoz letre szabalyt', () => {
    expect(addRule(base, 'spam', 'lackor2', 'nem cim')).toHaveLength(0)
    expect(addRule(base, 'spam', '', 'info@bolt.hu')).toHaveLength(0)
  })

  it('ugyanaz a felado kulon szabaly spamra es promora', () => {
    let r = addRule(base, 'spam', 'lackor2', 'info@bolt.hu')
    r = addRule(r, 'promo', 'lackor2', 'info@bolt.hu')
    expect(r).toHaveLength(2)
    expect(rulesFor(r, 'spam', 'lackor2').size).toBe(1)
    expect(rulesFor(r, 'promo', 'lackor2').size).toBe(1)
  })

  it('a szabaly EGY fiokban ervenyes -- tiz bekotott fioknal ez nem mindegy', () => {
    let r = addRule(base, 'spam', 'lackor2', 'info@bolt.hu')
    r = addRule(r, 'spam', 'usalackor', 'mas@bolt.hu')
    expect([...rulesFor(r, 'spam', 'lackor2')]).toEqual(['info@bolt.hu'])
    expect([...rulesFor(r, 'spam', 'usalackor')]).toEqual(['mas@bolt.hu'])
  })

  it('a visszavonas csak a sajat fiok sajat fajta szabalyat viszi el', () => {
    let r = addRule(base, 'spam', 'lackor2', 'info@bolt.hu')
    r = addRule(r, 'promo', 'lackor2', 'info@bolt.hu')
    r = addRule(r, 'spam', 'usalackor', 'info@bolt.hu')
    const after = removeRule(r, 'spam', 'lackor2', 'INFO@bolt.hu')
    expect(after).toHaveLength(2)
    expect(rulesFor(after, 'spam', 'lackor2').size).toBe(0)
    expect(rulesFor(after, 'promo', 'lackor2').size).toBe(1)
    expect(rulesFor(after, 'spam', 'usalackor').size).toBe(1)
  })
})

describe('matchesRule: kire hat a szabaly', () => {
  const senders = new Set(['info@bolt.hu'])

  it('a felado cime szamit, a kiirt nev nem', () => {
    expect(matchesRule(senders, { from: [{ name: 'Barmi', email: 'info@bolt.hu' }] })).toBe(true)
    expect(matchesRule(senders, { from: [{ name: 'info@bolt.hu', email: 'mas@bolt.hu' }] })).toBe(false)
  })

  it('felado nelkuli boritekra SOSEM -- kulonben egy hianyos mezo tomeges spamot okozna', () => {
    expect(matchesRule(senders, { from: [] })).toBe(false)
    expect(matchesRule(senders, { from: [{ email: '' }] })).toBe(false)
    expect(matchesRule(senders, {})).toBe(false)
    expect(matchesRule(new Set(['']), { from: [{ email: '' }] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. A huzott halmaz (a Boss eredeti panasza)
// ---------------------------------------------------------------------------

interface DragEventStub {
  currentTarget: { dataset: Record<string, string> }
  dataTransfer: {
    effectAllowed: string
    data: Record<string, string>
    setData(type: string, value: string): void
    setDragImage(el: unknown, x: number, y: number): void
  }
}

function dragHarness(rows: Record<string, string>) {
  const ghosts: Array<{ textContent: string }> = []
  const doc = {
    getElementById: (id: string) => (id === 'emailEnvelopeList' ? {
      querySelector: (sel: string) => {
        const m = /\[data-id="([^"]+)"\]/.exec(sel)
        const from = m ? rows[m[1]] : undefined
        return from === undefined ? null : { dataset: { from } }
      },
    } : null),
    createElement: () => {
      const el = { className: '', textContent: '', remove() {} }
      return el
    },
    body: { appendChild: (el: { textContent: string }) => { ghosts.push(el) } },
  }
  const factory = new Function('document', 'CSS', 't', 'setSelection',
    `let emailSelectedIds = new Map()
     setSelection(m => { emailSelectedIds = m })
     ${extractFn(app, 'emailSenderOfRow')}
     ${extractFn(app, 'emailSetDragCount')}
     ${extractFn(app, 'emailEnvelopeDragStart')}
     ${extractFn(app, 'emailDragItems')}
     return { start: emailEnvelopeDragStart, items: emailDragItems }`)
  let setSel: (m: Map<string, string>) => void = () => {}
  const api = factory(doc, { escape: (s: string) => s },
    (k: string, v?: Record<string, unknown>) => `${k}|${JSON.stringify(v || {})}`,
    (fn: (m: Map<string, string>) => void) => { setSel = fn })
  return {
    api, ghosts,
    select: (pairs: Array<[string, string]>) => setSel(new Map(pairs)),
    drag: (dataset: Record<string, string>) => {
      const e: DragEventStub = {
        currentTarget: { dataset },
        dataTransfer: {
          effectAllowed: '', data: {},
          setData(type, value) { this.data[type] = value },
          setDragImage() {},
        },
      }
      api.start(e)
      return JSON.parse(e.dataTransfer.data['application/x-marveen-email'])
    },
  }
}

describe('huzas: a kijeloles EGESZE utazik', () => {
  it('egy kijelolt sort megfogva mind a harom kijelolt level megy', () => {
    const h = dragHarness({ a: 'egy@bolt.hu', b: 'ketto@bolt.hu', c: '' })
    h.select([['a', 'Inbox'], ['b', 'Inbox'], ['c', '[Gmail]/Kuka']])
    const payload = h.drag({ id: 'b', mailbox: 'Inbox', from: 'ketto@bolt.hu' })
    expect(payload.items.map((x: { id: string }) => x.id)).toEqual(['a', 'b', 'c'])
    // A forrasmappa is utazik: a kijelolesben lehet MAS mappabol valo sor is.
    expect(payload.items.find((x: { id: string }) => x.id === 'c').mailbox).toBe('[Gmail]/Kuka')
  })

  it('egy ki NEM jelolt sort megfogva csak az az egy megy', () => {
    const h = dragHarness({ a: 'egy@bolt.hu', z: 'z@bolt.hu' })
    h.select([['a', 'Inbox']])
    const payload = h.drag({ id: 'z', mailbox: 'Inbox', from: 'z@bolt.hu' })
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].id).toBe('z')
  })

  it('a felado a sorbol jon (a szabalyokhoz kell), hianya nem baj', () => {
    const h = dragHarness({ a: 'egy@bolt.hu', c: '' })
    h.select([['a', 'Inbox'], ['c', 'Inbox']])
    const payload = h.drag({ id: 'a', mailbox: 'Inbox', from: 'egy@bolt.hu' })
    expect(payload.items[0].from).toBe('egy@bolt.hu')
    expect(payload.items[1].from).toBe('')
  })

  it('a regi, egy-leveles payload-alak valtozatlanul megvan (visszafele kompatibilis)', () => {
    const h = dragHarness({ a: 'egy@bolt.hu' })
    h.select([])
    const payload = h.drag({ id: 'a', mailbox: 'Inbox', from: 'egy@bolt.hu' })
    expect(payload.id).toBe('a')
    expect(payload.mailbox).toBe('Inbox')
    // ...es a regi alakot a mai olvaso is elfogadja:
    expect(h.api.items({ id: 'a', mailbox: 'Inbox' })).toEqual([{ id: 'a', mailbox: 'Inbox', from: '' }])
    expect(h.api.items({})).toEqual([])
    expect(h.api.items(null)).toEqual([])
    // A csonka elemek kiesnek, nem visznek magukkal undefined azonositot.
    expect(h.api.items({ items: [{ id: 'a' }, { mailbox: 'Inbox' }, { id: 'b', mailbox: 'Inbox' }] }))
      .toEqual([{ id: 'b', mailbox: 'Inbox' }])
  })

  it('tobb levelnel odairja a huzott kep melle, hany levelrol van szo', () => {
    const h = dragHarness({ a: '', b: '' })
    h.select([['a', 'Inbox'], ['b', 'Inbox']])
    h.drag({ id: 'a', mailbox: 'Inbox' })
    expect(h.ghosts).toHaveLength(1)
    expect(h.ghosts[0].textContent).toBe('email.drag_count|{"n":2}')
  })

  it('egyetlen levelnel nincs cimke (a sima huzott sor onmagaert beszel)', () => {
    const h = dragHarness({ a: '' })
    h.select([])
    h.drag({ id: 'a', mailbox: 'Inbox' })
    expect(h.ghosts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Mappankent MAS muvelet
// ---------------------------------------------------------------------------

interface Call { url: string; body: Record<string, unknown> }

function dropHarness(opts: { failMailbox?: string; ruleFail?: boolean; importantFail?: boolean } = {}) {
  const calls: Call[] = []
  const removed: string[] = []
  const toasts: string[] = []
  let reloads = 0
  let rulesOpened = 0
  const fetchStub = (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const ok = !(url === '/api/email/label' && body.mailbox === opts.failMailbox)
      && !(url === '/api/email/rules' && opts.ruleFail)
      && !(url === '/api/email/important' && opts.importantFail)
    return Promise.resolve({ ok })
  }
  // A csik sajat gombja (emailRulesToastAction) ugyanannak a fuggvenynek a
  // resze, ezert IDE is be kell emelni: nelkule az ELES kod egy olyan nevre
  // hivatkozik, ami a sandboxban nem letezik, es a teszt "is not defined"-dal
  // bukik -- nem azert, mert a viselkedes rossz. A szabalykezelo ablak
  // megnyitasa kifele stub: azt szamoljuk, nem nyitjuk.
  const factory = new Function('fetch', 'emailAccount', 'emailMailbox', 'emailRemoveRowFromList',
    'showToast', 't', 'loadEmailEnvelopes', 'openEmailRulesModal',
    `${extractFn(app, 'emailMoveDraggedTo')}
     ${extractFn(app, 'emailDraggedSenders')}
     ${extractFn(app, 'emailAddSenderRule')}
     ${extractFn(app, 'emailRulesToastAction')}
     ${extractFn(app, 'emailDropOnSystem')}
     return { drop: emailDropOnSystem, move: emailMoveDraggedTo, senders: emailDraggedSenders }`)
  const api = factory(fetchStub, 'lackor2', 'Inbox',
    (id: string) => { removed.push(String(id)) },
    (msg: string) => { toasts.push(msg) },
    (k: string, v?: Record<string, unknown>) => `${k}|${JSON.stringify(v || {})}`,
    () => { reloads++ },
    () => { rulesOpened++ })
  return { api, calls, removed, toasts, reloads: () => reloads, rulesOpened: () => rulesOpened }
}

const item = (id: string, mailbox = 'Inbox', from = 'info@bolt.hu') => ({ id, mailbox, from })

describe('emailMoveDraggedTo: forrasmappankent egy hivas', () => {
  it('ket forrasmappa = ket hivas, a sajat azonositoival', async () => {
    const h = dropHarness()
    const r = await h.api.move([item('a'), item('b'), item('c', '[Gmail]/Spam')], 'Munka')
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].body).toMatchObject({ account: 'lackor2', mailbox: 'Inbox', ids: ['a', 'b'], target: 'Munka' })
    expect(h.calls[1].body).toMatchObject({ mailbox: '[Gmail]/Spam', ids: ['c'] })
    expect(r.ok).toBe(true)
    expect(r.moved).toEqual(['a', 'b', 'c'])
  })

  it('csak a SIKERES csoport sorai tunnek el a listabol', async () => {
    const h = dropHarness({ failMailbox: 'Inbox' })
    const r = await h.api.move([item('a'), item('c', '[Gmail]/Spam')], 'Munka')
    expect(r.ok).toBe(false)
    expect(r.moved).toEqual(['c'])
    // 'a' a helyen marad: elhasalt mozgatas utan elrejteni rosszabb lenne.
    expect(h.removed).toEqual([])
  })

  it('csak a NYITOTT mappa sorait veszi ki (a masik mappa sora ugyis lathatatlan)', async () => {
    const h = dropHarness()
    await h.api.move([item('a'), item('c', '[Gmail]/Spam')], 'Munka')
    expect(h.removed).toEqual(['a'])
  })

  it('halozati hiba nem dobja el a huzast, csak sikertelen lesz', async () => {
    const calls: Call[] = []
    const factory = new Function('fetch', 'emailAccount', 'emailMailbox', 'emailRemoveRowFromList',
      `${extractFn(app, 'emailMoveDraggedTo')} return emailMoveDraggedTo`)
    const move = factory(() => Promise.reject(new Error('halozat')), 'lackor2', 'Inbox', () => { calls.push({ url: '', body: {} }) })
    const r = await move([item('a')], 'Munka')
    expect(r.ok).toBe(false)
    expect(r.moved).toEqual([])
  })
})

describe('emailDraggedSenders: kibol lesz szabaly', () => {
  it('mindegyik feladobol egyszer, uresek nelkul, kisbetusen', () => {
    const h = dropHarness()
    expect(h.api.senders([item('a', 'Inbox', 'Info@Bolt.hu'), item('b', 'Inbox', 'info@bolt.hu'), item('c', 'Inbox', '')]))
      .toEqual(['info@bolt.hu'])
  })
})

describe('emailDropOnSystem: mappankent mas muvelet', () => {
  it('Kuka: valodi athelyezes, szabaly nelkul', async () => {
    const h = dropHarness()
    await h.api.drop('trash', [item('a'), item('b')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/label'])
    expect(h.calls[0].body.target).toBe('[Gmail]/Kuka')
    expect(h.toasts[0]).toBe('email.drag_trash_done|{"n":2}')
  })

  it('Spam: athelyezes ES a felado megjegyzese', async () => {
    const h = dropHarness()
    await h.api.drop('spam', [item('a', 'Inbox', 'Info@Bolt.hu'), item('b', 'Inbox', 'info@bolt.hu')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/label', '/api/email/rules'])
    expect(h.calls[0].body.target).toBe('[Gmail]/Spam')
    expect(h.calls[1].body).toMatchObject({ account: 'lackor2', kind: 'spam', senders: ['info@bolt.hu'] })
    expect(h.toasts[0]).toContain('email.drag_spam_done')
  })

  it('Spam: ha a mozgatas nem sikerult, NEM szuletik nema szabaly', async () => {
    const h = dropHarness({ failMailbox: 'Inbox' })
    await h.api.drop('spam', [item('a')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/label'])
    expect(h.toasts).toEqual(['email.drag_move_fail|{}'])
  })

  it('Spam: sikeres mozgatas + bukott szabaly = megmondja, hogy a kovetkezo level meg jonni fog', async () => {
    const h = dropHarness({ ruleFail: true })
    await h.api.drop('spam', [item('a')])
    expect(h.toasts[0]).toBe('email.drag_spam_no_rule|{"n":1}')
  })

  it('Spam: felado nelkuli levelnel is athelyez, csak nem tanul', async () => {
    const h = dropHarness()
    await h.api.drop('spam', [item('a', 'Inbox', '')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/label'])
    expect(h.toasts[0]).toBe('email.drag_spam_no_rule|{"n":1}')
  })

  it('Promociok: NEM mozgat semmit -- ott nincs mappa, csak szabaly', async () => {
    const h = dropHarness()
    await h.api.drop('promo', [item('a', 'Inbox', 'hir@bolt.hu')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/rules'])
    expect(h.calls[0].body).toMatchObject({ kind: 'promo', senders: ['hir@bolt.hu'] })
    // A lista ujratoltodik: a level MOST kerul at a Promociok nezetbe.
    expect(h.reloads()).toBe(1)
  })

  it('Promociok: felado nelkul nincs mit megjegyezni, es ezt meg is mondja', async () => {
    const h = dropHarness()
    await h.api.drop('promo', [item('a', 'Inbox', '')])
    expect(h.calls).toEqual([])
    expect(h.toasts).toEqual(['email.drag_promo_no_sender|{}'])
    expect(h.reloads()).toBe(0)
  })

  it('Fontos: JELOLES, nem athelyezes -- a level a bejovoben marad', async () => {
    const h = dropHarness()
    await h.api.drop('important', [item('a'), item('b')])
    expect(h.calls.map(c => c.url)).toEqual(['/api/email/important', '/api/email/important'])
    expect(h.calls[0].body).toMatchObject({ account: 'lackor2', mailbox: 'Inbox', id: 'a', important: true })
    // Egyetlen mozgatas sem: ez volt a legveszelyesebb elrontasi mod.
    expect(h.calls.some(c => c.url === '/api/email/label')).toBe(false)
    expect(h.removed).toEqual([])
    expect(h.toasts[0]).toBe('email.drag_important_done|{"n":2}')
  })

  it('Fontos: ha barmelyik jeloles elhasal, azt megmondja', async () => {
    const h = dropHarness({ importantFail: true })
    await h.api.drop('important', [item('a')])
    expect(h.toasts).toEqual(['email.drag_move_fail|{}'])
  })

  it('ures huzas semmit sem csinal', async () => {
    const h = dropHarness()
    await h.api.drop('trash', [])
    expect(h.calls).toEqual([])
    expect(h.toasts).toEqual([])
  })
})

describe('melyik mappa celpont egyaltalan', () => {
  const map = app.slice(app.indexOf('const EMAIL_SYSTEM_DROP_KIND'), app.indexOf('function emailBindDropTarget'))

  it('Kuka, Spam, Fontos igen', () => {
    expect(map).toContain("'[Gmail]/Kuka': 'trash'")
    expect(map).toContain("'[Gmail]/Spam': 'spam'")
    expect(map).toContain("'[Gmail]/Fontos': 'important'")
  })

  it('Bejovo, Elkuldott, Piszkozatok, Osszes level NEM -- oda huzni ertelmetlen vagy karos', () => {
    for (const mailbox of ['Inbox', 'Elküldött', 'Piszkozatok', 'Összes levél', 'Csillagozott']) {
      expect(map, `nem lehet celpont: ${mailbox}`).not.toContain(mailbox)
    }
  })

  it('a Promociok agat ELOBB nezi, mint a mappanevet (data-mailbox="Inbox" van rajta)', () => {
    const loop = app.slice(app.indexOf(".email-mailbox-item[data-mailbox]:not(.email-mailbox-item-label)"))
    const bind = loop.slice(0, loop.indexOf('emailUpdateMailboxBulkDeleteUI'))
    expect(bind.indexOf("dataset.promo === '1'")).toBeGreaterThanOrEqual(0)
    expect(bind.indexOf("dataset.promo === '1'"), 'kulonben a Promociok az Inboxra hivatkozna')
      .toBeLessThan(bind.indexOf('EMAIL_SYSTEM_DROP_KIND[el.dataset.mailbox]'))
  })

  it('a huzas felhasznalja a kijelolest (a kovetkezo huzas ne vigye ujra ugyanazt)', () => {
    const bind = extractFn(app, 'emailBindDropTarget')
    expect(bind).toContain('emailSelectedIds = new Map()')
    expect(bind).toContain('cb.checked = false')
    expect(bind).toContain('emailUpdateBulkDeleteUI()')
    // A takaritas a muvelet UTAN fut, kulonben ures listaval indulna a huzas.
    expect(bind.indexOf('await onDrop(items)')).toBeLessThan(bind.indexOf('emailSelectedIds = new Map()'))
  })

  it('mindket sorfajta (fosor es szal-alsor) viszi a feladot', () => {
    expect(app).toMatch(/class="email-envelope-item[^`]*data-from=/)
    expect(app).toMatch(/class="email-envelope-subrow[^`]*data-from=/)
  })
})

// ---------------------------------------------------------------------------
// 4. Szerveroldal: a szabaly tenyleg hasson, de ne tuntessen el levelet
// ---------------------------------------------------------------------------

describe('applyInboxRules: a bejovo listazasa', () => {
  const fn = route.slice(route.indexOf('async function applyInboxRules'), route.indexOf('// A message\'s text/html'))

  it('csak a Bejovore fut (a mozgatas forrasmappaja fixen Inbox)', () => {
    expect(fn).toContain("'-f', 'Inbox'")
    const callSites = [...route.matchAll(/await applyInboxRules\(/g)]
    expect(callSites, 'mindket listazasi ut (direkt IMAP + himalaya)').toHaveLength(2)
    for (const m of callSites) {
      expect(route.slice(Math.max(0, (m.index ?? 0) - 400), m.index), 'a hivas Inbox-agban van')
        .toContain("mailbox === 'Inbox'")
    }
  })

  it('csak a SIKERESEN atmozgatott level tunik el a listabol', () => {
    expect(fn).toContain('if (r.ok) { movedIds.add(id); movedToSpam++ }')
    expect(fn.indexOf('movedIds.add(id)'), 'a szures a mozgatas UTAN')
      .toBeLessThan(fn.indexOf('list = list.filter((e) => !movedIds.has'))
  })

  it('egy listazas nem inditvan tomeges mozgatast (felso korlat)', () => {
    expect(fn).toContain('.slice(0, SPAM_RULE_MOVE_LIMIT)')
    expect(route).toMatch(/const SPAM_RULE_MOVE_LIMIT = \d+/)
  })

  it('keresesnel nem rendezi at a postafiokot', () => {
    // moveSpam = !query: a talalati lista egy kerdes, nem a bejovo atnezese.
    // MINDKET listazasi uton -- ha csak az egyiken all, a masik uton (himalaya
    // tartalek) egy keresestol is atrendezodne a postafiok.
    const args = [...route.matchAll(/await applyInboxRules\(([^)]*)\)/g)].map(m => m[1])
    expect(args).toHaveLength(2)
    for (const a of args) expect(a, `moveSpam nem !query: ${a}`).toContain('!query')
  })

  it('a tanult felado a heurisztika MELLE szamit promonak, nem helyette', () => {
    expect(fn).toContain('isPromotionalEnvelope(')
    expect(fn).toContain("matchesRule(promoSenders, e as EnvelopeLike)")
  })

  it('az uj szabaly azonnal hat: a bejovo gyorsitotara elszall', () => {
    // A vagas a KOVETKEZO vegpontig tart: a 'return true' onmagaban rossz hatar,
    // mert a hibag is azzal zarul (ott meg nincs mit erventeleniteni).
    const post = route.slice(route.indexOf("path === '/api/email/rules' && method === 'POST'"),
      route.indexOf("path === '/api/email/rules' && method === 'DELETE'"))
    expect(post).toContain("invalidateEnvelopeCache(data.account as string, 'Inbox')")
    const del = route.slice(route.indexOf("path === '/api/email/rules' && method === 'DELETE'"),
      route.indexOf("path === '/api/email/delete'"))
    expect(del).toContain("invalidateEnvelopeCache(data.account as string, 'Inbox')")
  })

  it('a szabaly-vegpontok ismeretlen fiokot es ismeretlen fajtat visszautasitanak', () => {
    const block = route.slice(route.indexOf("path === '/api/email/rules' && method === 'GET'"),
      route.indexOf("path === '/api/email/delete'"))
    expect(block.match(/isKnownAccount/g) || []).toHaveLength(3)
    expect(block.match(/data\.kind === 'spam' \|\| data\.kind === 'promo'/g) || []).toHaveLength(2)
  })

  it('a GET csak a kerdezett fiok szabalyait adja vissza', () => {
    const get = route.slice(route.indexOf("path === '/api/email/rules' && method === 'GET'"),
      route.indexOf("path === '/api/email/rules' && method === 'POST'"))
    expect(get).toContain('loadRules().filter((r) => r.account === account)')
  })
})

// ---------------------------------------------------------------------------
// 5. Visszavonhatosag: amit megtanult, azt el is tudja felejteni
// ---------------------------------------------------------------------------

describe('szabalykezelo ablak', () => {
  it('a mappalista aljan van egy gomb, ami megnyitja', () => {
    expect(app).toContain('id="emailRulesBtn"')
    expect(app).toContain("document.getElementById('emailRulesBtn')?.addEventListener('click', () => openEmailRulesModal())")
  })

  it('minden szabalyhoz tartozik egy Visszavonas gomb', () => {
    const render = extractFn(app, 'renderEmailRulesList')
    expect(render).toContain('email.rules_undo')
    expect(render).toContain("method: 'DELETE'")
    expect(render).toContain('kind')
    expect(render).toContain('sender')
    // Torles utan ujrarajzol ES ujratolti a bejovot -- a Boss lassa is a hatast.
    expect(render).toContain('await renderEmailRulesList(overlay)')
    expect(render).toContain('loadEmailEnvelopes()')
  })

  it('Esc-re, bezaras-gombra es hatterre kattintva is eltunik -- maradek nelkul', () => {
    const open = extractFn(app, 'openEmailRulesModal')
    // A kozos Esc-figyelo csak az 'active' osztalyt venne le, ami ennel az
    // ablaknal semmit sem takar (a masik .modal-overlay szabaly ala esik) --
    // ott egy lathatatlan, kattintasfogo lap maradna a kepernyon.
    expect(open).toContain("e.key === 'Escape'")
    expect(open).toContain('overlay.remove()')
    expect(open).toContain("document.removeEventListener('keydown', onKey)")
    expect(open).toContain('if (e.target === overlay) close()')
    expect(open).toContain("overlay.querySelector('#emailRulesCloseBtn')")
  })

  it('ures lista es hibas valasz is emberi mondatot ad, nem ures dobozt', () => {
    const render = extractFn(app, 'renderEmailRulesList')
    expect(render).toContain('email.rules_empty')
    expect(render).toContain('email.rules_load_fail')
  })

  it('a felado cime escape-elve kerul a lapra (idegen szoveg a levelbol)', () => {
    const render = extractFn(app, 'renderEmailRulesList')
    expect(render).toContain('escapeHtml(r.sender)')
    expect(render).toContain('escapeAttr(r.sender)')
    expect(render).not.toMatch(/\$\{r\.sender\}/)
  })
})

describe('nyelvi kulcsok', () => {
  const used = [...new Set([...app.matchAll(/t\('(email\.(?:drag|rules)_[a-z_0-9]+)'/g)].map(m => m[1]))]

  it('talal is uj kulcsokat (kulonben a teszt semmit sem ellenoriz)', () => {
    expect(used.length).toBeGreaterThanOrEqual(8)
  })

  it('mindegyik uj kulcs megvan magyarul is, angolul is', () => {
    for (const key of used) {
      expect(hu, `hianyzik hu: ${key}`).toContain(`'${key}':`)
      expect(en, `hianyzik en: ${key}`).toContain(`'${key}':`)
    }
  })

  it('minden huzasi celpontnak van sugo-szovege (a huzhatosag nem latszik magatol)', () => {
    for (const kind of ['trash', 'spam', 'promo', 'important']) {
      expect(hu, `hianyzik hu: ${kind}`).toContain(`'email.drop_hint_${kind}':`)
      expect(en, `hianyzik en: ${kind}`).toContain(`'email.drop_hint_${kind}':`)
      // LITERAL kulccsal kell hivni. Az osszefuzott t('...' + kind) alak
      // atcsuszna itt, de a nyelvi-parity ellenorzes elol elrejtene a kulcsot
      // (es meg egy kamu 'email.drop_hint_' kulcsot is jelentene).
      expect(app, `nem literal t() hivas: ${kind}`).toContain(`t('email.drop_hint_${kind}')`)
    }
    expect(app).toContain('const hint = EMAIL_DROP_HINT[kind]')
    expect(app).toContain('if (hint) el.title = hint()')
    expect(app, 'osszefuzott nyelvi kulcs (a parity-ellenorzes megvakul tole)')
      .not.toContain("t('email.drop_hint_' +")
  })

  it('a szabalykezelo ablak kulcsai is (ezek nem t(...) hivasbol latszanak)', () => {
    for (const key of ['email.rules_btn', 'email.rules_title', 'email.rules_help',
      'email.rules_spam_section', 'email.rules_promo_section']) {
      expect(hu, `hianyzik hu: ${key}`).toContain(`'${key}':`)
      expect(en, `hianyzik en: ${key}`).toContain(`'${key}':`)
    }
  })

  it('a spam- es promo-uzenet megmondja, hol lehet visszavonni', () => {
    // "hulyebiztos" kovetelmeny: a tanulas nem lehet zsakutca.
    const huSpam = /'email\.drag_spam_done':\s*'([^']*)'/.exec(hu)
    const huPromo = /'email\.drag_promo_done':\s*'([^']*)'/.exec(hu)
    expect(huSpam?.[1]).toMatch(/vissza/i)
    expect(huPromo?.[1]).toMatch(/vissza/i)
  })

  it('a mar nem hasznalt regi kulcs nem maradt bent', () => {
    expect(app).not.toContain("t('email.drag_move_success'")
    expect(hu).not.toContain("'email.drag_move_success':")
    expect(en).not.toContain("'email.drag_move_success':")
  })
})

describe('megjelenes', () => {
  it('a huzott darabszam-cimke a kepernyon kivul szuletik (ne villanjon be)', () => {
    const rule = css.slice(css.indexOf('.email-drag-ghost'), css.indexOf('.email-drag-ghost') + 400)
    expect(rule).toContain('position: absolute')
    expect(rule).toMatch(/top: -\d+px/)
    expect(rule).toContain('pointer-events: none')
  })

  it('a szabalykezelo gomb es lista is fel van oltoztetve', () => {
    for (const cls of ['.email-mailbox-rules', '.email-rules-list', '.email-rules-row',
      '.email-rules-empty', '.email-rules-modal', '.email-rules-actions']) {
      expect(css, `hianyzik CSS: ${cls}`).toContain(cls)
    }
  })
})

describe('serult szabaly-fajl: a regi szabalyok nem tunhetnek el', () => {
  it('a betoltes FELRETESZI az olvashatatlan fajlt', () => {
    // A hivasi minta `saveRules(addRule(loadRules(), ...))`. Ha a betoltes egy
    // serult fajlra uresset ad vissza, a kovetkezo mentes RAIR -- es a Boss
    // osszes korabbi szabalya nyomtalanul eltunik, uzenet nelkul.
    const forras = readFileSync(join(ROOT, 'src', 'email-rules.ts'), 'utf8')
    expect(forras).toContain('renameSync(RULES_PATH, `${RULES_PATH}.serult-')
    // A felretetel elhasalasa nem allithatja meg az Email oldalt.
    expect(forras).toContain('} catch { /* ha nem megy, akkor is szabaly nelkul megyunk tovabb */ }')
    // ...es a felretetel a `return []` ELOTT all, kulonben sose futna le.
    const catchIdx = forras.indexOf('Serult fajl nem allithatja meg')
    expect(forras.indexOf('renameSync(RULES_PATH', catchIdx))
      .toBeLessThan(forras.indexOf('return []', catchIdx))
  })
})
