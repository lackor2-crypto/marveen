// Channel-plugin isolation for everything that runs `claude mcp ...` on the
// dashboard's behalf.
//
// MEASURED 2026-09-02 (kanban #193, "Telegram channels bridge crash-loop").
// refreshMcpStatus() walks every Claude account, and its FIRST target is the
// install default -- the one with no CLAUDE_CONFIG_DIR. The telegram plugin
// resolves its state dir as
//
//     TELEGRAM_STATE_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)/channels/telegram
//
// so for that single target the probe landed in the LIVE channels session's own
// state dir -- the one directory that actually holds the bot token. The
// plugin's singleton guard then did exactly what it is written to do:
//
//   ~/.cache/claude-cli-nodejs/-<cwd>/mcp-logs-plugin-telegram-telegram/*.jsonl
//     {"error":"Server stderr: telegram channel: replacing stale poller pid=438821\n",
//      "timestamp":"2026-09-02T15:04:54.212Z", ...}
//     {"debug":"Sending SIGINT to MCP server process",
//      "timestamp":"2026-09-02T15:04:54.771Z", ...}
//
// SIGTERM to the live poller, its own pid into bot.pid, and then the CLI shut
// that impostor down again 0.6s later. 22 such takeovers on 2026-09-02 alone.
// Each one leaves bot.pid naming a dead process, so scripts/channels.sh sees
// the plugin gone, waits out its 180s grace and exits 1 for a service-manager
// restart -- a brand new Claude session, and a pointless "felébredtem" to the
// operator every ten to fifteen minutes.
//
// mcp-connectors.ts already named the danger in prose ("Passing the real state
// dir would be worse, not better: [...] a truthful probe would kill the live
// poller every ten minutes") and reports channel plugins as `agent-managed`.
// What was missing is making the probe INCAPABLE of resolving a live state dir.
// That is this module.
//
// The fix rides on the plugin's own startup order (server.ts 0.0.7, lines
// 27-78): it loads <STATE_DIR>/.env and exits 1 on a missing bot token BEFORE
// it reads, kills or writes bot.pid. Point the probe at a directory that does
// not exist and the plugin stops at that first gate -- no SIGTERM, no pid file,
// no getUpdates connection to race the live one. The row it produces is the
// very same "Failed to connect" that every non-default account already
// produces, and classifyFailure() renders that as `agent-managed`, not broken.
//
// Nothing is created on disk. There is nothing to clean up, nothing that can
// fail on a read-only /tmp, and no directory another user could plant a .env
// into. The name is per-process and unguessable for the same reason
// mcp-list.ts uses a 0700 temp cwd: a predictable /tmp path is a planting
// target, and a planted .env would hand the probe a foreign bot token.

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelProviderType } from '../channel-provider.js'

/**
 * Every channel provider's state-dir environment variable.
 *
 * Typed as a total Record over ChannelProviderType on purpose: a new provider
 * fails the compile here instead of silently inheriting a live state dir.
 * channel-poller-reap.ts reads the same map, so the two can never drift.
 */
export const CHANNEL_STATE_ENV_VAR: Record<ChannelProviderType, string> = {
  telegram: 'TELEGRAM_STATE_DIR',
  slack: 'SLACK_STATE_DIR',
  discord: 'DISCORD_STATE_DIR',
  googlechat: 'GOOGLECHAT_STATE_DIR',
  teams: 'TEAMS_STATE_DIR',
}

/**
 * The bot-token variables the channel plugins read, blanked for a probe.
 *
 * SECOND BELT, and it needs saying why there is one. The state dir above is
 * what stops the probe SIGTERMing a live poller. This stops something else: if a
 * real token ever reached the probe's child, the plugin would pass its
 * `if (!TOKEN)` gate, create the (otherwise never-created) probe state dir and
 * open a SECOND getUpdates consumer on a token Telegram allows exactly one
 * consumer for -- handing the live bridge 409s instead of killing it.
 *
 * Today no token leaks: src/env.ts reads .env without ever assigning into
 * process.env, scripts/channels.sh deliberately greps .env instead of
 * `set -a && source`, and it unsets TELEGRAM_BOT_TOKEN from tmux's global
 * environment (channels.sh:262). MEASURED 2026-09-02: zero TOKEN-named vars in
 * the dashboard process AND in the tmux global environment. But that is one
 * invariant held up by three unrelated files, and the probe can hold it alone
 * for the price of four strings.
 *
 * Names are read from the installed plugin sources (telegram 0.0.6/0.0.7 read
 * TELEGRAM_BOT_TOKEN, discord 0.0.4 reads DISCORD_BOT_TOKEN) plus the list
 * agent-process.ts already unsets on every agent launch. Empty string, not
 * deletion: `!TOKEN` is true for '', and `tmux new-session -e VAR=` measurably
 * overrides an inherited value, so the blanking survives the tmux route too.
 */
export const CHANNEL_TOKEN_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
] as const

// One base per dashboard process. Resolved lazily so importing this module has
// no side effects, and cached so repeated probes stay comparable in a log.
let probeBase: string | null = null

function probeBaseDir(): string {
  if (!probeBase) {
    probeBase = join(tmpdir(), `marveen-mcp-probe-${process.pid}-${randomBytes(6).toString('hex')}`)
  }
  return probeBase
}

/**
 * Environment overrides that point every channel plugin at a state directory
 * which does not exist, and never will.
 *
 * Spread this LAST into the child environment: it must also override a
 * *_STATE_DIR the dashboard inherited from the shell that launched it. The
 * dashboard is routinely started from an agent's tmux pane, so
 * `TELEGRAM_STATE_DIR=<that agent's live channel dir>` is a realistic value in
 * process.env -- and passing it to a probe would kill that agent's poller
 * instead of the main session's. Same bug, different victim.
 */
export function channelProbeStateEnv(): Record<string, string> {
  const base = probeBaseDir()
  const out: Record<string, string> = {}
  for (const provider of Object.keys(CHANNEL_STATE_ENV_VAR) as ChannelProviderType[]) {
    out[CHANNEL_STATE_ENV_VAR[provider]] = join(base, provider)
  }
  for (const tokenVar of CHANNEL_TOKEN_ENV_VARS) out[tokenVar] = ''
  return out
}
