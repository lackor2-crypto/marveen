// Card #350 -- one backup rule per folder, and what a backup leaves out.
//
// Measured here:
//   1. Every folder has exactly ONE effective target: its own rule, else the
//      nearest ancestor's, else none (a fresh install: no rules, no marks).
//   2. "inherit" removes a folder's own rule; "none" stops the parent's.
//   3. An unreadable rules file is reported, and never overwritten with an
//      empty list (that would silently erase every rule).
//   4. The exclude engine: folders + file types, as a non-programmer types them.
//   5. A child with its own rule is left out of the parent's backup.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setBackupRulesFileForTests, loadBackupRules, setBackupRule, effectiveRule, childExclusions,
} from '../backup-rules.js'
import { normalizeExcludes, excludeRules, isExcludedDir, isExcludedFile } from '../backup-exclude.js'

const dir = mkdtempSync(join(tmpdir(), 'marveen-bkrules-'))
const file = join(dir, 'backup-rules.json')

beforeEach(() => {
  setBackupRulesFileForTests(file)
  rmSync(file, { force: true })
})
afterAll(() => {
  setBackupRulesFileForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('effective rule', () => {
  it('fresh install: no file, no rules, nothing applies anywhere', () => {
    expect(existsSync(file)).toBe(false)
    const { rules, broken } = loadBackupRules()
    expect(rules).toEqual([])
    expect(broken).toBeNull()
    expect(effectiveRule(rules, 'A/B')).toEqual({ target: null, from: null, own: false })
  })

  it('own rule wins, children inherit the nearest ancestor', () => {
    setBackupRule({ path: 'Család/Korpás László', action: 'target', target: { kind: 'mega', account: 'lackor2' } })
    setBackupRule({ path: 'Család/Korpás László/Projektek/Tőzsde', action: 'target', target: { kind: 'drive', account: 'daytraderboss' } })
    setBackupRule({ path: 'Család/Korpás László/Projektek/Tőzsde/Fejlesztés/Metatraderek', action: 'none' })
    const { rules } = loadBackupRules()
    expect(effectiveRule(rules, 'Család/Korpás László')).toEqual({ target: { kind: 'mega', account: 'lackor2' }, from: 'Család/Korpás László', own: true })
    expect(effectiveRule(rules, 'Család/Korpás László/Média/Fotók').target).toEqual({ kind: 'mega', account: 'lackor2' })
    expect(effectiveRule(rules, 'Család/Korpás László/Média/Fotók').own).toBe(false)
    expect(effectiveRule(rules, 'Család/Korpás László/Projektek/Tőzsde/Tudásbázis').target).toEqual({ kind: 'drive', account: 'daytraderboss' })
    const mt = effectiveRule(rules, 'Család/Korpás László/Projektek/Tőzsde/Fejlesztés/Metatraderek/x')
    expect(mt.target).toBeNull()
    expect(mt.from).toBe('Család/Korpás László/Projektek/Tőzsde/Fejlesztés/Metatraderek')
    // Outside every rule: nothing.
    expect(effectiveRule(rules, 'Tudás/Oktatás').from).toBeNull()
  })

  it('inherit removes the own rule; paths are normalised', () => {
    setBackupRule({ path: '/A\\B/', action: 'none' })
    expect(loadBackupRules().rules.map((r) => r.path)).toEqual(['A/B'])
    setBackupRule({ path: 'A/B', action: 'inherit' })
    expect(loadBackupRules().rules).toEqual([])
  })

  it('the depot root can carry a rule', () => {
    setBackupRule({ path: '', action: 'target', target: { kind: 'drive', account: 'x' } })
    expect(effectiveRule(loadBackupRules().rules, 'Deep/Down').from).toBe('')
  })

  it('an unreadable file is reported, and never overwritten', () => {
    writeFileSync(file, '{ not json')
    const { rules, broken } = loadBackupRules()
    expect(rules).toEqual([])
    expect(broken).toBeTruthy()
    expect(() => setBackupRule({ path: 'A', action: 'none' })).toThrow(/unreadable/)
    expect(readFileSync(file, 'utf-8')).toBe('{ not json')
  })

  it('a child with its own rule is left out of the parent backup', () => {
    setBackupRule({ path: 'P', action: 'target', target: { kind: 'mega', account: 'a' } })
    setBackupRule({ path: 'P/X', action: 'none' })
    setBackupRule({ path: 'P/Y/Z', action: 'target', target: { kind: 'drive', account: 'b' } })
    setBackupRule({ path: 'PQ', action: 'none' }) // a sibling with a shared prefix is NOT a child
    const rules = loadBackupRules().rules
    expect(childExclusions(rules, 'P')).toEqual(['X', 'Y/Z'])
    expect(childExclusions(rules, '')).toEqual(['P', 'P/X', 'P/Y/Z', 'PQ'])
  })
})

describe('exclude engine', () => {
  it('reads what a person types, and names what it could not read', () => {
    const { list, invalid } = normalizeExcludes('*.FXT\n.hst, Projektek/Axxa/ ; \\Videók\\Filmek\n../x\n*\nfoo*bar\n*.fxt')
    expect(list).toEqual(['*.fxt', '*.hst', 'Projektek/Axxa', 'Videók/Filmek'])
    expect(invalid).toEqual(['../x', '*', 'foo*bar'])
  })

  it('folders and file types', () => {
    const r = excludeRules(['*.fxt', 'Projektek/Axxa'])
    expect(isExcludedDir(r, 'Projektek/Axxa')).toBe(true)
    expect(isExcludedDir(r, 'projektek/axxa/Sub')).toBe(true)
    expect(isExcludedDir(r, 'Projektek/AxxaMas')).toBe(false)
    expect(isExcludedFile(r, 'Tőzsde/tester/EURUSD1_0.FXT')).toBe(true)
    expect(isExcludedFile(r, 'Projektek/Axxa/a.pdf')).toBe(true)
    expect(isExcludedFile(r, 'Projektek/a.pdf')).toBe(false)
    expect(isExcludedFile(r, 'noext')).toBe(false)
    expect(isExcludedFile(excludeRules([]), 'x.fxt')).toBe(false)
  })
})
