import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// #966: the Overview's turn scan parsed EVERY line of a session log as JSON (a 321 MB log = millions of parses, the
// 21 s stall of 2026-11-22). Non-user lines are now skipped before JSON.parse; the count stays exact.
describe('the user-turn scan does not JSON.parse non-user lines', () => {
  let home: string
  let oldHome: string | undefined
  beforeEach(() => { oldHome = process.env.HOME; home = mkdtempSync(path.join(tmpdir(), 'turns966-')); process.env.HOME = home })
  afterEach(() => { process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('parses only the user lines and still counts them exactly', async () => {
    const m = await import('../web/routes/overview.js')
    m.resetTurnCountCacheForTest(); m.resetTurnFileScansForTest()
    const dir = path.join(home, '.claude', 'projects', 'p1')
    mkdirSync(dir, { recursive: true })
    const now = Date.now()
    let text = ''
    for (let i = 0; i < 10; i++) text += JSON.stringify({ type: 'user', timestamp: new Date(now - 1000 + i).toISOString(), message: { content: 'kerdes ' + i } }) + '\n'
    for (let i = 0; i < 200; i++) text += JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), message: { content: 'the "type":"user" word ' + i } }) + '\n'
    writeFileSync(path.join(dir, 's.jsonl'), text)
    const spy = vi.spyOn(JSON, 'parse')
    expect(await m.countUserTurnsCached(now - 60_000)).toBe(10)
    expect(spy.mock.calls.length).toBeLessThan(40)
  })
})
