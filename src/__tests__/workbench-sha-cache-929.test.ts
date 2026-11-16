// #929: the source check hashed every document again for every quote, reading the WHOLE file on the main thread
// (measured 2026-11-16: 2.7 s stuck in readFileSync/closeSync on an idle machine). The hash is remembered per
// path + size + modification time, and a changed file is still read again.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads: string[] = []
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, readFileSync: ((p: any, ...a: any[]) => { reads.push(String(p)); return (real.readFileSync as any)(p, ...a) }) as any }
})

import { sha256OfFile } from '../workbench-docread.js'

describe('sha256OfFile remembers what it already read (#929)', () => {
  beforeEach(() => { reads.length = 0 })

  it('reads the file once for repeated calls, and again only when the file changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sha929-'))
    try {
      const f = join(dir, 'a.txt')
      writeFileSync(f, 'one')
      const h1 = sha256OfFile(f)
      for (let i = 0; i < 20; i++) expect(sha256OfFile(f)).toBe(h1)
      expect(reads.filter((p) => p === f)).toHaveLength(1)
      writeFileSync(f, 'two!')
      utimesSync(f, new Date(), new Date(Date.now() + 5000))
      const h2 = sha256OfFile(f)
      expect(h2).not.toBe(h1)
      expect(reads.filter((p) => p === f)).toHaveLength(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
