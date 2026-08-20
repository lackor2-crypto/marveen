import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// GITIGNENV820 + CLAUDEIGN820 (upstream #1018/#1019, #932): run the shipped
// .gitignore through real `git check-ignore` in a throwaway repo.
//  - backup/copy variants of secret files must be ignored, the tracked example kept
//  - the '!.claude/settings.json' negation must actually work (a directory pattern
//    '.claude/' stops traversal, so the negation never fired)
let dir: string
const ignored = (p: string): boolean =>
  spawnSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: dir }).status === 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitignore-932-'))
  spawnSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), readFileSync(join(__dirname, '..', '..', '.gitignore'), 'utf-8'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('.gitignore secret variants and .claude negation', () => {
  it('ignores backup and copy variants of .env and of the mail-code file', () => {
    for (const p of ['.env', '.env.bak', '.env~', '.env.local', 'marveen-mail-ugyfelkod', 'marveen-mail-ugyfelkod.bak', 'token.secret.bak']) {
      expect(ignored(p), p).toBe(true)
    }
  })

  it('keeps the tracked example file visible', () => {
    expect(ignored('.env.example')).toBe(false)
  })

  it('lets the tracked .claude/settings.json through, still ignores the rest of .claude', () => {
    expect(ignored('.claude/settings.json')).toBe(false)
    expect(ignored('.claude/settings.local.json')).toBe(true)
    expect(ignored('agents/someone/.claude/settings.json')).toBe(true)
  })
})
