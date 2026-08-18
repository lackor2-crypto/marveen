import { describe, it, expect } from 'vitest'
import {
  parseMcpList,
  classifyFailure,
  isAgentManagedChannel,
  connectorLabel,
  connectorPurpose,
  readMcpLoginPane,
  extractAuthorizeUrl,
  summarizeMcp,
  MCP_EXIT_MARKER,
  type McpAccountView,
} from '../web/mcp-connectors.js'

// Cover for the connector matrix. The bug it exists to prevent is the one Boss
// hit: Google Drive ticked on claude.ai, agents still blind, because the
// AUTHORIZATION is local and per Claude account.
//
// REAL_LIST is measured output of `NO_COLOR=1 claude mcp list` on this install
// (2026-08-14), including the plugin row whose NAME contains colons and whose
// failure reason contains both a colon and a "$PATH" -- the two things that
// broke naive splitting.
//
// That telegram failure was real, and it has since been FIXED (bun lives in
// ~/.bun/bin, which Ubuntu's .bashrc only puts on the PATH of INTERACTIVE
// shells -- so anything Marveen spawned could not find it; there is now a
// symlink in ~/.local/bin, and the same command reports "✔ Connected"). The
// broken row stays in the fixture because it is still the hardest line this
// parser will ever be handed; CONNECTED_PLUGIN below is what it looks like now.

const REAL_LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Canva: https://mcp.canva.com/mcp - ✔ Connected',
  'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'plugin:telegram:telegram: bun run --cwd /home/boss/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "bun"',
].join('\n')

describe('parseMcpList', () => {
  it('reads the measured output, header line and all', () => {
    const rows = parseMcpList(REAL_LIST)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ name: 'claude.ai Canva', status: 'connected', fix: 'none' })
  })

  it('keeps a name that contains colons intact', () => {
    // "plugin:telegram:telegram" -- the first ": " (colon-SPACE) is the real
    // separator, not the first colon.
    const row = parseMcpList(REAL_LIST).find(r => r.name.startsWith('plugin:'))!
    expect(row.name).toBe('plugin:telegram:telegram')
    expect(row.target.startsWith('bun run --cwd ')).toBe(true)
  })

  it('takes the status from the LAST " - ", not from one inside a command line', () => {
    const row = parseMcpList(REAL_LIST).find(r => r.name.startsWith('plugin:'))!
    // The command line contains " --cwd", " --shell=bun" and " --silent".
    expect(row.status).toBe('failed')
    expect(row.reason).toBe('ENOENT: Executable not found in $PATH: "bun"')
    // 'agent-managed', not 'broken': this row IS a channel plugin, and since
    // 2026-08-15 those are exempt from the fault counts whatever the reason --
    // the probe cannot launch them the way the agent does. The reason is still
    // parsed and kept, which is what this test is actually about.
    expect(row.fix).toBe('agent-managed')
  })

  // MEASURED after the PATH fix, same command, same box: the colon-bearing name
  // and the flag-bearing command line now arrive on a WORKING row, so the two
  // hard parts must survive on the happy path too.
  const CONNECTED_PLUGIN =
    'plugin:telegram:telegram: bun run --cwd /home/boss/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start - ✔ Connected'

  it('reads the same plugin row once it works', () => {
    const row = parseMcpList(CONNECTED_PLUGIN)[0]
    expect(row.name).toBe('plugin:telegram:telegram')
    expect(row.status).toBe('connected')
    expect(row.fix).toBe('none')
    expect(row.reason).toBeNull()
  })

  it('strips the transport suffix from the target', () => {
    const rows = parseMcpList('x: https://example.com/mcp (HTTP) - ✔ Connected')
    expect(rows[0].target).toBe('https://example.com/mcp')
  })

  it('reads a pending (project-scoped) server', () => {
    const rows = parseMcpList('y: https://example.com/mcp - Pending approval')
    expect(rows[0]).toMatchObject({ status: 'pending', fix: 'approve' })
  })

  // --- fed damaged output ---
  it('returns nothing rather than fake rows for noise', () => {
    expect(parseMcpList('')).toEqual([])
    expect(parseMcpList('Checking MCP server health…')).toEqual([])
    expect(parseMcpList('some: line with no status marker')).toEqual([])
    expect(parseMcpList(': - Connected')).toEqual([])
  })

  it('drops a row truncated mid-line instead of guessing its status', () => {
    const cut = REAL_LIST.slice(0, REAL_LIST.indexOf('claude.ai Gmail') + 30)
    const rows = parseMcpList(cut)
    expect(rows.every(r => r.status === 'connected' || r.status === 'failed')).toBe(true)
    expect(rows.some(r => r.name === 'claude.ai Gmail')).toBe(false)
  })

  it('caps a runaway reason', () => {
    const rows = parseMcpList(`z: https://x/mcp - ✘ Failed to connect — ${'e'.repeat(5000)}`)
    expect(rows[0].reason!.length).toBeLessThanOrEqual(300)
  })
})

describe('classifyFailure', () => {
  // The measured dead end, and the one classification that MUST come first: its
  // message contains the word "auth", so any auth-pattern check placed above it
  // would offer a sign-in that cannot possibly work.
  it('calls the dynamic-client-registration refusal unsupported, not a login', () => {
    expect(classifyFailure('failed', 'Incompatible auth server: does not support dynamic client registration'))
      .toBe('unsupported')
  })

  it('calls a missing binary broken', () => {
    expect(classifyFailure('failed', 'ENOENT: Executable not found in $PATH: "bun"')).toBe('broken')
    expect(classifyFailure('failed', 'command not found: uvx')).toBe('broken')
  })

  it('offers a login for the auth failures', () => {
    for (const reason of ['401 Unauthorized', 'authentication required', 'token expired', 'please sign in']) {
      expect(classifyFailure('failed', reason)).toBe('login')
    }
  })

  it('offers a login when the CLI gave no reason at all', () => {
    // Most often a connector that was never authorized here; the worst case is
    // a flow the operator can cancel.
    expect(classifyFailure('failed', null)).toBe('login')
    expect(classifyFailure('failed', '')).toBe('login')
  })

  it('never offers an action for a working or pending server', () => {
    expect(classifyFailure('connected', null)).toBe('none')
    expect(classifyFailure('pending', null)).toBe('approve')
  })

  // The 2026-08-15 false alarm: the probe cannot pass TELEGRAM_STATE_DIR, so the
  // plugin cannot find its token and dies -- while the agent's own poller runs
  // fine. Without the name, the exact same reason classifies as 'broken'.
  it('calls a channel plugin agent-managed, whatever the reason says', () => {
    const reason = '-32000: MCP error -32000: Connection closed'
    expect(classifyFailure('failed', reason, 'plugin:telegram:telegram')).toBe('agent-managed')
    expect(classifyFailure('failed', reason)).toBe('broken')
    for (const name of ['plugin:slack:slack', 'plugin:discord:discord', 'plugin:googlechat:gc', 'plugin:teams:teams']) {
      expect(classifyFailure('failed', reason, name)).toBe('agent-managed')
    }
  })

  it('does not excuse a non-channel plugin, and never downgrades a working one', () => {
    expect(classifyFailure('failed', 'ENOENT', 'plugin:whatever:thing')).toBe('broken')
    // "telegram" only counts as the PROVIDER segment, not anywhere in the name.
    expect(classifyFailure('failed', 'ENOENT', 'my-telegram-helper')).toBe('broken')
    expect(classifyFailure('connected', null, 'plugin:telegram:telegram')).toBe('none')
  })
})

describe('isAgentManagedChannel', () => {
  it('matches the channel plugins the agent starts, and nothing else', () => {
    expect(isAgentManagedChannel('plugin:telegram:telegram')).toBe(true)
    expect(isAgentManagedChannel('  PLUGIN:Telegram:x  ')).toBe(true)
    expect(isAgentManagedChannel('plugin:telegramish:x')).toBe(false)
    expect(isAgentManagedChannel('claude.ai Gmail')).toBe(false)
    expect(isAgentManagedChannel('')).toBe(false)
  })
})

describe('connectorLabel / connectorPurpose', () => {
  it('names the catalog connectors plainly', () => {
    expect(connectorLabel('claude.ai Google Drive')).toBe('Google Drive')
    expect(connectorLabel('claude.ai Gmail')).toBe('Gmail')
    expect(connectorPurpose('claude.ai Google Drive')).toBeTruthy()
  })

  it('falls back to the last meaningful segment of a plugin id', () => {
    expect(connectorLabel('plugin:telegram:telegram')).toBe('telegram')
  })

  it('leaves an unknown connector recognisable and unexplained', () => {
    expect(connectorLabel('my-own-server')).toBe('my-own-server')
    expect(connectorPurpose('my-own-server')).toBeNull()
  })
})

describe('readMcpLoginPane', () => {
  // MEASURED, 2026-08-14: `claude mcp login "claude.ai Canva" --no-browser` on a
  // TTY prints the URL, says the connector arrives on the NEXT start, and exits
  // 0 immediately -- there is nothing to paste back.
  const VISIT = [
    'Visit this URL to authorize:',
    '  https://claude.ai/oauth/authorize?code=x&state=y',
    'Once authorized on claude.ai, the connector will be available the next time you start Claude Code.',
    `${MCP_EXIT_MARKER}0`,
  ].join('\n')

  it('reads the claude.ai shape and flags the restart', () => {
    const s = readMcpLoginPane(VISIT)
    expect(s.phase).toBe('visit')
    expect(s.url).toBe('https://claude.ai/oauth/authorize?code=x&state=y')
    expect(s.restartRequired).toBe(true)
    expect(s.error).toBeNull()
  })

  it('reports starting while the pane is still empty', () => {
    expect(readMcpLoginPane('').phase).toBe('starting')
    expect(readMcpLoginPane('$ claude mcp login ...').phase).toBe('starting')
  })

  it('asks for the paste only until one has been sent', () => {
    const waiting = 'Visit this URL to authorize:\n  https://x/y\nPaste the redirect URL here:'
    expect(readMcpLoginPane(waiting, false).phase).toBe('awaiting-paste')
    // Otherwise the page would keep asking for a URL it has already delivered.
    expect(readMcpLoginPane(waiting, true).phase).toBe('visit')
  })

  it('calls a non-zero exit a failure and shows the CLI its own words', () => {
    const s = readMcpLoginPane(`Error: could not reach the server\n${MCP_EXIT_MARKER}1`)
    expect(s.phase).toBe('failed')
    expect(s.error).toBe('Error: could not reach the server')
  })

  it('does not mistake the exit marker itself for the error message', () => {
    const s = readMcpLoginPane(`something failed here\n${MCP_EXIT_MARKER}1`)
    expect(s.error).toBe('something failed here')
  })

  it('reports done when the CLI exits 0 having printed no URL', () => {
    expect(readMcpLoginPane(`${MCP_EXIT_MARKER}0`).phase).toBe('done')
  })
})

describe('extractAuthorizeUrl', () => {
  it('takes the first https link and stops at the quote', () => {
    expect(extractAuthorizeUrl('go to "https://claude.ai/x?y=1" now')).toBe('https://claude.ai/x?y=1')
  })

  it('returns null when there is none', () => {
    expect(extractAuthorizeUrl('no link here')).toBeNull()
    expect(extractAuthorizeUrl('')).toBeNull()
  })
})

describe('summarizeMcp', () => {
  function acct(id: string | null, servers: Array<[string, 'connected' | 'failed' | 'pending', string | null]>): McpAccountView {
    return {
      accountId: id, label: id ?? '', agents: [], error: null,
      servers: servers.map(([name, status, reason]) => ({
        // Name included, exactly as parseMcpList does it -- the channel-plugin
        // exemption is keyed on the name and would be invisible without it.
        name, target: 'https://x', status, reason, fix: classifyFailure(status, reason, name),
      })),
    }
  }

  it('counts across every account, not just the default one', () => {
    const s = summarizeMcp([
      acct(null, [['claude.ai Gmail', 'connected', null]]),
      acct('lackor3', [['claude.ai Google Drive', 'failed', '401 Unauthorized']]),
    ])
    expect(s).toMatchObject({ connected: 1, needsLogin: 1, broken: 0, tier: 'recommended' })
  })

  // Alarm colours spent on convenience teach the operator to ignore alarm
  // colours: a connector that cannot be fixed from here is grey, not amber.
  it('keeps an unfixable failure below the sign-in tier', () => {
    const s = summarizeMcp([acct(null, [['plugin:x:x', 'failed', 'ENOENT: Executable not found']])])
    expect(s).toMatchObject({ broken: 1, needsLogin: 0, tier: 'extra' })
  })

  it('says nothing at all when everything works', () => {
    const s = summarizeMcp([acct(null, [['claude.ai Gmail', 'connected', null]])])
    expect(s.tier).toBe('none')
  })

  it('says nothing for an account with no connectors', () => {
    expect(summarizeMcp([acct('ures', [])]).tier).toBe('none')
    expect(summarizeMcp([]).tier).toBe('none')
  })

  // The live shape on 2026-08-15: two accounts whose Telegram works, reported
  // as two broken connectors. The Overview must stay silent about them.
  it('keeps agent-managed channels out of broken, and out of the tier', () => {
    const closed = '-32000: MCP error -32000: Connection closed'
    const s = summarizeMcp([
      acct(null, [['claude.ai Gmail', 'connected', null], ['plugin:telegram:telegram', 'connected', null]]),
      acct('usalackor', [['claude.ai Google Drive', 'connected', null], ['plugin:telegram:telegram', 'failed', closed]]),
      acct('lackor3', [['claude.ai Gmail', 'connected', null], ['plugin:telegram:telegram', 'failed', closed]]),
    ])
    expect(s).toMatchObject({ connected: 4, agentManaged: 2, broken: 0, needsLogin: 0, tier: 'none' })
  })

  it('still reports a real failure alongside an agent-managed one', () => {
    const s = summarizeMcp([acct(null, [
      ['plugin:telegram:telegram', 'failed', 'Connection closed'],
      ['claude.ai Gmail', 'failed', '401 Unauthorized'],
    ])])
    expect(s).toMatchObject({ agentManaged: 1, needsLogin: 1, broken: 0, tier: 'recommended' })
  })
})
