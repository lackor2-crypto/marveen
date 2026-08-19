// Boss, 2026-08-19: "a masodik oszlop sem toltodik be hamar. sokat kell varni
// ra." A hullamkep megmutatta, hogy nem a levellista lassu (179 ms), hanem a
// render varakozott egy masik hivasra: /api/email/thread-siblings = 5754 ms.
// Ez a teszt azt orzi, hogy a lista SOSE varjon a Sent-testverekre, es hogy az
// ezert szukseges ujrarajzolas ne kerjen le megegyszer mindent (kapocs/fontos),
// mert az meg lassabb lenne, mint az eredeti allapot.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

// A VALODI kodot futtatjuk: kivagjuk a fuggvenyt a forrasbol. Regex helyett
// zarojel-szamolas, mert a fuggvenyekben template-literal is van.
function extractConstFn(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = (`)
  if (at < 0) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let depth = 0
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

function extractBlock(src: string, head: string): string {
  const at = src.indexOf(head)
  if (at < 0) throw new Error(`nincs ilyen blokk: ${head}`)
  let depth = 0
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1) }
  }
  throw new Error(`nem zarodik: ${head}`)
}

const loadEnvelopesSrc = extractBlock(app, 'async function loadEmailEnvelopes(')

type El = { style: { display: string }, dataset: Record<string, string>, classList: { toggle: (c: string, on: boolean) => void } }

function makeAttachmentApplier() {
  const shown: string[] = []
  const fetchCalls: Array<{ mailbox: string, ids: unknown[] }> = []
  const sentItems: Array<{ id: string, messageId: string }> = []
  let nextFlags: Record<string, boolean> = {}
  const pane = {
    querySelector: (sel: string) => {
      const m = /data-id="([^"]+)"/.exec(sel)
      const id = m ? m[1] : '?'
      return { style: { set display(v: string) { if (v === '') shown.push(id) } } }
    },
  }
  const fetchStub = (_url: string, opts: { body: string }) => {
    const body = JSON.parse(opts.body)
    fetchCalls.push({ mailbox: body.mailbox, ids: (body.items || []).map((i: { id: string }) => i.id) })
    sentItems.push(...(body.items || []))
    return Promise.resolve({ json: () => Promise.resolve(nextFlags) })
  }
  const known = new Map<string, boolean>()
  const requested = new Set<string>()
  const flagKey = (mailbox: string, id: unknown) => JSON.stringify([mailbox, String(id)])
  const src = `${extractConstFn(app, 'showAttachmentFlag')}\n${extractConstFn(app, 'applyAttachmentFlags')}`
  const fn = new Function(
    'pane', 'emailAccount', 'fetch', 'CSS', 'knownAttachmentFlags', 'attachmentFlagsRequested', 'flagKey',
    `${src}; return applyAttachmentFlags`,
  )(pane, 'volmeres', fetchStub, { escape: (s: string) => s }, known, requested, flagKey)
  return {
    apply: fn as (mailbox: string, entries: Array<{ id: string, messageId: string }>) => void,
    shown, fetchCalls, sentItems, known, requested,
    setFlags: (f: Record<string, boolean>) => { nextFlags = f },
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))
// Egy listasor: a mappan beluli azonosito + a tartos cache kulcsa.
const en = (id: string) => ({ id, messageId: `<${id}@pelda.example>` })

describe('kapocs-jelzok az ujrarajzolas kozott', () => {
  it('elso rajzolaskor lekeri es kirakja a kapcsokat', async () => {
    const h = makeAttachmentApplier()
    h.setFlags({ '11': true, '12': false })
    h.apply('Inbox', [en('11'), en('12')])
    expect(h.fetchCalls).toHaveLength(1)
    expect(h.fetchCalls[0].ids).toEqual(['11', '12'])
    await tick()
    expect(h.shown, 'csak amelyikben tenyleg van csatolmany').toEqual(['11'])
  })

  it('ujrarajzolaskor lekeres NELKUL rakja vissza a mar ismert kapcsokat', async () => {
    const h = makeAttachmentApplier()
    h.setFlags({ '11': true, '12': false })
    h.apply('Inbox', [en('11'), en('12')])
    await tick()
    h.shown.length = 0
    h.apply('Inbox', [en('11'), en('12')])
    expect(h.fetchCalls, 'masodszor mar nem megyunk a szerverhez').toHaveLength(1)
    expect(h.shown, 'az innerHTML mindent visszaallitott -- ujra ki kell rakni').toEqual(['11'])
  })

  it('ujrarajzolaskor csak az UJ (testver) sorokat keri le', async () => {
    const h = makeAttachmentApplier()
    h.setFlags({ '11': true })
    h.apply('Inbox', [en('11')])
    await tick()
    h.apply('Inbox', [en('11'), en('99')])
    expect(h.fetchCalls).toHaveLength(2)
    expect(h.fetchCalls[1].ids, 'a 11-et mar tudjuk').toEqual(['99'])
  })

  it('a Message-ID-t is elkuldi -- a szerver azzal jegyzi meg tartosan', async () => {
    const h = makeAttachmentApplier()
    let sent: Array<{ id: string, messageId: string }> = []
    const orig = h.apply
    h.setFlags({ '11': true })
    orig('Inbox', [en('11')])
    sent = h.sentItems
    expect(sent[0]).toEqual({ id: '11', messageId: '<11@pelda.example>' })
    await tick()
  })

  it('ures listara nem indit hivast', () => {
    const h = makeAttachmentApplier()
    h.apply('Inbox', [])
    expect(h.fetchCalls).toHaveLength(0)
  })

  it('mappankent kulon kulcs -- az IMAP id csak mappan belul egyedi', async () => {
    const h = makeAttachmentApplier()
    h.setFlags({ '5': true })
    h.apply('Inbox', [en('5')])
    await tick()
    h.apply('[Gmail]/Elkuldott levelek', [en('5')])
    expect(h.fetchCalls[1].mailbox).toBe('[Gmail]/Elkuldott levelek')
    expect(h.fetchCalls[1].ids, 'mas mappa ugyanaz az id = mas uzenet').toEqual(['5'])
  })
})

describe('fontos-jelzok az ujrarajzolas kozott', () => {
  const makeImportant = () => {
    const buttons: El[] = [
      { style: { display: 'none' }, dataset: { messageId: 'a@pelda.example' }, classList: { toggle: () => {} } },
      { style: { display: 'none' }, dataset: { messageId: 'b@pelda.example' }, classList: { toggle: () => {} } },
    ]
    const pane = { querySelectorAll: () => buttons }
    const known = new Map<string, boolean>()
    const fn = new Function('pane', 'knownImportantFlags', `${extractConstFn(app, 'applyImportantFlags')}; return applyImportantFlags`)(pane, known)
    return { buttons, known, apply: fn as () => void }
  }

  it('amirol meg nincs valasz, annak a gombja rejtve marad', () => {
    const h = makeImportant()
    h.apply()
    expect(h.buttons.every(b => b.style.display === 'none'), 'nem villog fel talalgatott allapot').toBe(true)
  })

  it('ismert allapotot azonnal kirak (ujrarajzolas utan is)', () => {
    const h = makeImportant()
    h.known.set('a@pelda.example', true)
    h.known.set('b@pelda.example', false)
    h.apply()
    expect(h.buttons[0].style.display).toBe('')
    expect(h.buttons[0].dataset.important).toBe('1')
    expect(h.buttons[1].dataset.important).toBe('0')
  })
})

describe('a levellista nem var a Sent-testverekre', () => {
  const siblingsCall = "fetch('/api/email/thread-siblings'"

  it('nincs tobbe await-elt thread-siblings hivas', () => {
    expect(loadEnvelopesSrc.includes(`await (await ${siblingsCall}`)).toBe(false)
    expect(loadEnvelopesSrc.includes(`await ${siblingsCall}`)).toBe(false)
  })

  it('eloszor testverek nelkul rajzol, a hivas csak utana indul', () => {
    const firstRender = loadEnvelopesSrc.indexOf('renderEnvelopeRows({})')
    const siblingsFetch = loadEnvelopesSrc.indexOf(siblingsCall)
    expect(firstRender, 'az ures testver-terkeppel indulo rajzolas hianyzik').toBeGreaterThan(0)
    expect(siblingsFetch, 'a testver-hivas nem elozheti meg az elso rajzolast').toBeGreaterThan(firstRender)
  })

  it('a testverek megjovetelekor ujrarajzol -- de csak ha van mit', () => {
    const after = loadEnvelopesSrc.slice(loadEnvelopesSrc.indexOf(siblingsCall))
    expect(after.includes('requestId !== emailEnvelopeRequestId'), 'kozben mappat valthatott').toBe(true)
    expect(after.includes('!Object.keys(map).length'), 'ures valaszra felesleges ujrarajzolni').toBe(true)
    expect(after.includes('renderEnvelopeRows(map)')).toBe(true)
  })

  it('a jelzo-cache-ek a rajzolo fuggvenyen KIVUL elnek', () => {
    const renderAt = loadEnvelopesSrc.indexOf('const renderEnvelopeRows =')
    for (const name of ['knownAttachmentFlags', 'attachmentFlagsRequested', 'knownImportantFlags', 'importantFlagsRequested']) {
      const declAt = loadEnvelopesSrc.indexOf(`const ${name} =`)
      expect(declAt, `${name} deklaracio hianyzik`).toBeGreaterThan(0)
      expect(declAt, `${name} a rajzolon belul van -- minden ujrarajzolas ujra lekerne mindent`).toBeLessThan(renderAt)
    }
  })

  it('ujrarajzolaskor megmarad a gorgetesi pozicio', () => {
    const render = loadEnvelopesSrc.slice(loadEnvelopesSrc.indexOf('const renderEnvelopeRows ='))
    expect(render.includes('const scrollTop = pane.scrollTop')).toBe(true)
    expect(render.includes('pane.scrollTop = scrollTop')).toBe(true)
  })
})

// A szerveroldali fele: a Sent-boritek lista egyetlen himalaya-hivas, de hideg
// kapcsolattal 5,7 mp volt. Ugyanazt a kezelest kapja, mint a boritek-lista.
const emailRoute = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')

describe('Sent-boritek lista cache', () => {
  const loader = (() => {
    const at = emailRoute.indexOf('async function loadSentEnvelopes(')
    // A torzs a szignatura SORANAK utolso kapcsos zarojelenel kezdodik: a
    // visszateresi tipusban (Promise<{ ... }>) is van kapcsos zarojel.
    const bodyStart = emailRoute.lastIndexOf('{', emailRoute.indexOf(String.fromCharCode(10), at))
    let depth = 0
    for (let j = bodyStart; j < emailRoute.length; j++) {
      if (emailRoute[j] === '{') depth++
      else if (emailRoute[j] === '}') { depth--; if (depth === 0) return emailRoute.slice(at, j + 1) }
    }
    throw new Error('nem zarodik: loadSentEnvelopes')
  })()

  it('a testver-vegpont nem hiv kozvetlenul himalayat', () => {
    const at = emailRoute.indexOf("path === '/api/email/thread-siblings'")
    const handler = emailRoute.slice(at, at + 3000)
    expect(handler.includes('loadSentEnvelopes(')).toBe(true)
    expect(handler.includes('himalayaRead('), 'a cache-elt betolton keresztul megy').toBe(false)
  })

  it('friss cache-t azonnal ad, elavultat is -- kozben hatterben frissit', () => {
    expect(loader.includes('cacheGet(sentEnvelopeCache')).toBe(true)
    expect(loader.includes('cacheGetStale(sentEnvelopeCache')).toBe(true)
    expect(loader.includes('refreshInBackground(')).toBe(true)
  })

  it('csak sikeres lekerest tesz el -- hibas valasz nem uli meg a cache-t', () => {
    for (const m of loader.matchAll(/cacheSet\(sentEnvelopeCache/g)) {
      const before = loader.slice(Math.max(0, m.index - 120), m.index)
      expect(before.includes('.ok'), 'cacheSet csak ok valaszra').toBe(true)
    }
    expect(loader.includes('cacheSet(sentEnvelopeCache'), 'egyaltalan cache-elunk').toBe(true)
  })
})
