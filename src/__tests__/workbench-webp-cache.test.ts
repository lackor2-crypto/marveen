// #794: the WebP -> PNG conversion is a synchronous ffmpeg run that blocks the dashboard's event loop (loop lag 3-29 s
// measured around a finalize with a webp signature). It must run once per file version, not on every render.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('webp conversion is cached per file version', () => {
  const src = readFileSync(join(__dirname, '..', 'workbench-docfinal.ts'), 'utf8')
  it('readDocImage looks the PNG up before it starts ffmpeg, keyed by path, size and change time', () => {
    expect(src).toMatch(/const PNG_CACHE = new Map<string, Buffer>\(\)/)
    expect(src).toMatch(/PNG_CACHE\.get\(key\)/)
    expect(src).toMatch(/\$\{abs\}:\$\{st\.size\}:\$\{Math\.floor\(st\.mtimeMs\)\}/)
    expect(src.indexOf('PNG_CACHE.get(key)')).toBeLessThan(src.indexOf('webpToPng(data)', src.indexOf('PNG_CACHE.get(key)')))
  })
})
