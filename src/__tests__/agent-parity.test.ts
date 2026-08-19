// Fleet-parity tests (src/agent-parity.ts).
//
// Boss, 2026-08-11, after the third time a capability existed for one agent
// only: "alapbol ha fejleszt valamit egy agentnal akor az osszeshez be kell
// kotni azonnal! nincs ilyen hogy az egyik igy fog viselkedni a masik meg ugy!"
//
// The live-install case below is the one that would have caught the actual bug:
// the image-downscale hook sat in the MAIN agent's settings for weeks while
// sub-agents read full-resolution photos into their context, and nothing in the
// repo could tell.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  findParityDrift,
  describeParityDrift,
  hookScriptNames,
  MAIN_ONLY_HOOKS,
  SUBAGENT_ONLY_HOOKS,
  FLEET_WIDE_BY_CODE,
} from '../agent-parity.js'

const REPO_ROOT = join(__dirname, '..', '..')
const TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'settings.json.template')

function hooksOf(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: unknown }).hooks
}

describe('hookScriptNames', () => {
  it('finds the script whatever shape the command has', () => {
    const names = hookScriptNames({
      UserPromptSubmit: [{ hooks: [
        { type: 'command', command: '/usr/bin/python3 /home/someone/.claude/hooks/telegram_progress.py' },
        { type: 'command', command: "bash -c '[ -f /opt/marveen/scripts/hooks/rate-limit-guard.py ] && exec python3 /opt/marveen/scripts/hooks/rate-limit-guard.py; exit 0'" },
      ] }],
      PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'bash {{PROJECT_ROOT}}/scripts/hooks/channel-image-resize.sh' }] }],
    })
    expect(names).toEqual(new Set(['telegram_progress.py', 'rate-limit-guard.py', 'channel-image-resize.sh']))
  })

  it('ignores prompt-type hooks and malformed input', () => {
    expect(hookScriptNames({ PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'do a thing' }] }] }).size).toBe(0)
    expect(hookScriptNames(null).size).toBe(0)
    expect(hookScriptNames({ Stop: 'not-an-array' }).size).toBe(0)
  })
})

describe('findParityDrift', () => {
  it('is silent when both sides carry the same capabilities', () => {
    const a = new Set(['x.py', 'y.sh'])
    expect(findParityDrift(a, new Set(a))).toEqual([])
  })

  it('reports a capability the main agent has and the fleet does not (the real bug)', () => {
    const drift = findParityDrift(new Set(['channel-image-resize.sh']), new Set())
    expect(drift).toEqual([{ script: 'channel-image-resize.sh', direction: 'main-only' }])
    expect(describeParityDrift(drift)).toContain('csak a fo agensnel fut')
  })

  it('reports the reverse direction too', () => {
    const drift = findParityDrift(new Set(), new Set(['voice-reply-directive.py']))
    expect(drift).toEqual([{ script: 'voice-reply-directive.py', direction: 'subagent-only' }])
  })

  it('accepts the declared main-only exception', () => {
    const mainOnly = MAIN_ONLY_HOOKS[0].script
    expect(findParityDrift(new Set([mainOnly]), new Set())).toEqual([])
  })

  it('has no sub-agent-only exceptions since the governance gates were removed (2026-08-20)', () => {
    // The email-send + self-pace gates were the only sub-agent-only hooks; the
    // owner removed them (Telegram msg 404). Any sub-agent-only entry that
    // reappears here is a new fleet-parity exception that needs a reason -- and
    // the loop below enforces the reason -- but the steady state is empty.
    expect(SUBAGENT_ONLY_HOOKS).toEqual([])
  })

  it('accepts a hook that reaches the fleet through code instead of the template', () => {
    const viaCode = FLEET_WIDE_BY_CODE[0].script
    expect(findParityDrift(new Set([viaCode]), new Set())).toEqual([])
    expect(findParityDrift(new Set(), new Set([viaCode]))).toEqual([])
  })

  it('requires a reason for every declared exception', () => {
    for (const entry of [...MAIN_ONLY_HOOKS, ...SUBAGENT_ONLY_HOOKS, ...FLEET_WIDE_BY_CODE]) {
      expect(entry.why.trim().length, `${entry.script} needs a documented reason`).toBeGreaterThan(20)
    }
  })
})

describe('the shipped template is the fleet-wide source of truth', () => {
  it('carries the capabilities every agent must have', () => {
    const names = hookScriptNames(hooksOf(TEMPLATE_PATH))
    // These are the ones whose absence has actually cost something: context
    // burned on full-size photos, and an agent that never learned it was near
    // its limit.
    expect(names).toContain('channel-image-resize.sh')
    expect(names).toContain('rate-limit-guard.py')
  })
})

describe('this install', () => {
  const mainSettings = join(homedir(), '.claude', 'settings.json')
  const agentsDir = join(REPO_ROOT, 'agents')
  const fleetSkills = join(homedir(), '.claude', 'skills')

  it.skipIf(!existsSync(mainSettings))('runs nothing the rest of the fleet is denied', () => {
    const drift = findParityDrift(hookScriptNames(hooksOf(mainSettings)), hookScriptNames(hooksOf(TEMPLATE_PATH)))
    expect(drift, describeParityDrift(drift)).toEqual([])
  })

  // The knowledge half of parity: seed-skills are rendered into the MAIN
  // agent's ~/.claude/skills at install time, and until 2026-08-11 no sub-agent
  // could see any of them -- a delegate was missing the very procedures it is
  // judged by. ensureAgentSkills() links every agent at that same library.
  it.skipIf(!existsSync(agentsDir) || !existsSync(fleetSkills))('gives every agent the same skill library', () => {
    const missing = readdirSync(agentsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => existsSync(join(agentsDir, name, '.claude')))
      .filter(name => {
        const link = join(agentsDir, name, '.claude', 'skills')
        try {
          return realpathSync(link) !== realpathSync(fleetSkills)
        } catch {
          return true
        }
      })
    expect(missing, `agents without the shared skill library: ${missing.join(', ')}`).toEqual([])
  })
})
