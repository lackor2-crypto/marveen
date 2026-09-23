// statusLine wiring (fresh-install audit f97acc32, 2026-09-23).
//
// scripts/hooks/statusline.py is the ONLY producer of
// store/rate-limit-status/<agent>.json. Before ensureStatusLine() existed the
// statusLine key was set by hand or by scripts/install-statusline.sh -- which no
// installer ran -- so on a fresh install rate-limit-guard and the Overview keret
// widget had nothing to read, and nothing said so.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

vi.mock('../config.js', async (importOriginal) => {
  const { buildFakeProjectRootConfig } = await import('./helpers/fake-project-root.js')
  return buildFakeProjectRootConfig(await importOriginal())
})

import { ensureStatusLine, statusLineCommand, agentSettingsPath } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

const TEST_AGENT = 'statusline-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
})

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8'))
}

describe('ensureStatusLine', () => {
  it('wires the statusLine into an agent that has none, and is idempotent', () => {
    mkdirSync(testAgentDir, { recursive: true })
    expect(ensureStatusLine(TEST_AGENT)).toBe(true)
    const s = readSettings()
    expect(s.statusLine).toEqual({ type: 'command', command: statusLineCommand(TEST_AGENT), padding: 0 })
    expect(ensureStatusLine(TEST_AGENT)).toBe(false)
  })

  it('upgrades an older statusline.py entry (e.g. the ~/.claude/hooks copy)', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(agentSettingsPath(TEST_AGENT), JSON.stringify({
      statusLine: { type: 'command', command: '/usr/bin/python3 /home/x/.claude/hooks/statusline.py', padding: 0 },
      hooks: { Stop: [] },
    }))
    expect(ensureStatusLine(TEST_AGENT)).toBe(true)
    const s = readSettings()
    expect((s.statusLine as { command: string }).command).toBe(statusLineCommand(TEST_AGENT))
    // Nothing else in the file is touched.
    expect(s.hooks).toEqual({ Stop: [] })
  })

  it('leaves a custom statusline the owner set alone', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const custom = { type: 'command', command: 'echo my-own-line' }
    writeFileSync(agentSettingsPath(TEST_AGENT), JSON.stringify({ statusLine: custom }))
    expect(ensureStatusLine(TEST_AGENT)).toBe(false)
    expect(readSettings().statusLine).toEqual(custom)
  })

  it('does not overwrite an unreadable settings file', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    writeFileSync(agentSettingsPath(TEST_AGENT), '{ not json')
    expect(ensureStatusLine(TEST_AGENT)).toBe(false)
    expect(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')).toBe('{ not json')
  })
})

describe('the wired command really produces the snapshot', () => {
  it('runs through bash and writes store/rate-limit-status/<agent>.json under the given root', () => {
    // A throwaway project root: the command is rebuilt against it so the real
    // store/ is never written.
    const root = mkdtempSync(join(tmpdir(), 'statusline-root-'))
    try {
      writeFileSync(join(root, '.env'), 'MAIN_AGENT_ID=main-x\n')
      // Only the --project-root argument is swapped; the script path stays real.
      const cmd = statusLineCommand('agent-y').split(`--project-root "${PROJECT_ROOT}"`).join(`--project-root "${root}"`)
      const r = spawnSync('bash', ['-c', cmd], {
        input: JSON.stringify({
          cwd: '/somewhere/else',
          model: { display_name: 'Test' },
          rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
        }),
        encoding: 'utf-8',
      })
      expect(r.status).toBe(0)
      const out = join(root, 'store', 'rate-limit-status', 'agent-y.json')
      expect(existsSync(out)).toBe(true)
      expect(readFileSync(out, 'utf-8')).toContain('42')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a missing script exits 0 silently instead of breaking the status line', () => {
    const r = spawnSync('bash', ['-c', statusLineCommand('a').replace('statusline.py', 'nope-statusline.py')], { input: '{}', encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })
})
