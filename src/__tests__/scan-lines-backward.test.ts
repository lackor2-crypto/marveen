import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLinesBackward } from '../web/active-model.js'

// #377: the transcript readers used to readFileSync whole (up to 48 MB) files.
// The backward chunked reader must yield exactly what the old
// `split('\n').reverse().map(trim).filter(Boolean)` loop did.
const dir = mkdtempSync(join(tmpdir(), 'scan-back-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function naive(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).reverse()
}
function scanned(path: string): string[] {
  const out: string[] = []
  scanLinesBackward(path, l => { out.push(l); return false })
  return out
}

describe('scanLinesBackward', () => {
  it('matches the naive reverse split across many chunk boundaries, with multi-byte text', () => {
    const lines: string[] = []
    for (let i = 0; i < 20000; i++) lines.push(JSON.stringify({ i, t: 'árvíztűrő tükörfúrógép ' + '🙂'.repeat(i % 7) }))
    lines.splice(500, 0, '', '   ', '')
    const text = lines.join('\n') + '\n'
    const p = join(dir, 'big.jsonl')
    writeFileSync(p, text)
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 256 * 1024)
    expect(scanned(p)).toEqual(naive(text))
  })

  it('handles a file without a trailing newline and a single line', () => {
    const p1 = join(dir, 'a.jsonl'); writeFileSync(p1, 'one\ntwo\nthree')
    expect(scanned(p1)).toEqual(['three', 'two', 'one'])
    const p2 = join(dir, 'b.jsonl'); writeFileSync(p2, 'solo')
    expect(scanned(p2)).toEqual(['solo'])
    const p3 = join(dir, 'c.jsonl'); writeFileSync(p3, '')
    expect(scanned(p3)).toEqual([])
  })

  it('stops as soon as the visitor returns true', () => {
    const p = join(dir, 'd.jsonl'); writeFileSync(p, 'a\nb\nc\nd\n')
    const seen: string[] = []
    scanLinesBackward(p, l => { seen.push(l); return l === 'c' })
    expect(seen).toEqual(['d', 'c'])
  })
})
