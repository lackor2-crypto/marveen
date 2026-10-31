// Boss TG 3813: a scanned file (image / scanned PDF) of the Life tree can be read: the server OCRs it for the code-bridge assistant.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initDatabase } from '../db.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'

const PNG = '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'
const hasOcr = spawnSync('tesseract', ['--version']).status === 0
let dir = ''
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-readlife-'))
  process.env['MARVEEN_DEPOT'] = dir
  mkdirSync(join(dir, 'Hatosagok'), { recursive: true })
  writeFileSync(join(dir, 'Hatosagok', 'szkenn.png'), Buffer.from(PNG, 'base64'))
  writeFileSync(join(dir, 'Hatosagok', 'jegyzet.txt'), 'x')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('read-life-file endpoint', () => {
  it('404 for a missing file, 400 for a type it cannot read', async () => {
    expect((await callWorkbench('/api/workbench/read-life-file?rel=Hatosagok/nincs.png', 'GET')).status).toBe(404)
    expect((await callWorkbench('/api/workbench/read-life-file?rel=Hatosagok/jegyzet.txt', 'GET')).status).toBe(400)
    expect((await callWorkbench('/api/workbench/read-life-file?rel=../etc/passwd', 'GET')).status).toBe(404)
  })
  it.skipIf(!hasOcr)('OCRs a scanned image and returns its text', async () => {
    let text = ''
    for (let i = 0; i < 40 && !text; i++) {
      const r = await callWorkbench('/api/workbench/read-life-file?rel=Hatosagok/szkenn.png&from=1', 'GET')
      if (r.status === 200) text = JSON.stringify(r.body)
      else await new Promise((res) => setTimeout(res, 500))
    }
    expect(text.toLowerCase()).toContain('wohngeld')
  })
})

describe('code bridge prompt', () => {
  it('tells the assistant that scanned files can be read through the server and must not be given up on', () => {
    const p = buildCodeBridgePrompt({ projectName: 'P', projectFolder: null, workItem: null, history: [], message: 'olvasd el', lang: 'hu' })
    expect(p).toContain('read-life-file')
    expect(p).toContain('CAN be read')
  })
})
