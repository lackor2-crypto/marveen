// #456 (rebuilt from upstream 9ce20239): personality generation must never overwrite
// a CLAUDE.md / SOUL.md that someone wrote while it was running.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotPersonaFile, writePersonaFileIfUnchanged, generatedSidecarPath } from '../web/persona-write-guard.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'persona-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('writePersonaFileIfUnchanged', () => {
  it('writes when the file is still absent', () => {
    const p = join(dir, 'CLAUDE.md')
    const base = snapshotPersonaFile(p)
    expect(writePersonaFileIfUnchanged(p, base, 'generated', { saveSidecarOnSkip: true }).written).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('generated')
  })
  it('writes when the file is unchanged since the snapshot', () => {
    const p = join(dir, 'SOUL.md')
    writeFileSync(p, 'scaffold')
    const base = snapshotPersonaFile(p)
    expect(writePersonaFileIfUnchanged(p, base, 'generated', { saveSidecarOnSkip: true }).written).toBe(true)
  })
  it('keeps a hand-written file and saves the generated text next to it', () => {
    const p = join(dir, 'CLAUDE.md')
    const base = snapshotPersonaFile(p)
    writeFileSync(p, 'hand written')
    const r = writePersonaFileIfUnchanged(p, base, 'generated', { saveSidecarOnSkip: true })
    expect(r.written).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe('hand written')
    expect(readFileSync(generatedSidecarPath(p), 'utf-8')).toBe('generated')
  })
  it('a template fallback never replaces a changed file and leaves no sidecar', () => {
    const p = join(dir, 'SOUL.md')
    const base = snapshotPersonaFile(p)
    writeFileSync(p, 'hand written')
    const r = writePersonaFileIfUnchanged(p, base, 'TEMPLATE', { saveSidecarOnSkip: false })
    expect(r.written).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe('hand written')
    expect(existsSync(generatedSidecarPath(p))).toBe(false)
  })
})
