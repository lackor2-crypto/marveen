// Card 01b7724f -- the backup map can point a folder at Google Photos, and
// share one folder's loose files over several accounts (one Google account
// holds 15 GB; a family's photo folder holds 24 GB). Setting this uploads nothing.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setBackupRulesFileForTests, backupRulesFile, loadBackupRules, setBackupRule, setBackupSplit, splitAccountFor, effectiveRule,
} from '../backup-rules.js'
import { splitText } from '../web/routes/storages.js'

const dir = mkdtempSync(join(tmpdir(), 'marveen-bkphotos-'))
beforeEach(() => { setBackupRulesFileForTests(join(dir, 'backup-rules.json')); rmSync(backupRulesFile(), { force: true }) })
afterAll(() => { setBackupRulesFileForTests(null); rmSync(dir, { recursive: true, force: true }) })

const P = 'Média/Fotók/Jutka család/Atilla'
const photos = (account: string) => ({ kind: 'photos' as const, account })

describe('Google Photos as a backup target', () => {
  it('a photos rule is kept (an unknown kind would load as "not backed up")', () => {
    setBackupRule({ path: P, action: 'target', target: photos('punasimogato') })
    const { rules } = loadBackupRules()
    expect(rules[0].target).toEqual(photos('punasimogato'))
    expect(effectiveRule(rules, P + '/x').target?.kind).toBe('photos')
  })

  it('shares loose files by name: own account before the first border, each entry up to the next', () => {
    setBackupRule({ path: P, action: 'target', target: photos('punasimogato') })
    setBackupSplit(P, [{ account: 'volmeres', from: 'M' }, { account: 'nyalomapuncidma', from: 'IMG_1000.jpg' }])
    const rule = loadBackupRules().rules[0]
    expect(rule.split?.map((s) => s.account)).toEqual(['nyalomapuncidma', 'volmeres']) // sorted by name border: "img_1000.jpg" < "m"
    expect(splitAccountFor(rule, '20170308.mp4')).toBe('punasimogato')
    expect(splitAccountFor(rule, 'IMG_1000.jpg')).toBe('nyalomapuncidma')
    expect(splitAccountFor(rule, 'img_1999.JPG')).toBe('nyalomapuncidma')
    expect(splitAccountFor(rule, 'Zebra.jpg')).toBe('volmeres')
    expect(splitText(rule, 'punasimogato')).toBe('< IMG_1000.jpg')
    expect(splitText(rule, 'nyalomapuncidma')).toBe('IMG_1000.jpg … < M')
    expect(splitText(rule, 'volmeres')).toBe('≥ M')
  })

  it('refuses a split on a folder that is not a Google Photos rule, and a repeated account or border', () => {
    setBackupRule({ path: 'Cégek', action: 'target', target: { kind: 'drive', account: 'a' } })
    expect(() => setBackupSplit('Cégek', [{ account: 'b', from: 'X' }])).toThrow('no_photos_rule')
    setBackupRule({ path: P, action: 'target', target: photos('a') })
    expect(() => setBackupSplit(P, [{ account: 'a', from: 'X' }])).toThrow('bad_split')
    expect(() => setBackupSplit(P, [{ account: 'b', from: 'X' }, { account: 'c', from: 'x' }])).toThrow('bad_split')
    expect(() => setBackupSplit(P, [{ account: 'b', from: '' }])).toThrow('bad_split')
  })

  it('moving the folder to another account keeps the split only while it stays Google Photos; an empty list removes it', () => {
    setBackupRule({ path: P, action: 'target', target: photos('a') })
    setBackupSplit(P, [{ account: 'b', from: 'M' }])
    setBackupRule({ path: P, action: 'target', target: photos('c') })
    expect(loadBackupRules().rules[0].split).toEqual([{ account: 'b', from: 'M' }])
    setBackupRule({ path: P, action: 'target', target: { kind: 'drive', account: 'c' } })
    expect(loadBackupRules().rules[0].split).toBeUndefined()
    expect(readFileSync(backupRulesFile(), 'utf-8')).not.toContain('split')
    setBackupRule({ path: P, action: 'target', target: photos('a') })
    setBackupSplit(P, [{ account: 'b', from: 'M' }])
    setBackupSplit(P, [])
    expect(loadBackupRules().rules[0].split).toBeUndefined()
  })
})
