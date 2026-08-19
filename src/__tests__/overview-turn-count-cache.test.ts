// Boss, 2026-08-19: "az elso oszlop es masodik oszlop sem toltodik be hamar.
// sokat kell varni ra." A meres szerint az email-vegpontok onmagukban 2-5 ms
// alatt valaszolnak -- a varakozast az okozta, hogy indulaskor az /api/overview
// EGYEDUL 1056 ms volt, es mivel a Node egy szalon fut, addig minden mas keres
// is allt. A dragasag a munkamenet-naplok (JSONL) szinkron atolvasasa volt.
//
// Sandbox KENYSZERITVE (lasd settings-store.test.ts, 2026-07-27 eset): a
// naplok helyet a homedir() adja, ezert azt kell elobb elteriteni.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'overview-turns-'))
const PROJECTS = join(SANDBOX, '.claude', 'projects', 'proj1')

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => SANDBOX, default: { ...actual, homedir: () => SANDBOX } }
})

const { countUserTurnsCached, resetTurnCountCacheForTest } = await import('../web/routes/overview.js')
const OVERVIEW_SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'overview.ts'), 'utf-8')

const NOW = Date.now()
const FROM = NOW - 3600_000
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function writeSession(lines: unknown[]): void {
  mkdirSync(PROJECTS, { recursive: true })
  writeFileSync(join(PROJECTS, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

beforeEach(() => { resetTurnCountCacheForTest() })
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('felhasznaloi korok szamolasa', () => {
  it('csak a valodi felhasznaloi koroket szamolja', async () => {
    writeSession([
      { type: 'user', timestamp: at(60_000), message: { content: 'szia' } },
      { type: 'user', timestamp: at(50_000), message: { content: '<local-command-stdout>x' } },
      { type: 'user', timestamp: at(40_000), isMeta: true, message: { content: 'rendszer' } },
      { type: 'user', timestamp: at(30_000), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', timestamp: at(20_000), message: { content: 'valasz' } },
      { type: 'user', timestamp: at(10_000), message: { content: [{ type: 'text', text: 'megegy' }] } },
      'ez nem json',
    ])
    expect(await countUserTurnsCached(FROM)).toBe(2)
  })

  it('a naplon kivuli idoszakot nem szamolja bele', async () => {
    writeSession([
      { type: 'user', timestamp: at(60_000), message: { content: 'mai' } },
      { type: 'user', timestamp: new Date(NOW - 10 * 24 * 3600_000).toISOString(), message: { content: 'regi' } },
    ])
    expect(await countUserTurnsCached(FROM)).toBe(1)
  })
})

describe('a szamlalas nem tartja fel a tobbi kerest', () => {
  it('egy percig nem szamol ujra', async () => {
    writeSession([{ type: 'user', timestamp: at(60_000), message: { content: 'egy' } }])
    expect(await countUserTurnsCached(FROM)).toBe(1)
    writeSession([
      { type: 'user', timestamp: at(60_000), message: { content: 'egy' } },
      { type: 'user', timestamp: at(5_000), message: { content: 'ketto' } },
    ])
    expect(await countUserTurnsCached(FROM), 'a friss cache-t hasznalja, nem olvassa ujra a naplokat').toBe(1)
  })

  it('lejarat utan AZONNAL a regi szamot adja, es hatterben frissit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, now: NOW })
    try {
      writeSession([{ type: 'user', timestamp: at(60_000), message: { content: 'egy' } }])
      expect(await countUserTurnsCached(FROM)).toBe(1)
      writeSession([
        { type: 'user', timestamp: at(60_000), message: { content: 'egy' } },
        { type: 'user', timestamp: at(5_000), message: { content: 'ketto' } },
      ])
      vi.setSystemTime(NOW + 61_000)
      expect(await countUserTurnsCached(FROM), 'a felhasznalo nem var: a regi szam megy ki').toBe(1)
      // a hatter-frissites befejezodik...
      await vi.waitFor(async () => { expect(await countUserTurnsCached(FROM)).toBe(2) })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a naplo-olvasas nem blokkolja az esemenyhurkot', () => {
  const body = (() => {
    const start = OVERVIEW_SRC.indexOf('async function countUserTurns(')
    const bodyStart = OVERVIEW_SRC.lastIndexOf('{', OVERVIEW_SRC.indexOf(String.fromCharCode(10), start))
    let depth = 0
    for (let j = bodyStart; j < OVERVIEW_SRC.length; j++) {
      if (OVERVIEW_SRC[j] === '{') depth++
      else if (OVERVIEW_SRC[j] === '}') { depth--; if (depth === 0) return OVERVIEW_SRC.slice(start, j + 1) }
    }
    throw new Error('nem zarodik: countUserTurns')
  })()

  it('nincs szinkron fajlmuvelet a naplo-bejarasban', () => {
    for (const sync of ['readFileSync', 'readdirSync', 'statSync']) {
      expect(body.includes(sync), `${sync} visszakerult -- ez alatt az egesz dashboard all`).toBe(false)
    }
    expect(body.includes('await readFile(')).toBe(true)
  })

  it('a vegpont a cache-elt valtozatot hivja', () => {
    const handler = OVERVIEW_SRC.slice(OVERVIEW_SRC.indexOf("path === '/api/overview'"))
    expect(handler.includes('await countUserTurnsCached(')).toBe(true)
    expect(handler.includes('countUserTurns(startTs)'), 'kozvetlen, cache nelkuli hivas').toBe(false)
  })
})
