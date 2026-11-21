// #957: a Drive file already in the Life tree (same size + md5) is not pulled down again.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lifeCopyOutside } from '../web/routes/drive-sync.js'

const SRC = readFileSync(new URL('../web/routes/drive-sync.ts', import.meta.url), 'utf8')

describe('lifeCopyOutside (#957)', () => {
  const own = 'Rendszer/Tárolók/Drive/lackor2'
  it('a proven copy elsewhere in the Life tree skips the download', () => {
    expect(lifeCopyOutside({ state: 'present', where: ['Család/Digitális/a.xml'] }, own)).toBe('Család/Digitális/a.xml')
  })
  it('a copy inside the mirror itself does not count', () => {
    expect(lifeCopyOutside({ state: 'present', where: [own + '/a.xml'] }, own)).toBe('')
  })
  it('a probable / unknown / absent match never skips', () => {
    for (const state of ['probable', 'unknown', 'absent'] as const) {
      expect(lifeCopyOutside({ state, where: ['x/a.xml'] }, own)).toBe('')
    }
    expect(lifeCopyOutside(undefined, own)).toBe('')
  })
  it('the download loop asks Drive for md5 and checks the index before downloading', () => {
    expect(SRC).toMatch(/files\(id,name,mimeType,size,modifiedTime,md5Checksum/)
    expect(SRC).toMatch(/lifeCopyOutside\(m, toLifeRel\(base\)\)[\s\S]{0,120}continue[\s\S]{0,400}await downloadTo\(plan\.url/)
  })
})
