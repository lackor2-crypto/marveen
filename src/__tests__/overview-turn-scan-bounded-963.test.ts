import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// #963: a 321 MB session log was read into one Buffer + one string; the Overview's count killed the dashboard (heap OOM).
describe('the user-turn scan reads a big transcript in bounded pieces', () => {
  let home: string
  let oldHome: string | undefined
  beforeEach(() => { oldHome = process.env.HOME; home = mkdtempSync(path.join(tmpdir(), 'turns963-')); process.env.HOME = home })
  afterEach(() => { process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }) })

  it('counts every turn exactly, multi-byte text across piece borders included, with no read above the piece size', async () => {
    const m = await import('../web/routes/overview.js')
    m.resetTurnCountCacheForTest(); m.resetTurnFileScansForTest()
    m.setTurnReadChunkForTest(1000)
    m.turnScanStats.maxRead = 0
    const dir = path.join(home, '.claude', 'projects', 'p1')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    let text = ''
    for (let i = 0; i < 60; i++) {
      text += JSON.stringify({ type: 'user', timestamp: new Date(now - 1000 + i).toISOString(), message: { content: 'árvíztűrő tükörfúrógép ő ű ' + 'é'.repeat(i * 3) } }) + '\n'
      text += JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: 'x'.repeat(200) } }) + '\n'
    }
    writeFileSync(path.join(dir, 's.jsonl'), text)
    expect(Buffer.byteLength(text)).toBeGreaterThan(20_000)
    expect(await m.countUserTurnsCached(now - 60_000)).toBe(60)
    expect(m.turnScanStats.maxRead).toBeLessThanOrEqual(1000)
    m.setTurnReadChunkForTest(4 * 1024 * 1024)
  })
})
