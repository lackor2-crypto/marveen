// #991: the dashboard froze for 6.8 s inside spawnSync -> captureTmux, reached from the Telegram inbox wake timer
// through isSessionReadyForPrompt. A tmux fork on a busy machine takes seconds, so panes are read asynchronously.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const sync = vi.hoisted(() => ({ calls: [] as string[][] }))
const IDLE_PANE = ['', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)', ''].join('\n')

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: (_bin: string, args: string[]) => {
      sync.calls.push(args)
      throw new Error('synchronous fork on the main thread')
    },
    execFile: (_bin: string, args: string[], ...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      setImmediate(() => cb(null, args.includes('list-sessions') ? 'agent-x\n' : IDLE_PANE, ''))
      return { on: () => {}, stdin: null }
    },
  }
})

import { isSessionReadyForPrompt, sessionExistsOnHostAsync } from '../web/agent-process.js'

describe('#991: pane reads stay off the main thread', () => {
  it('isSessionReadyForPrompt reads an idle pane without a synchronous capture', async () => {
    sync.calls.length = 0
    await expect(isSessionReadyForPrompt('agent-x')).resolves.toBe(true)
    expect(sync.calls.filter((a) => a.includes('capture-pane'))).toEqual([])
  })

  it('a remote session list is asked for without a synchronous ssh round-trip', async () => {
    sync.calls.length = 0
    await sessionExistsOnHostAsync('user@laptop', 'agent-x')
    expect(sync.calls).toEqual([])
  })

  // The only synchronous reads left are the first read of an agent behind a background-refreshed cache.
  const COLD_READS: Record<string, number> = { 'context-broker-store.ts': 1, 'routes/agents.ts': 3 }

  it('no module of the web server reads a pane synchronously outside those cold reads', () => {
    const root = join(__dirname, '..', 'web')
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))
    const found: Record<string, number> = {}
    for (const rel of files) {
      // claude-auth-runner has its own, promise-returning capturePane() for the login window.
      if (rel === 'claude-auth-runner.ts') continue
      const code = readFileSync(join(root, rel), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      const n = (code.match(/(?<![\w.]|function )capture(Pane|ParkedInputView)\(/g) ?? []).length
      if (n) found[rel] = n
    }
    expect(found).toEqual(COLD_READS)
  })

  it.each(['channel-mcp-reconnect.ts', 'claude-auth-runner.ts', 'channel-plugin-unlock.ts'])('%s neither sleeps nor captures with a synchronous fork', (rel) => {
    const src = readFileSync(join(__dirname, '..', 'web', rel), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(src).not.toMatch(/execFileSync\(\s*'\/bin\/sleep'/)
    expect(src).not.toMatch(/execFileSync\(TMUX\(\), \['capture-pane'/)
  })
})
