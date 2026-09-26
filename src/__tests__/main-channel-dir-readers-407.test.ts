// Card #407 (2026-09-26): after channels.sh (#915) moved the main agent's
// channel state to <install>/.claude/channels/<provider>, PR #415 taught
// channelStateDir() the new location -- but four main-agent readers bypassed it
// with a fixed ~/.claude/channels/telegram, empty after the migration:
// dead-agent-reply (the "not alive" reply), main-inbox-receipt (the receipt),
// schedule-runner (scheduler alert token) and channel-intake-monitor (intake
// backlog). This pins the wiring and guards against a new fixed path.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { channelStateDir } from '../channel-provider.js'
import { channelEnvPathFor } from '../web/channel-intake-monitor.js'
import { MAIN_AGENT_ID } from '../config.js'

const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...sourceFiles(p))
    } else if (name.endsWith('.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('main-agent channel readers resolve via channelStateDir (#407)', () => {
  it('channel-intake-monitor: the main agent reads the resolved dir', () => {
    expect(channelEnvPathFor(MAIN_AGENT_ID)).toBe(join(channelStateDir('telegram'), '.env'))
  })

  it('no source file hardcodes the main agent\'s ~/.claude/channels/<provider> dir', () => {
    // A home-rooted join ending in a bare provider name is exactly the pre-#915
    // main-agent path. Per-agent aliases (`telegram-${agent}`), provider
    // variables and the coordinator's own dir do not match.
    const fixed = /join\(\s*(?:homedir\(\)|home|process\.env\[['"]HOME['"]\][^,]*)\s*,\s*'\.claude'\s*,\s*'channels'\s*,\s*'(?:telegram|slack|discord|googlechat|teams)'\s*[,)]/
    const hits: string[] = []
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      lines.forEach((line, i) => {
        if (fixed.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits, 'use channelStateDir(provider) instead of a fixed legacy path').toEqual([])
  })
})
