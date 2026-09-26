// Owner report TG 6547 (2026-09-26): the Overview self-check said "Telegram
// pairing not set up" on a paired install. channels.sh (#915) had moved the
// main agent's channel state to <install>/.claude/channels/<provider>, but
// channelStateDir() still returned the shared ~/.claude path, now empty.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home = ''
vi.mock('node:os', async (orig) => {
  const m = await orig<typeof import('node:os')>()
  return { ...m, homedir: () => home }
})
const { channelStateDir, legacyChannelStateDir } = await import('../channel-provider.js')

let root = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'csd-home-'))
  root = mkdtempSync(join(tmpdir(), 'csd-root-'))
})
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) })

const put = (dir: string, file: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, file), 'x') }

describe('channelStateDir (main agent, #915)', () => {
  it('a migrated install: the install-scoped dir, even when an empty legacy dir exists', () => {
    mkdirSync(join(home, '.claude', 'channels', 'telegram'), { recursive: true })
    put(join(root, '.claude', 'channels', 'telegram'), 'access.json')
    expect(channelStateDir('telegram', undefined, root)).toBe(join(root, '.claude', 'channels', 'telegram'))
  })

  it('an unmigrated install: the legacy dir that still holds the state', () => {
    put(join(home, '.claude', 'channels', 'telegram'), '.env')
    expect(channelStateDir('telegram', undefined, root)).toBe(join(home, '.claude', 'channels', 'telegram'))
  })

  it('a fresh install: install-scoped, where channels.sh will look', () => {
    expect(channelStateDir('slack', undefined, root)).toBe(join(root, '.claude', 'channels', 'slack'))
  })

  it('a sub-agent always gets its own dir', () => {
    put(join(root, '.claude', 'channels', 'telegram'), '.env')
    expect(channelStateDir('telegram', '/x/agents/a')).toBe(join('/x/agents/a', '.claude', 'channels', 'telegram'))
  })

  it('the legacy path stays reachable on purpose', () => {
    expect(legacyChannelStateDir('discord')).toBe(join(home, '.claude', 'channels', 'discord'))
  })
})
