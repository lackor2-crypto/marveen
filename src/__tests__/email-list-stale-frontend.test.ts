// A masik fele ugyanannak a bejelentesnek (Boss, 2026-08-19: "az elso oszlop
// es masodik oszlop sem toltodik be hamar"): ha a szerver elavult, de azonnal
// hasznalhato listat ad, a frontendnek EGYSZER, csendben ujra kell kernie --
// kulonben a friss lista ott ul a cache-ben, es a felhasznalo nem latja.
//
// A masik merés ugyanabbol a hullamkepbol: a /api/email/accounts KETSZER ment
// ki az indulaskor (+464 ms / 1,03 mp es +528 ms / 1,28 mp), mert a bal menu
// es az email-oldal kulon kerte.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let depth = 0
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

// A VALODI fuggveny fut, nem egy ujrairt masolat.
const scheduleSrc = extractFn(app, 'emailScheduleStaleReload')
const makeSchedule = () => new Function(
  'EMAIL_STALE_RELOAD_MS',
  'EMAIL_STALE_RELOAD_MIN_GAP_MS',
  'emailStaleReloadLast',
  `${scheduleSrc}; return emailScheduleStaleReload`,
)(3000, 30000, new Map()) as (res: unknown, reload: () => void) => void

const resWith = (value: string | null) => ({ headers: { get: (k: string) => (k === 'X-Marveen-Stale' ? value : null) } })

describe('elavult valasz utan csendes ujratoltes', () => {
  it('elavult valaszra egyszer ujratolt', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule()
    let hivas = 0
    schedule(resWith('1'), () => { hivas++ })
    expect(hivas, 'a felhasznalo mar latja a listat -- azonnal nem toltunk ujra').toBe(0)
    vi.advanceTimersByTime(3000)
    expect(hivas).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(hivas, 'nem lancolodhat: egy elavult valasz EGY ujratoltes').toBe(1)
    vi.useRealTimers()
  })

  it('friss valaszra nem tolt ujra', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule()
    let hivas = 0
    schedule(resWith(null), () => { hivas++ })
    vi.advanceTimersByTime(60_000)
    expect(hivas).toBe(0)
    vi.useRealTimers()
  })

  it('fejlec nelkuli valaszon (pl. regi szerver) nem hasal el', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule()
    let hivas = 0
    expect(() => schedule({}, () => { hivas++ })).not.toThrow()
    vi.advanceTimersByTime(60_000)
    expect(hivas).toBe(0)
    vi.useRealTimers()
  })
})

describe('a ket oszlop hivasa', () => {
  it('mindket lista atadja a valaszt a stale-kezelonek', () => {
    expect(extractFn(app, 'loadEmailMailboxes')).toContain('emailScheduleStaleReload(mailboxesRes')
    expect(extractFn(app, 'loadEmailEnvelopes')).toContain('emailScheduleStaleReload(envRes')
  })

  it('az ujratoltes csak akkor fut le, ha meg ugyanaz a fiok/mappa van nyitva', () => {
    // Kozben a felhasznalo mar valthatott -- egy kesleltetett ujratoltes ne
    // rantsa vissza egy masik fiok listajat.
    expect(extractFn(app, 'loadEmailMailboxes')).toContain('if (emailAccount === mailboxAccount)')
    expect(extractFn(app, 'loadEmailEnvelopes')).toContain('if (requestId === emailEnvelopeRequestId)')
  })

  it('a fiok-listat csak EGYSZER kerjuk le induláskor', () => {
    // A ket hivo (bal menu + email-oldal) ugyanarra a promise-ra var.
    expect(extractFn(app, 'ensureEmailAccountNav')).toContain('return emailAccountsFetchPromise')
    const page = extractFn(app, 'loadEmailPage')
    expect(page).toContain('await ensureEmailAccountNav()')
    expect(page, 'a sajat, parhuzamos fetch-nek el kell tunnie').not.toContain("fetch('/api/email/accounts')")
  })
})
