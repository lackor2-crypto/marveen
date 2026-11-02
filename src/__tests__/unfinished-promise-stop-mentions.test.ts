import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #842: the Stop hook blocked a done-message that only MENTIONED the word "Folytatom" (quoted or with a suffix).
const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'unfinished-promise-stop.py')

function run(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ups-'))
  const tp = join(dir, 't.jsonl')
  const rows = [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  ]
  writeFileSync(tp, rows.map((r) => JSON.stringify(r)).join('\n'))
  const r = spawnSync('python3', ['-I', HOOK], { input: JSON.stringify({ transcript_path: tp }), encoding: 'utf8' })
  return r.stdout || ''
}

describe('unfinished-promise Stop hook: mentions are not promises', () => {
  it('blocks a real unkept promise', () => {
    expect(run('Kesz. Folytatom a #841-gyel.')).toContain('block')
  })
  it('lets a quoted mention pass', () => {
    expect(run('Stop-hook a "Folytatom"-ra logo korok ellen. Kesz.')).toBe('')
  })
  it('lets a suffixed mention pass', () => {
    expect(run('Kesz. A Folytatom-ra logo korok javitva.')).toBe('')
  })
})
