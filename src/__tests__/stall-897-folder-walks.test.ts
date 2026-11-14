import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #897: after the 2026-11-14 deploy the live /api/perf/stalls still showed a 0.84 s hold in reconcileFolderMarkersSteps'
// walk (a synchronous readdirSync inside a stepping generator: the yielding drain cannot hand the loop back DURING one
// read). The folder walks of the Workbench ask for each folder read through the stepping protocol (`yield { readdir }`),
// which the yielding drain answers with the async readdir.
const src = readFileSync(join(__dirname, '..', 'workbench-assets.ts'), 'utf8')

function body(startMarker: string): string {
  const a = src.indexOf(startMarker)
  expect(a, startMarker).toBeGreaterThan(-1)
  // up to the next top-level function / export after the start
  const rest = src.slice(a + startMarker.length)
  const m = /\n(?:export )?(?:async )?function\*? /.exec(rest)
  return rest.slice(0, m ? m.index : rest.length)
}

describe('the Workbench folder walks read folders through the stepping protocol (#897)', () => {
  for (const name of ['function* walkOutsideSteps(', 'function* listWorkFoldersSteps(', 'function* reconcileFolderMarkersSteps(']) {
    it(`${name.replace('function* ', '').replace('(', '')} has no synchronous readdirSync`, () => {
      const b = body(name)
      expect(b).not.toMatch(/readdirSync\(/)
      expect(b).toContain('yield { readdir:')
    })
  }
})
