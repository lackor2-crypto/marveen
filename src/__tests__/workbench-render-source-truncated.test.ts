// Boss (2026-11-03, "a 78M-et nem generalja le a PDF-et ... erre is irj tesztet"): a restart in the middle of writing a render
// source left a zero-byte .fodt under the content's hash; "the file exists" was taken as "it is right", so that exact content
// was converted from an EMPTY file (a blank page) every time afterwards. A source file counts only when it has the size of its
// content, and it is written atomically.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSourceFile } from '../workbench-docrender.js'

describe('the render source file is never an empty or half file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'))
  const xml = '<?xml version="1.0"?><doc>Tisztelt Minijob-Zentrale! árvíztűrő</doc>'

  it('a missing file is written', () => {
    const p = join(dir, 'a.fodt')
    expect(ensureSourceFile(p, xml)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(xml)
  })

  it('an intact file is left alone (same content, same timestamp: the PDF cache keeps working)', () => {
    const p = join(dir, 'b.fodt')
    ensureSourceFile(p, xml)
    const m = statSync(p).mtimeMs
    expect(ensureSourceFile(p, xml)).toBe(false)
    expect(statSync(p).mtimeMs).toBe(m)
  })

  it('a ZERO-BYTE file under the hash is written again (the 78M blank page)', () => {
    const p = join(dir, 'c.fodt')
    writeFileSync(p, '')
    expect(ensureSourceFile(p, xml)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(xml)
  })

  it('a half-written file is written again', () => {
    const p = join(dir, 'd.fodt')
    writeFileSync(p, xml.slice(0, 20))
    expect(ensureSourceFile(p, xml)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(xml)
  })

  it('leaves no temp file behind', () => {
    const left = readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    expect(left).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

import { usableCachedPdf } from '../office-convert.js'
describe('a zero-byte cached PDF is not a cached PDF', () => {
  it('is removed and counts as missing', () => {
    const d = mkdtempSync(join(tmpdir(), 'pdf-'))
    const p = join(d, 'x.pdf')
    writeFileSync(p, '')
    expect(usableCachedPdf(p)).toBe(false)
    expect(readdirSync(d)).toEqual([])
    writeFileSync(p, '%PDF-1.7')
    expect(usableCachedPdf(p)).toBe(true)
    rmSync(d, { recursive: true, force: true })
  })
})
