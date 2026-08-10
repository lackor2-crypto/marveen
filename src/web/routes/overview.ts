import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getDb, countTaskRunsBetween } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { getSecret } from '../vault.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { readRateLimitSnapshot } from '../rate-limit-status-io.js'
import { tierForSnapshot, isStale } from '../../rate-limit-status.js'
import { fetchOpenRouterCredits } from './openrouter-overview.js'
import { deriveOpenRouterCreditsView } from '../../openrouter-credits.js'
import { execFileSync } from 'node:child_process'
import { readClaudePlans } from '../claude-plans.js'
import { readAgentModel } from '../agent-config.js'
import { atomicWriteFileSync } from '../atomic-write.js'

// Multiple named Claude accounts (Boss 2026-08-09, the usalackor/lackor3
// multi-account project): these run as full interactive Claude Code TUI
// sessions but were never wired to the statusline.py JSON-snapshot hook (that
// hook lives in the SHARED ~/.claude/hooks, not per-plan config dirs), so
// there is no store/rate-limit-status/<id>.json to read for them the way
// readRateLimitSnapshot() does for the main agent. Cheaper fallback: scrape
// Claude Code's own native "You've used X% of your session limit" line and
// the welcome-box model line straight out of the live tmux pane -- same
// technique already used for auth/init's URL scrape. Best-effort: any parse
// miss just omits that field rather than failing the whole overview call.
const MONTH_ABBRS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Claude Code prints the reset moment as either a bare time ("resets 6:20pm")
// or a dated time once the window is more than a day out ("resets Aug 14,
// 9am") -- both followed by a timezone parenthetical this parser ignores (the
// host clock is already Europe/Budapest, see CLAUDE.md time-handling rules).
// Best-effort: any miss returns null rather than throwing, same contract as
// the usedPct/model scrape above.
function parseResetsAt(pane: string, nowMs: number = Date.now()): number | null {
  // The minute part is only printed when non-zero -- "resets 9pm" and
  // "resets Aug 14, 9am" are both real, observed forms alongside the
  // "resets 6:20pm" form, so `:MM` must be optional here.
  const m = pane.match(/resets\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return null
  const [, monAbbr, dayStr, hStr, minStr, ap] = m
  let hours = Number(hStr) % 12
  if (/pm/i.test(ap)) hours += 12
  const minutes = minStr ? Number(minStr) : 0
  const now = new Date(nowMs)
  let year = now.getFullYear()
  let month = now.getMonth()
  let day = now.getDate()
  if (monAbbr) {
    const mi = MONTH_ABBRS.indexOf(monAbbr.toLowerCase())
    if (mi >= 0) { month = mi; day = Number(dayStr) }
  }
  let dt = new Date(year, month, day, hours, minutes, 0, 0)
  // Bare time (no month/day) that already lies in the past means the window
  // rolls over past midnight -- it means tomorrow, not today.
  if (!monAbbr && dt.getTime() <= nowMs) {
    dt = new Date(year, month, day + 1, hours, minutes, 0, 0)
  }
  return dt.getTime()
}

// Last successful scrape per plan, persisted to disk (store/rate-limit-status/
// scraped-<planId>.json) so it survives a dashboard restart, not just kept
// in memory. Boss 2026-08-10, TWO live incidents the same night: (1) while
// Usalackor was actively mid-turn, the "used X%" banner had scrolled out of
// even a widened scrollback window, scrapeClaudeAccountUsage returned
// all-null, and accountRow() in web/app.js drops a row entirely when
// fiveHourPct is null -- so the whole account seemed to vanish from the
// widget ("eltunt az usalackor. mi lett vele?") right when it was busiest,
// not idle; (2) an in-memory-only version of this same cache was tried
// first and didn't survive the dashboard restarts this session kept doing
// (build+restart is routine while iterating), so it never actually had a
// chance to seed before the next restart wiped it. A stale reading (clearly
// marked, see `stale` below) beats no reading.
const SCRAPE_CACHE_DIR = join(PROJECT_ROOT, 'store', 'rate-limit-status')
function scrapeCachePath(planId: string): string {
  return join(SCRAPE_CACHE_DIR, `scraped-${planId}.json`)
}
function readScrapeCache(planId: string): { usedPct: number; model: string | null; resetsAt: number | null } | null {
  try {
    const raw = JSON.parse(readFileSync(scrapeCachePath(planId), 'utf-8'))
    if (typeof raw?.usedPct === 'number') return { usedPct: raw.usedPct, model: raw.model ?? null, resetsAt: raw.resetsAt ?? null }
  } catch { /* no cache yet, or unreadable -- treat as no cache */ }
  return null
}
function writeScrapeCache(planId: string, v: { usedPct: number; model: string | null; resetsAt: number | null }): void {
  try {
    atomicWriteFileSync(scrapeCachePath(planId), JSON.stringify({ ...v, capturedAt: Date.now() }))
  } catch { /* best-effort cache -- a write failure just means the next call retries live */ }
}

function scrapeClaudeAccountUsage(planId: string): { usedPct: number | null; model: string | null; resetsAt: number | null; stale: boolean } {
  let pane: string | null = null
  try {
    // -S -2000: the "used X%" banner is transient (only shown right after it
    // renders, then scrolls out of the default single-screen capture once the
    // agent replies to anything) -- read back deep into scrollback so a long
    // busy stretch (lots of tool-call output) doesn't push it out of range.
    // Best-effort: any tmux failure (session not found, etc) -> nulls.
    pane = execFileSync('/usr/bin/tmux', ['capture-pane', '-t', `agent-${planId}`, '-p', '-S', '-2000'], { timeout: 3000 }).toString()
  } catch { /* pane unavailable, fall through with nulls */ }

  const fresh = pane ? scrapeFreshUsage(pane) : { usedPct: null, model: null, resetsAt: null }
  if (fresh.usedPct !== null) {
    const v = { usedPct: fresh.usedPct, model: fresh.model, resetsAt: fresh.resetsAt }
    writeScrapeCache(planId, v)
    return { ...fresh, stale: false }
  }
  const cached = readScrapeCache(planId)
  if (cached) return { usedPct: cached.usedPct, model: cached.model, resetsAt: cached.resetsAt, stale: true }
  return { usedPct: null, model: null, resetsAt: null, stale: false }
}

function scrapeFreshUsage(pane: string): { usedPct: number | null; model: string | null; resetsAt: number | null } {
  // Either the "stop and wait for limit to reset" dialog or the plain
  // "You've hit your session/weekly limit" banner means the window is fully
  // exhausted (100%); neither repeats the "used X%" text the regex below
  // needs.
  if (/Stop and wait for limit to reset|hit your (?:session|weekly) limit/i.test(pane)) {
    return { usedPct: 100, model: null, resetsAt: parseResetsAt(pane) }
  }
  const usedMatch = [...pane.matchAll(/used (\d+)% of your session limit/g)].pop()
  const modelMatch = pane.match(/([A-Za-z][A-Za-z0-9. ]*?)\s*[·•]\s*Claude (?:Pro|Team|Max)/)
  return {
    usedPct: usedMatch ? Number(usedMatch[1]) : null,
    model: modelMatch ? modelMatch[1].trim() : null,
    resetsAt: parseResetsAt(pane),
  }
}

// Known optional capabilities the system supports but that need a per-user
// setup step (a vault key, a token, ...) before they actually work. The
// Overview page surfaces whichever of these are still unconfigured so the
// user doesn't have to already know they exist. Add new entries here as more
// opt-in integrations show up; the frontend owns the id -> label/desc/link
// mapping (i18n strings live in web/lang/*.js, not baked in here).
const CAPABILITY_CHECKS: Array<{ id: string; configured: () => boolean }> = [
  { id: 'openrouter', configured: () => getSecret('openrouter-fleet-key') !== null },
  { id: 'groq-stt', configured: () => getSecret('groq-stt-key') !== null },
]

// Count "real" user turns (operator prompts, Telegram messages) in every
// Claude Code session JSONL under ~/.claude/projects/. Filters out
// tool_result, local-command, and synthetic system events so a task-heavy
// hour doesn't inflate the counter.
function countUserTurns(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return 0
  let total = 0
  try {
    for (const projectDir of readdirSync(root)) {
      const absDir = join(root, projectDir)
      let stat: ReturnType<typeof statSync>
      try { stat = statSync(absDir) } catch { continue }
      if (!stat.isDirectory()) continue
      for (const fname of readdirSync(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const absFile = join(absDir, fname)
        let fstat: ReturnType<typeof statSync>
        try { fstat = statSync(absFile) } catch { continue }
        if (fstat.mtimeMs < fromMs) continue
        try {
          const data = readFileSync(absFile, 'utf-8')
          for (const line of data.split('\n')) {
            if (!line) continue
            let e: any
            try { e = JSON.parse(line) } catch { continue }
            if (e.type !== 'user' || e.isMeta) continue
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0
            if (!ts || ts < fromMs || ts >= toMs) continue
            const content = e.message?.content
            if (typeof content === 'string') {
              if (content.startsWith('<local-command') || content.startsWith('<command-name>')) continue
              total++
            } else if (Array.isArray(content)) {
              const hasToolResult = content.some((b: any) => b && b.type === 'tool_result')
              if (hasToolResult) continue
              total++
            }
          }
        } catch { /* skip unreadable file */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

export async function tryHandleOverview(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/overview' && method === 'GET') {
    const subAgents = listAgentNames()
    const running = subAgents.filter(n => isAgentRunning(n)).length + 1
    const total = subAgents.length + 1

    const db0 = getDb()
    const memStats = db0.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }
    const memCats = db0.prepare("SELECT COUNT(DISTINCT category) as c FROM memories").get() as { c: number }

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startTs = startOfDay.getTime()
    const yesterday = startTs - 24 * 60 * 60 * 1000
    const schedToday = countTaskRunsBetween(startTs)
    const schedYesterday = countTaskRunsBetween(yesterday, startTs)
    const userTurns = countUserTurns(startTs)
    const userTurnsPrev = countUserTurns(yesterday, startTs)
    const tasksToday = schedToday + userTurns
    const tasksYesterday = schedYesterday + userTurnsPrev

    let skillCount = 0
    let skillsToday = 0
    const skillsDir = join(homedir(), '.claude', 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir)) {
        const skillFile = join(skillsDir, entry, 'SKILL.md')
        if (existsSync(skillFile)) {
          skillCount++
          try {
            const mtime = statSync(skillFile).mtimeMs
            if (mtime >= startTs) skillsToday++
          } catch { /* ignore */ }
        }
      }
    }

    // Raw agent ids (e.g. "lackor2-bot") used to get baked straight into this
    // feed's text server-side, with nothing on the frontend able to resolve
    // them afterward (Boss, 2026-08-05: saw the raw id instead of "Marvin"
    // on the Overview page).
    const displayNameFor = (id: string): string => id === MAIN_AGENT_ID ? currentBotName() : (readAgentDisplayName(id) || id)
    const activity: Array<{ icon: string; text: string; at: number }> = []
    try {
      const memRows = db0.prepare("SELECT content, created_at, agent_id FROM memories ORDER BY created_at DESC LIMIT 6").all() as { content: string; created_at: number; agent_id: string }[]
      for (const r of memRows) {
        activity.push({
          icon: 'memory',
          text: `${displayNameFor(r.agent_id)}: ${r.content.slice(0, 80)}${r.content.length > 80 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    try {
      const msgRows = db0.prepare("SELECT from_agent, to_agent, content, created_at FROM agent_messages ORDER BY created_at DESC LIMIT 4").all() as { from_agent: string; to_agent: string; content: string; created_at: number }[]
      for (const r of msgRows) {
        activity.push({
          icon: 'delegate',
          text: `${displayNameFor(r.from_agent)} → ${displayNameFor(r.to_agent)}: ${r.content.slice(0, 60)}${r.content.length > 60 ? '…' : ''}`,
          at: r.created_at * 1000,
        })
      }
    } catch { /* ignore */ }
    activity.sort((a, b) => b.at - a.at)

    const agentsForTeam: Array<{ id: string; label: string; role: string; running: boolean; hasAvatar: boolean; avatarUrl: string }> = []
    const mainHasAvatar = [
      join(PROJECT_ROOT, 'store', 'marveen-avatar.png'),
      join(PROJECT_ROOT, 'store', 'marveen-avatar.jpg'),
    ].some(existsSync)
    agentsForTeam.push({
      id: MAIN_AGENT_ID,
      label: currentBotName(),
      role: 'main',
      running: true,
      hasAvatar: mainHasAvatar,
      avatarUrl: `/api/marveen/avatar`,
    })
    for (const a of subAgents) {
      const team = readAgentTeam(a)
      agentsForTeam.push({
        id: a,
        label: readAgentDisplayName(a),
        role: team.role,
        running: isAgentRunning(a),
        hasAvatar: existsSync(join(agentDir(a), 'avatar.png')),
        avatarUrl: `/api/agents/${encodeURIComponent(a)}/avatar`,
      })
    }
    const unconfiguredCapabilities = CAPABILITY_CHECKS.filter(c => !c.configured()).map(c => c.id)

    const rlSnapshot = readRateLimitSnapshot(MAIN_AGENT_ID)
    const rateLimit = rlSnapshot ? {
      model: rlSnapshot.model,
      contextPct: rlSnapshot.contextPct,
      fiveHour: rlSnapshot.fiveHour,
      sevenDay: rlSnapshot.sevenDay,
      tier: tierForSnapshot(rlSnapshot),
      updatedAt: rlSnapshot.updatedAt,
      stale: isStale(rlSnapshot.updatedAt, Date.now()),
    } : null

    // OpenRouter remaining balance (Boss, 2026-08-08: "ugyanaz mint a keret-%,
    // meddig dolgozhatok"). Needs a management/provisioning key, separate
    // from the regular fleet key -- omitted entirely until one is configured.
    const openrouterManagementKey = getSecret('openrouter-management-key')
    const openrouterCreditsRaw = openrouterManagementKey ? await fetchOpenRouterCredits(openrouterManagementKey) : null
    const openrouterCredits = openrouterCreditsRaw ? deriveOpenRouterCreditsView(openrouterCreditsRaw) : null

    // Boss 2026-08-09: show every named Claude account (lackor2 + any plan
    // registered in store/claude-plans.json) side by side, each labelled and
    // with its own usage% + active model -- not just the main agent.
    // A configured label may carry a hardcoded model in parentheses
    // ("Usalackor (Opus 4.8)" in store/claude-plans.json). The row shows the
    // LIVE model next to the name, so that parenthetical is duplicated at best
    // and wrong at worst -- that config still said Opus 4.8 while the account
    // was actually running Opus 5. Drop it whenever a live model is known.
    const accountLabel = (label: string, model: string | null) =>
      model ? label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label : label
    const claudeAccounts = [
      {
        id: MAIN_AGENT_ID,
        // Boss 2026-08-09: this row is about WHICH LOGIN is running low, not
        // the assistant's persona -- so it deliberately says "Lackor2", not
        // currentBotName() ("Marvin"), matching the account-style labels
        // used for the other two rows ("Usalackor (Opus 4.8)", "Lackor3
        // (Haiku)"). The org-chart's own main-node label (a few lines above,
        // `agentsForTeam`) is a SEPARATE field and correctly stays "Marvin".
        label: 'Lackor2',
        model: rlSnapshot?.model ?? null,
        fiveHourPct: rlSnapshot?.fiveHour?.usedPct ?? null,
        sevenDayPct: rlSnapshot?.sevenDay?.usedPct ?? null,
        fiveHourResetsAt: rlSnapshot?.fiveHour?.resetsAt ?? null,
        sevenDayResetsAt: rlSnapshot?.sevenDay?.resetsAt ?? null,
        // The other rows mark a stale reading with a "~"; this one used to
        // present an hours-old snapshot as a fresh number.
        stale: rlSnapshot ? isStale(rlSnapshot.updatedAt, Date.now()) : false,
      },
      ...readClaudePlans().map(plan => {
        // Boss 2026-08-10 ("nem igaz, hogy nem lehet lekerni, ha a fiok
        // csatlakozva van"): he was right -- the pane-scrape below was
        // always a workaround for these two plans never having had
        // statusline.py wired into their (isolated) CLAUDE_CONFIG_DIR, so
        // Claude Code's own real usage numbers just weren't being captured
        // anywhere, the same way they already are for the main agent (and
        // this is the SAME script/snapshot format, readRateLimitSnapshot is
        // agent-id-generic). Wired it in tonight (store/accounts/<plan>/
        // settings.json statusLine key) -- prefer that real snapshot now,
        // scraping the pane is only the fallback for the window before a
        // plan's session has taken its first turn (fresh restart, no
        // rate_limits in Claude Code's statusline payload yet).
        const snap = readRateLimitSnapshot(plan.id)
        const snapFresh = snap && !isStale(snap.updatedAt, Date.now())
        if (snapFresh && snap.fiveHour?.usedPct != null) {
          return {
            id: plan.id,
            label: accountLabel(plan.label, snap.model ?? readAgentModel(plan.id)),
            model: snap.model ?? readAgentModel(plan.id),
            fiveHourPct: snap.fiveHour.usedPct,
            sevenDayPct: snap.sevenDay?.usedPct ?? null,
            fiveHourResetsAt: snap.fiveHour.resetsAt ?? null,
            sevenDayResetsAt: snap.sevenDay?.resetsAt ?? null,
            stale: false,
          }
        }
        const scraped = scrapeClaudeAccountUsage(plan.id)
        if (scraped.usedPct !== null) {
          return {
            id: plan.id,
            label: accountLabel(plan.label, scraped.model ?? snap?.model ?? readAgentModel(plan.id)),
            model: scraped.model ?? snap?.model ?? readAgentModel(plan.id),
            fiveHourPct: scraped.usedPct,
            // The pane banner only ever states the session (5h) window, so the
            // weekly number can only come from the snapshot -- worth showing
            // even when it is old, marked stale like everything else here.
            sevenDayPct: snap?.sevenDay?.usedPct ?? null,
            fiveHourResetsAt: scraped.resetsAt,
            sevenDayResetsAt: snap?.sevenDay?.resetsAt ?? null,
            stale: scraped.stale || !snapFresh,
          }
        }
        // Nothing scrapeable either (idle pane, banner scrolled away). An old
        // snapshot marked "~" beats dropping the account: a row that vanishes
        // whenever its session goes quiet is what Boss kept seeing
        // ("az usalackor bejon, neha eltunik", 2026-08-10).
        return {
          id: plan.id,
          label: accountLabel(plan.label, snap?.model ?? readAgentModel(plan.id)),
          model: snap?.model ?? readAgentModel(plan.id),
          fiveHourPct: snap?.fiveHour?.usedPct ?? null,
          sevenDayPct: snap?.sevenDay?.usedPct ?? null,
          fiveHourResetsAt: snap?.fiveHour?.resetsAt ?? null,
          sevenDayResetsAt: snap?.sevenDay?.resetsAt ?? null,
          stale: true,
        }
      }),
    ]

    jsonMaybeGzip(req, res, {
      agents: { total, running },
      tasksToday,
      tasksYesterday,
      memories: { count: memStats.c, categories: memCats.c },
      skills: { count: skillCount, today: skillsToday },
      team: agentsForTeam,
      activity: activity.slice(0, 8),
      unconfiguredCapabilities,
      rateLimit,
      claudeAccounts,
      openrouterCredits,
    })
    return true
  }

  return false
}
