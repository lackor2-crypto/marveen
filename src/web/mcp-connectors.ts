// Parsing half of the Claude-Code connector view. The I/O half is
// ./mcp-runner.ts; this file is pure so the classification can be tested
// without a CLI, a network or a live account.
//
// WHY THIS EXISTS. Boss hit it head-on (2026-08-14): Google Drive was ticked on
// claude.ai/settings/connectors, and the agents still could not see the Drive.
// The connector list comes from the claude.ai account, but the AUTHORIZATION is
// local and per-install -- so a connector shows up, looks enabled, and does
// nothing until someone runs `claude mcp login` in an interactive terminal. The
// instruction that follows from that is "open a terminal in Ubuntu and...",
// which for this operator is not an instruction at all:
//
//   "de ezzel csak az a problemem hogy ezt hogy fogja megcsinalni egy user aki
//    komuves? nem ert semmihez sem? [...] ezt a marveen ban kellene megoldani"
//
// MEASURED, and it bounds what this feature can promise (2026-08-14):
//
//   1. Connectors are per CLAUDE_CONFIG_DIR, i.e. per Claude account -- NOT
//      per install. Measured: the base ~/.claude had Drive+Gmail+Calendar+Canva
//      connected, store/accounts/usalackor had only Drive, store/accounts/
//      lackor3 had only Gmail. So an agent sees exactly what ITS account has,
//      and the page has to be a matrix rather than one list.
//
//   2. The same connector cannot be added twice under different names to reach
//      a second Google address: `claude mcp add --transport http gmail-ketto
//      https://gmailmcp.googleapis.com/mcp/v1` is accepted and then fails with
//      "Incompatible auth server: does not support dynamic client
//      registration". One Claude account carries at most ONE Google identity
//      per connector. Ten addresses live at once is a real requirement (Boss,
//      same day) and it is served by ../web/google-accounts.ts, not from here.
//
//   3. `claude mcp login <name> --no-browser` prints the URL and takes a pasted
//      redirect -- but only on a TTY ("stdin isn't a terminal, so
//      authentication can't be completed here"). Hence the tmux window in the
//      runner, the same trick claude-auth-runner.ts already uses for logins.

/** How a server was configured, as the CLI reports it. */
export type McpStatus = 'connected' | 'failed' | 'pending'

export interface McpServerRow {
  /** Exactly as the CLI names it, e.g. "claude.ai Google Drive". */
  name: string
  /** URL for HTTP/SSE servers, or the command line for stdio ones. */
  target: string
  status: McpStatus
  /** The CLI's own reason, for failures. */
  reason: string | null
  /** What the operator can DO about it -- see classifyFailure. */
  fix: McpFix
}

/**
 * The only question the page actually has to answer: is this one fixable from
 * here, and if not, why not.
 */
export type McpFix =
  /** Nothing to do. */
  | 'none'
  /** A sign-in this dashboard can walk the operator through. */
  | 'login'
  /** Needs approval of a project-scoped server, which is not this page's job. */
  | 'approve'
  /** The server's own machinery is missing (a binary, a plugin). */
  | 'broken'
  /** Measured dead end: the endpoint refuses clients it did not pre-register. */
  | 'unsupported'

/**
 * Turn `claude mcp list` output into rows.
 *
 * Line shape (measured): `<name>: <target>[ (HTTP)] - <marker> <status>`, where
 * the name may itself contain colons ("plugin:telegram:telegram"). The first
 * COLON-SPACE is the real separator, and the status marker is the last " - ".
 * Header noise ("Checking MCP server health…") and blank lines are dropped.
 */
export function parseMcpList(stdout: string): McpServerRow[] {
  const rows: McpServerRow[] = []
  for (const raw of (stdout || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const sep = line.indexOf(': ')
    if (sep < 1) continue
    const name = line.slice(0, sep).trim()
    let rest = line.slice(sep + 2).trim()

    // The status tail. Splitting on the LAST " - " is deliberate: a stdio
    // command line can contain " - " of its own, the status never appears
    // anywhere but the end.
    const cut = rest.lastIndexOf(' - ')
    if (cut < 0) continue
    const tail = rest.slice(cut + 3).trim()
    rest = rest.slice(0, cut).trim()

    let status: McpStatus
    if (/Connected/i.test(tail) && !/Failed/i.test(tail)) status = 'connected'
    else if (/Pending/i.test(tail)) status = 'pending'
    else if (/Failed/i.test(tail)) status = 'failed'
    else continue

    // "Failed to connect — <reason>": em dash from the CLI, hyphen tolerated.
    let reason: string | null = null
    if (status === 'failed') {
      const m = tail.match(/(?:—|--|-)\s*(.+)$/)
      reason = m ? m[1].trim().slice(0, 300) : null
    }
    const target = rest.replace(/\s*\((HTTP|SSE|STDIO)\)\s*$/i, '').trim()
    rows.push({ name, target, status, reason, fix: classifyFailure(status, reason) })
  }
  return rows
}

/**
 * What can be done about a failure -- the difference between a button that
 * fixes it and a sentence explaining why nothing here will.
 */
export function classifyFailure(status: McpStatus, reason: string | null): McpFix {
  if (status === 'connected') return 'none'
  if (status === 'pending') return 'approve'
  const r = (reason || '').toLowerCase()
  // Measured dead end -- checked BEFORE the auth patterns, because its message
  // contains the word "auth" and would otherwise offer a login that cannot work.
  if (r.includes('dynamic client registration')) return 'unsupported'
  if (/enoent|not found in \$path|executable not found|command not found/.test(r)) return 'broken'
  if (/auth|401|403|unauthorized|forbidden|token|credential|log ?in|sign ?in|consent/.test(r)) return 'login'
  // No reason at all is most often a connector that was never authorized here:
  // offer the login, since the worst case is a flow the operator can cancel.
  if (!r) return 'login'
  return 'broken'
}

/** Friendly names, so the page says "Google Drive" rather than
 *  "claude.ai Google Drive", and can say what the thing is FOR. */
export interface ConnectorInfo {
  /** Matched case-insensitively against the CLI name. */
  match: RegExp
  label: string
  /** One line, in the operator's words, on what it gives the agents. */
  what: string
}

export const CONNECTOR_CATALOG: ConnectorInfo[] = [
  { match: /google drive/i, label: 'Google Drive', what: 'Az ügynökök látják és megnyitják a Drive-ban lévő fájljaidat.' },
  { match: /\bgmail\b/i, label: 'Gmail', what: 'Az ügynökök olvassák a leveleidet, és a jóváhagyásoddal válaszolnak is.' },
  { match: /google calendar|naptar|naptár/i, label: 'Google Naptár', what: 'Az ügynökök látják a napirendedet és tudnak eseményt felvenni.' },
  { match: /canva/i, label: 'Canva', what: 'Az ügynökök megnyitják és szerkesztik a Canva-terveidet.' },
  { match: /github/i, label: 'GitHub', what: 'Az ügynökök látják a tárolóidat, hibajegyeidet és a beolvasztási kéréseket.' },
  { match: /notion/i, label: 'Notion', what: 'Az ügynökök olvassák és írják a Notion-oldalaidat.' },
  { match: /slack/i, label: 'Slack', what: 'Az ügynökök olvassák a Slack-csatornáidat.' },
]

/** Display label for a raw CLI server name. */
export function connectorLabel(name: string): string {
  const hit = CONNECTOR_CATALOG.find(c => c.match.test(name))
  if (hit) return hit.label
  // Strip the prefix the CLI adds to account-provisioned connectors; a plugin
  // id ("plugin:telegram:telegram") keeps its last, meaningful segment.
  const cleaned = name.replace(/^claude\.ai\s+/i, '').trim()
  if (cleaned.startsWith('plugin:')) return cleaned.split(':').pop() || cleaned
  return cleaned || name
}

/** One-line explanation, or null when the connector is not in the catalog. */
export function connectorPurpose(name: string): string | null {
  const hit = CONNECTOR_CATALOG.find(c => c.match.test(name))
  return hit ? hit.what : null
}

export interface McpAccountView {
  /** Plan id, or null for the install default (~/.claude). */
  accountId: string | null
  label: string
  /** Agent ids running on this account -- what makes the row concrete: the
   *  operator does not think in config dirs, they think in "north" and "gypsy". */
  agents: string[]
  servers: McpServerRow[]
  /** Set when the probe itself failed (CLI missing, timeout). */
  error: string | null
}

export interface McpSummary {
  accounts: McpAccountView[]
  /** Connectors that would start working after one guided sign-in. */
  needsLogin: number
  /** Failures this page cannot fix, so the count never promises a button. */
  broken: number
  connected: number
  /** How loudly the Overview may say something is wrong. A connector that
   *  merely needs a sign-in is a missed capability, not a broken install. */
  tier: 'none' | 'extra' | 'recommended'
}

// --- reading the login pane --------------------------------------------------

/**
 * MEASURED, 2026-08-14, and it simplified the whole flow.
 *
 * `claude mcp login "claude.ai Canva" --no-browser` under a TTY prints:
 *
 *     Visit this URL to authorize:
 *       https://claude.ai/...
 *     Once authorized on claude.ai, the connector will be available the next
 *     time you start Claude Code.
 *
 * ...and EXITS 0 immediately. For a claude.ai connector there is no code to
 * paste and nothing to wait for -- but the connector only appears to an agent
 * that STARTS AFTER the authorization, which is the one thing the operator has
 * to be told or they will authorize, see no change, and conclude it failed.
 *
 * A plain HTTP/SSE server is the other shape: the CLI waits and asks for the
 * redirect URL. Both are handled, because the second is what a self-hosted
 * connector added later would do.
 */
export type McpLoginPhase = 'starting' | 'visit' | 'awaiting-paste' | 'done' | 'failed'

export interface McpLoginPaneState {
  phase: McpLoginPhase
  url: string | null
  error: string | null
  /** True when the CLI said the connector needs a fresh Claude Code start. */
  restartRequired: boolean
}

/** Sentinel the runner appends after the command, so an exit is observable
 *  from the pane text alone rather than from a race against tmux. */
export const MCP_EXIT_MARKER = 'MARVEEN_MCP_EXIT='

export function readMcpLoginPane(text: string, pasteSubmitted = false): McpLoginPaneState {
  const raw = text || ''
  const url = extractAuthorizeUrl(raw)
  const restartRequired = /next time you start Claude Code/i.test(raw)

  const exit = raw.match(new RegExp(`${MCP_EXIT_MARKER}(\\d+)`))
  if (exit) {
    const code = Number(exit[1])
    if (code === 0) {
      // Exit 0 with a URL on screen is the claude.ai shape: the CLI has done
      // everything it can, and the rest happens in the operator's browser.
      return { phase: url ? 'visit' : 'done', url, error: null, restartRequired }
    }
    return { phase: 'failed', url, error: firstErrorLine(raw), restartRequired }
  }

  if (/paste[^\n]*redirect url|paste the url|redirect url:/i.test(raw) && !pasteSubmitted) {
    return { phase: 'awaiting-paste', url, error: null, restartRequired }
  }
  if (url) return { phase: 'visit', url, error: null, restartRequired }
  return { phase: 'starting', url: null, error: null, restartRequired }
}

/** The authorize link, wherever the CLI put it. Never logged: it carries the
 *  OAuth state. */
export function extractAuthorizeUrl(text: string): string | null {
  const m = (text || '').match(/https:\/\/[^\s'"<>]+/)
  return m ? m[0] : null
}

function firstErrorLine(text: string): string | null {
  const line = text.split('\n').map(l => l.trim())
    .find(l => /error|failed|couldn't|cannot|hiba/i.test(l) && !l.startsWith(MCP_EXIT_MARKER))
  return line ? line.slice(0, 300) : null
}

/** Roll the per-account rows up into what the Overview card needs. */
export function summarizeMcp(accounts: McpAccountView[]): McpSummary {
  let needsLogin = 0, broken = 0, connected = 0
  for (const acct of accounts) {
    for (const s of acct.servers) {
      if (s.status === 'connected') connected++
      else if (s.fix === 'login') needsLogin++
      else broken++
    }
  }
  return {
    accounts, needsLogin, broken, connected,
    tier: needsLogin > 0 ? 'recommended' : broken > 0 ? 'extra' : 'none',
  }
}
