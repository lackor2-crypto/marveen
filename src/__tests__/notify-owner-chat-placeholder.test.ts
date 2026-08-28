// A gazda-ertesites sosem ert celba: a telepitoi helyorzo atcsuszott (ffa0eff7)
//
// Mert 2026-08-28-an: a .env-ben ALLOWED_CHAT_ID=0 all -- ez a telepito
// helyorzoje, nem chat. A "0" NEM ures sztring, ezert a notify.ts regi ore
// (`!CHANNEL_CHAT_ID`) atengedte, es minden egyiranyu ertesites chat_id=0-ra
// ment. Elo API-n merve: `getChat?chat_id=0` -> 400 "chat not found". A
// dashboard.log utolso 3000 soraban 12 elbukott kuldes, koztuk a 14:50:15-os
// keret-visszaallas csengo -- pontosan az az egy uzenet, amit Boss kert
// (hangzenet 636: "csak szolj, amikor mar ujra tudsz dolgozni").
//
// Az OWNERCHAT803 kartya ezt mar megoldotta a sendWelcomeMessage utvonalon
// (owner-chat-fresh-install.test.ts), a notifyChannel viszont kimaradt. Ez a
// fajl azt a hianyzo felet zarja le, ugyanazzal a KET kulon allitassal:
//   1. a valodi chat megkapja az uzenetet, es
//   2. a helyorzo SOSEM jut el az API-ig.
// A masodik nelkul egy mindent elnyelo implementacio is atmenne.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const REAL = '1268077055'

let home: string
let originalHome: string | undefined
let sent: Array<{ chatId: string; text: string }>
let logged: Array<{ obj: Record<string, unknown>; msg: string }>
let failWith: Error | null

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'notify-owner-'))
  mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true })
  originalHome = process.env['HOME']
  process.env['HOME'] = home
  sent = []
  logged = []
  failWith = null
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../config.js')
  vi.doUnmock('../channel-provider.js')
  vi.doUnmock('../logger.js')
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** Pair the install: this is the file the channel plugin enforces on inbound,
 *  so an id resolved from it is deliverable by construction. */
function pairWith(ids: string[]): void {
  writeFileSync(
    join(home, '.claude', 'channels', 'telegram', 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ids, groups: {}, pending: {} }),
  )
}

/** Load notify.ts with a chosen configured chat id.
 *
 *  config.ts reads ALLOWED_CHAT_ID from the .env FILE at import time, not from
 *  process.env, so the value is injected here instead of writing a .env into
 *  the checkout root -- doing that is what corrupted a live install once, and
 *  the suite has a gate against it. The transport and the logger are stubbed
 *  for the same reason the real provider cannot be used: it opens a real TLS
 *  connection to api.telegram.org. */
async function loadNotify(configuredChatId: string, token = 'fake-token') {
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return { ...actual, CHANNEL_PROVIDER: 'telegram', CHANNEL_TOKEN: token, CHANNEL_CHAT_ID: configuredChatId }
  })
  vi.doMock('../channel-provider.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../channel-provider.js')>()
    return {
      ...actual,
      getProvider: () => ({
        ...actual.getProvider('telegram'),
        formatMessage: (t: string) => t,
        splitMessage: (t: string) => [t],
        sendMessage: async (_tok: string, chatId: string, text: string) => {
          sent.push({ chatId, text })
          if (failWith) throw failWith
        },
      }),
    }
  })
  vi.doMock('../logger.js', () => ({
    logger: {
      error: (obj: Record<string, unknown>, msg: string) => { logged.push({ obj, msg }) },
      warn: (obj: unknown, msg?: string) => {
        logged.push({ obj: (typeof obj === 'object' && obj ? obj : {}) as Record<string, unknown>, msg: msg ?? String(obj) })
      },
      info: () => {}, debug: () => {},
    },
  }))
  return await import('../notify.js')
}

describe('notifyChannel: a telepitoi helyorzo (ALLOWED_CHAT_ID=0)', () => {
  it('a parositott valodi chatre kuld, es a "0" sosem jut ki', async () => {
    pairWith([REAL])
    const { notifyChannel } = await loadNotify('0')

    await notifyChannel('teszt ertesites')

    // 1. allitas: tenylegesen ment ki valami, es a gazdanak ment.
    expect(sent.length, 'az ertesitesnek ki KELL mennie').toBe(1)
    expect(sent[0].chatId).toBe(REAL)
    // 2. allitas: a helyorzo egyetlen hivasban sem szerepelt.
    for (const call of sent) expect(call.chatId).not.toBe('0')
  })

  it('parositas nelkul SEMMIT nem kuld, nem egy eleve halott kerest', async () => {
    // Ugyanaz a telepites, csak a parositas nem tortent meg. A regi kod
    // ilyenkor is meghivta az API-t "0"-val, es begyujtott egy 400-at, amit
    // senki nem olvasott. A javitas: csend, nem masik rossz keres.
    pairWith([])
    const { notifyChannel } = await loadNotify('0')

    await notifyChannel('teszt ertesites')

    expect(sent, 'gazda-chat nelkul nem mehet ki hivas').toHaveLength(0)
    expect(logged.some(l => l.msg.includes('Channel ertesites kihagyva'))).toBe(true)
  })

  it('kezzel beallitott valodi chat ID nyer a parositas felett', async () => {
    pairWith(['999999'])
    const { notifyChannel } = await loadNotify(REAL)

    await notifyChannel('teszt ertesites')

    expect(sent.map(s => s.chatId)).toEqual([REAL])
  })

  it('ha megis elbukik a kuldes, a naplo megmondja MIERT (nem ures objektum)', async () => {
    // A masodik defekt: a pino csak az `err` kulcsra alkalmazza a
    // hiba-szerializalot, igy a `firstErr`/`secondErr` alatti Error `{}`-kent
    // kerult a naplóba. Egy olvashatatlan ok "nem lattam oda", nem "nincs ok".
    pairWith([REAL])
    failWith = new Error('Telegram API 400: chat not found')
    const { notifyChannel } = await loadNotify('0')

    await notifyChannel('teszt ertesites')

    const err = logged.find(l => l.msg.includes('both delivery attempts failed'))
    expect(err, 'az elbukott kuldest naplozni kell').toBeTruthy()
    expect(String(err?.obj.firstErr)).toContain('chat not found')
    expect(String(err?.obj.secondErr)).toContain('chat not found')
    expect(err?.obj.chatId).toBe(REAL)
  })
})

// A visszateres uzenete: mostantol ez az EGYETLEN, amit a gazda kap egy
// kiesesrol (Boss, hangzenet 636), ezert kotelezoen ketnyelvu -- egy angol
// telepitesen sem maradhat magyarul.
describe('ownerWakeNotice: a visszateres uzenete ketnyelvu', () => {
  it('magyar telepitesen magyarul, angolon angolul szol', async () => {
    const { ownerWakeNotice } = await import('../web/limit-wake-runner.js')

    const hu = ownerWakeNotice('limit-reset', ['usalackor'], 'hu')
    expect(hu).toContain('usalackor')
    expect(hu).toContain('keret-ablaka')

    const en = ownerWakeNotice('limit-reset', ['usalackor'], 'en')
    expect(en).toContain('usalackor')
    expect(en).toContain('quota window is back')
    // Pozitiv kontroll: egy "mindig ugyanazt adja vissza" implementacio itt bukna.
    expect(en).not.toContain('keret-ablaka')
  })

  it('a masik ebresztesi ok is mindket nyelven megvan', async () => {
    const { ownerWakeNotice } = await import('../web/limit-wake-runner.js')
    expect(ownerWakeNotice('startup', ['a', 'b'], 'hu')).toContain('felebresztettem')
    expect(ownerWakeNotice('startup', ['a', 'b'], 'en')).toContain('restart / reconnect')
  })
})
