import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #887: the startup attachments sweep held the event loop 1-2 s per work item (about 20 stat-heavy probes in one step).
const src = readFileSync(join(__dirname, '..', 'workbench-assets.ts'), 'utf8')
const body = src.slice(src.indexOf('function* ensureAllAttachmentsFolderSteps'), src.indexOf('#664 (Boss TG 9193)'))

describe('startup attachments sweep yields inside one item', () => {
  it('never calls the whole-item note in one step', () => {
    expect(body).not.toContain('noteItemStandardFoldersSeen(')
  })
  it('yields before every single folder probe', () => {
    const hits = body.match(/\{ yield; noteOneStandardFolder\(/g) || []
    expect(hits.length).toBe(2)
  })
})
