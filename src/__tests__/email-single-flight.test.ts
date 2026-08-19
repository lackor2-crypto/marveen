// Boss, 2026-08-19: "sokat kell varni ra." A hideg indulas kimeresekor
// kiderult, hogy ujraindulas UTAN, amig az elomelegites fut, az odaerkezo
// betoltes megegyszer elvegzi ugyanazt az IMAP-munkat: 2,9 / 8,9 mp, mikozben
// az elomelegites lefutasa utan ugyanaz 0,84 / 0,88 mp. Ez a teszt azt orzi,
// hogy ugyanaz a lekeres egyszerre csak EGYSZER fusson -- es hogy egy elszallt
// lekeres ne mergezze meg a kovetkezoket.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { singleFlight, isInFlight } from '../web/email-list-cache.js'

const EMAIL_SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf-8')

describe('ugyanaz a lekeres egyszer fut', () => {
  it('ket egyidejű kero EGY munkat inditt, es ugyanazt kapja', async () => {
    let futott = 0
    const work = async () => { futott++; await new Promise(r => setTimeout(r, 20)); return 'ertek' }
    const [a, b] = await Promise.all([singleFlight('k', work), singleFlight('k', work)])
    expect(futott, 'a masodik kero nem inditt uj IMAP-lekerest').toBe(1)
    expect([a, b]).toEqual(['ertek', 'ertek'])
  })

  it('kulonbozo kulcs kulon munka', async () => {
    let futott = 0
    const work = async () => { futott++; return futott }
    await Promise.all([singleFlight('a', work), singleFlight('b', work)])
    expect(futott).toBe(2)
  })

  it('a befejezes utan ujra lehet kerni (nem ragad be a valasz)', async () => {
    let futott = 0
    const work = async () => { futott++; return futott }
    expect(await singleFlight('c', work)).toBe(1)
    expect(isInFlight('c'), 'a kulcsot el kell engedni').toBe(false)
    expect(await singleFlight('c', work)).toBe(2)
  })

  it('a hiba mindket kerohoz eljut, es NEM mergezi meg a kovetkezot', async () => {
    const bukik = async () => { throw new Error('IMAP nem all fel') }
    const egyutt = Promise.all([singleFlight('d', bukik), singleFlight('d', bukik)])
    await expect(egyutt).rejects.toThrow('IMAP nem all fel')
    expect(isInFlight('d'), 'hiba utan is fel kell szabadulnia').toBe(false)
    expect(await singleFlight('d', async () => 'jo')).toBe('jo')
  })
})

describe('az email-lekeresek at vannak vezetve rajta', () => {
  for (const fn of ['fetchMailboxList', 'fetchEnvelopeList', 'fetchSentEnvelopes', 'fetchImportantMessageIds']) {
    it(fn + ' osszevonja az egyidejű hivasokat', () => {
      const at = EMAIL_SRC.indexOf('async function ' + fn + '(')
      expect(at, fn + ' eltunt').toBeGreaterThan(0)
      const head = EMAIL_SRC.slice(at, EMAIL_SRC.indexOf('async function ' + fn + 'Once('))
      expect(head.includes('singleFlight('), fn + ' megkeruli az osszevonast').toBe(true)
      expect(head.includes(fn + 'Once('), 'a valodi munka a Once-valtozatban van').toBe(true)
    })
  }
})

describe('indulas utani elomelegites', () => {
  const warm = (() => {
    const at = EMAIL_SRC.indexOf('export async function warmEmailCaches(')
    if (at < 0) throw new Error('nincs elomelegites')
    let depth = 0
    for (let j = EMAIL_SRC.indexOf('{', at); j < EMAIL_SRC.length; j++) {
      if (EMAIL_SRC[j] === '{') depth++
      else if (EMAIL_SRC[j] === '}') { depth--; if (depth === 0) return EMAIL_SRC.slice(at, j + 1) }
    }
    throw new Error('nem zarodik: warmEmailCaches')
  })()

  it('a lista-cache-t UGYANAZZAL a kulccsal tolti fel, amit a keres olvas', () => {
    expect(warm.includes('envelopeCacheKeyFor('), 'sajat kulcskepzes = nema tevedes').toBe(true)
    const handler = EMAIL_SRC.slice(EMAIL_SRC.indexOf("path === '/api/email/envelopes'"))
    expect(handler.slice(0, 3000).includes('envelopeCacheKeyFor('), 'a kiszolgalo is a kozos kulcsot hasznalja').toBe(true)
  })

  it('a Fontos-jelzoket es a Sent-testvereket is elore beszedi', () => {
    expect(warm.includes('loadImportantMessageIds(')).toBe(true)
    expect(warm.includes('loadSentEnvelopes(')).toBe(true)
  })

  it('fiokonkent SOROSAN megy -- parhuzamosan ujra torlodast csinalna', () => {
    expect(warm.includes('for (const acc of getAccounts())')).toBe(true)
    expect(warm.includes('Promise.all('), 'parhuzamos inditas').toBe(false)
  })

  it('egy elszallt elomelegites nem allithatja meg a tobbit', () => {
    expect(warm.includes('catch (err)')).toBe(true)
    expect(warm.includes('logger.warn(')).toBe(true)
  })

  it('a szerver az indulas UTAN, kesleltetve hivja, es nem tartja eletben a folyamatot', () => {
    const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const at = web.indexOf('warmEmailCaches()')
    expect(at, 'a szerver el sem inditja az elomelegitest').toBeGreaterThan(0)
    const line = web.slice(web.lastIndexOf('setTimeout', at), web.indexOf(String.fromCharCode(10), at))
    expect(line.includes('unref()'), 'fuggo elomelegites nem tarthatja eletben a folyamatot').toBe(true)
  })
})
