import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactClaudeMdFile, compactText, POINTER } from '../web/claude-md-compact.js'

const LONG = 'Ez egy hosszu szabaly. '.repeat(60)
const SAMPLE = [
  '# Cim',
  '',
  'Bevezeto.',
  '',
  '## Hosszu szabaly',
  '',
  LONG,
  '',
  '- pont egy',
  '- pont ketto',
  '',
  '## Rovid',
  '',
  'Kicsi.',
  '',
  '<!-- BEGIN GENERATED: x-rule -->',
  '## Generalt blokk',
  '',
  LONG,
  '<!-- END GENERATED: x-rule -->',
  '',
].join('\n')

describe('claude-md-compact (#799 regression: startup context diet)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cmc-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('moves a long section losslessly and shortens the file', () => {
    const f = join(dir, 'CLAUDE.md')
    writeFileSync(f, SAMPLE)
    const r = compactClaudeMdFile(f, 'main', { detailsDir: join(dir, 'details') })!
    expect(r.moved).toBe(1)
    expect(r.after).toBeLessThan(r.before)
    const out = readFileSync(f, 'utf-8')
    expect(out).toContain('## Hosszu szabaly')
    expect(out).toContain(POINTER)
    expect(out).toContain('## Rovid\n\nKicsi.')
    const files = readdirSync(join(dir, 'details'))
    expect(files).toHaveLength(1)
    const moved = readFileSync(join(dir, 'details', files[0]), 'utf-8')
    expect(moved).toContain('- pont egy')
    expect(moved).toContain('- pont ketto')
    expect(moved).toContain(LONG.trim())
  })

  it('leaves generated marker blocks untouched', () => {
    const { text } = compactText(SAMPLE, { detailsDir: join(dir, 'd') })
    expect(text).toContain('<!-- BEGIN GENERATED: x-rule -->\n## Generalt blokk\n\n' + LONG)
  })

  it('is idempotent: a second run changes nothing', () => {
    const f = join(dir, 'CLAUDE.md')
    writeFileSync(f, SAMPLE)
    const opts = { detailsDir: join(dir, 'details') }
    compactClaudeMdFile(f, 'main', opts)
    const once = readFileSync(f, 'utf-8')
    const again = compactClaudeMdFile(f, 'main', opts)!
    expect(again.moved).toBe(0)
    expect(readFileSync(f, 'utf-8')).toBe(once)
  })

  it('dry run writes nothing', () => {
    const f = join(dir, 'CLAUDE.md')
    writeFileSync(f, SAMPLE)
    const r = compactClaudeMdFile(f, 'main', { detailsDir: join(dir, 'details'), dryRun: true })!
    expect(r.moved).toBe(1)
    expect(readFileSync(f, 'utf-8')).toBe(SAMPLE)
    expect(() => readdirSync(join(dir, 'details'))).toThrow()
  })

  it('returns null for a missing file', () => {
    expect(compactClaudeMdFile(join(dir, 'nincs.md'), 'x')).toBeNull()
  })
})
