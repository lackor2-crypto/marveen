import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Stall sampler (2026-11-09): startup and the prompt-injection path held the event loop for seconds with
// sync work. These pin the async replacements; a source test cannot see runtime, so the browser/stall
// re-measure after deploy is the real check.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

describe('no synchronous stalls on startup / prompt path', () => {
  const ap = read('web/agent-process.ts')
  it('claude --help probe is warmed in the background', () => {
    expect(ap).toMatch(/function warmAutocompactProbe\(\)[\s\S]*?execFile\(claudeBin\(\), \['--help'\]/)
    expect(ap).toMatch(/\nwarmAutocompactProbe\(\)\n/)
  })
  it('resume-modal probe reads the pane asynchronously', () => {
    const fn = ap.slice(ap.indexOf('export async function dismissResumeSummaryModalIfPresent'))
    expect(fn.slice(0, 400)).toContain('await captureTmuxAsyncArgs(')
    expect(fn.slice(0, 400)).not.toContain('captureTmux(host')
  })
  it('work item folder migration runs yielding at startup', () => {
    const web = read('web.ts')
    expect(web).toContain('migrateAllWorkItemFoldersAsync()')
    expect(web).not.toMatch(/migrateAllWorkItemFolders\(\)/)
  })
})
