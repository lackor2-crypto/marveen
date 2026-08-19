import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile, stat as statAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getDb, countTaskRunsBetween } from '../../db.js'
import {
  agentDir, listAgentNames, readAgentDisplayName,
} from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { logger } from '../../logger.js'
import { getSecret } from '../vault.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { readRateLimitSnapshot, readScrapedUsage, writeScrapedUsage } from '../rate-limit-status-io.js'
import { tierForSnapshot, isStale } from '../../rate-limit-status.js'
import { fetchOpenRouterCredits } from './openrouter-overview.js'
import { deriveOpenRouterCreditsView } from '../../openrouter-credits.js'
import { execFileSync } from 'node:child_process'
import { readClaudePlans } from '../claude-plans.js'
import { readAgentModel } from '../agent-config.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { readUpstreamSyncStatus } from '../upstream-sync-status-io.js'
import { readUpstreamChanges } from '../upstream-changes-io.js'
import { exactTmuxTarget } from '../tmux-target.js'

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
//
// The read/write pair itself moved to ../rate-limit-status-io.ts (2026-08-11):
// the limit-wake watcher needs the same cache to tell whether an account has
// worked since its window reset, and two copies of the path would be one copy
// too many.

// A five-hour window cannot reset more than five hours from now. Anything
// further out came from a banner about a DIFFERENT window (the weekly one) or
// from a stale line deep in the scrollback, and pairing it with a five-hour
// label produces the contradiction Boss spotted: 100% used, resetting in 23
// hours. Nor can it have reset in the past and still be the window we are
// looking at -- that reading belongs to a window that is over. Slack allows for
// clock skew and the minute-granularity of the banner text.
// Exported for tests: this is a pure guard over an already-parsed row.
export const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
const FIVE_HOUR_RESET_SLACK_MS = 20 * 60 * 1000

export function sanityCheckFiveHour<T extends { usedPct: number | null; resetsAt: number | null }>(
  row: T,
  nowMs: number = Date.now(),
): T {
  if (row.usedPct === null || row.resetsAt === null) return row
  const ahead = row.resetsAt - nowMs
  if (ahead > FIVE_HOUR_WINDOW_MS + FIVE_HOUR_RESET_SLACK_MS) {
    logger.warn({ resetsAt: row.resetsAt, aheadMs: ahead },
      'overview: discarding scraped usage -- reset is too far out to be the five-hour window')
    return { ...row, usedPct: null, resetsAt: null }
  }
  // ... and a reset already in the PAST describes a window that has since
  // rolled over, so whatever percentage came with it is spent. This is the half
  // that was missing: an entry could not be too far ahead, but could be
  // arbitrarily far behind, and the cache is only ever rewritten by a
  // SUCCESSFUL fresh scrape. So a single "100%, resets at 09:00" reading
  // survived the reset and every restart after it, and the account showed as
  // full while its window had been empty for hours (usalackor, 2026-08-14:
  // resetsAt was eleven hours old and the number had stopped moving).
  //
  // Same slack, for the same reason: right at the boundary the banner's
  // minute-granularity and clock skew can put the reset a moment behind.
  if (ahead < -FIVE_HOUR_RESET_SLACK_MS) {
    logger.warn({ resetsAt: row.resetsAt, behindMs: -ahead },
      'overview: discarding scraped usage -- the window it describes has already reset')
    return { ...row, usedPct: null, resetsAt: null }
  }
  return row
}

function scrapeClaudeAccountUsage(planId: string): { usedPct: number | null; model: string | null; resetsAt: number | null; stale: boolean } {
  let pane: string | null = null
  try {
    // -S -2000: the "used X%" banner is transient (only shown right after it
    // renders, then scrolls out of the default single-screen capture once the
    // agent replies to anything) -- read back deep into scrollback so a long
    // busy stretch (lots of tool-call output) doesn't push it out of range.
    // Best-effort: any tmux failure (session not found, etc) -> nulls.
    pane = execFileSync('/usr/bin/tmux', ['capture-pane', '-t', exactTmuxTarget(`agent-${planId}`), '-p', '-S', '-2000'], { timeout: 3000 }).toString()
  } catch { /* pane unavailable, fall through with nulls */ }

  const fresh = pane ? sanityCheckFiveHour(scrapeFreshUsage(pane)) : { usedPct: null, model: null, resetsAt: null }
  if (fresh.usedPct !== null) {
    const v = { usedPct: fresh.usedPct, model: fresh.model, resetsAt: fresh.resetsAt }
    writeScrapedUsage(planId, v)
    return { ...fresh, stale: false }
  }
  // The cache can hold a row written before the guard above existed (or by an
  // older build), so it gets the same check on the way out -- otherwise a
  // poisoned entry keeps serving the impossible "100% / resets in 23h" pairing
  // forever, since nothing overwrites it while the fresh scrape finds nothing.
  const cached = readScrapedUsage(planId)
  if (cached) {
    const checked = sanityCheckFiveHour(cached)
    if (checked.usedPct !== null) return { usedPct: checked.usedPct, model: cached.model, resetsAt: checked.resetsAt, stale: true }
  }
  return { usedPct: null, model: null, resetsAt: null, stale: false }
}

function scrapeFreshUsage(pane: string): { usedPct: number | null; model: string | null; resetsAt: number | null } {
  // Either the "stop and wait for limit to reset" dialog or the plain
  // "You've hit your session/weekly limit" banner means the window is fully
  // exhausted (100%); neither repeats the "used X%" text the regex below
  // needs.
  //
  // Only a SESSION-limit banner speaks for the five-hour window. "hit your
  // weekly limit" used to match here too, so a weekly banner anywhere in the
  // 2000 lines of scrollback pinned the FIVE-HOUR row to 100% and paired it
  // with the WEEKLY reset time. Boss caught the contradiction on the widget
  // (2026-08-10): "~100% · 23 óra 19 perc múlva" on a window that can never
  // be more than five hours from resetting, while the statusline snapshot for
  // the same agent said 8% used and ~5h to go. The weekly figure has its own
  // row fed from that snapshot; it must not overwrite this one.
  if (/Stop and wait for limit to reset|hit your session limit/i.test(pane)) {
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

// A munkamenet-naplok (JSONL) atolvasasa ennek a vegpontnak a legdragabb
// resze: 2026-08-19-en az /api/overview EGYEDUL 1056 ms volt, es mivel a Node
// egy szalon fut, ezalatt minden mas keres is allt -- a merhetoen ~1,2 mp-es
// varakozas a level-oldal elso ket oszlopa elott innen jott (Boss: "az elso
// oszlop es masodik oszlop sem toltodik be hamar. sokat kell varni ra").
// Ket valtoztatas: a beolvasas aszinkron lett (kozben mas keresek sorra
// kerulnek), es az eredmeny egy percig ervenyes -- lejarat utan is AZONNAL a
// korabbi szam megy ki, a friss ertek a hatterben szamolodik ki.
const TURN_COUNT_TTL_MS = 60_000
const turnCountCache = new Map<string, { value: number; at: number }>()
const turnCountInFlight = new Set<string>()

export async function countUserTurnsCached(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): Promise<number> {
  const key = `${fromMs}::${toMs}`
  const hit = turnCountCache.get(key)
  const stale = !hit || Date.now() - hit.at >= TURN_COUNT_TTL_MS
  if (hit && stale && !turnCountInFlight.has(key)) {
    turnCountInFlight.add(key)
    void countUserTurns(fromMs, toMs)
      .then(value => { turnCountCache.set(key, { value, at: Date.now() }) })
      .catch(() => { /* a regi ertek marad */ })
      .finally(() => { turnCountInFlight.delete(key) })
  }
  if (hit) return hit.value
  const value = await countUserTurns(fromMs, toMs)
  turnCountCache.set(key, { value, at: Date.now() })
  // A kulcs napszakfuggo (mai/tegnapi hatarok), ezert napvaltaskor uj kulcsok
  // jonnek -- a regieket ne gyujtsuk vegtelenul.
  if (turnCountCache.size > 8) {
    for (const [k, v] of [...turnCountCache].sort((a, b) => a[1].at - b[1].at).slice(0, turnCountCache.size - 8)) {
      if (v) turnCountCache.delete(k)
    }
  }
  return value
}

/** Csak teszthez: a szamlalo-cache uritese. */
export function resetTurnCountCacheForTest(): void {
  turnCountCache.clear()
  turnCountInFlight.clear()
}

// Count "real" user turns (operator prompts, Telegram messages) in every
// Claude Code session JSONL under ~/.claude/projects/. Filters out
// tool_result, local-command, and synthetic system events so a task-heavy
// hour doesn't inflate the counter.
async function countUserTurns(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): Promise<number> {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return 0
  let total = 0
  try {
    for (const projectDir of await readdir(root)) {
      const absDir = join(root, projectDir)
      let dirStat: Awaited<ReturnType<typeof statAsync>>
      try { dirStat = await statAsync(absDir) } catch { continue }
      if (!dirStat.isDirectory()) continue
      for (const fname of await readdir(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const absFile = join(absDir, fname)
        let fstat: Awaited<ReturnType<typeof statAsync>>
        try { fstat = await statAsync(absFile) } catch { continue }
        if (fstat.mtimeMs < fromMs) continue
        try {
          const data = await readFile(absFile, 'utf-8')
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

  // Tetelesen: mi valtozott az upstreamben, emberi nyelven.
  //
  // Boss: "azt kellene kiirnia hogy mit javitottak rajta!? [...] emberi
  // nyelven. es hogy ezek kellenek e nekunk." Kulon vegpont, mert ez egy hosszu
  // lista (jelenleg 112 tetel), es az Attekintes betoltesenek nem kell cipelnie
  // -- csak akkor toltjuk le, amikor a Boss tenyleg megnyitja.
  if (path === '/api/upstream/changes' && method === 'GET') {
    const view = readUpstreamChanges()
    if (!view) {
      jsonMaybeGzip(req, res, { available: false })
      return true
    }
    jsonMaybeGzip(req, res, { available: true, ...view })
    return true
  }

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
    const userTurns = await countUserTurnsCached(startTs)
    const userTurnsPrev = await countUserTurnsCached(yesterday, startTs)
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
        //
        // Boss 2026-08-15: `measuredAt`, nem `updatedAt`. A statusline minden
        // kepernyo-frissiteskor ujrairja a fajlt, de a SZAZALEKOKAT csak akkor,
        // amikor a Claude jelentette oket -- egy sokat rajzolo, de keveset
        // dolgozo agens igy a vegtelensegig frissnek mutatott egy regi merest.
        stale: rlSnapshot ? isStale(rlSnapshot.measuredAt, Date.now()) : false,
        measuredAt: rlSnapshot?.measuredAt ?? null,
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
        // measuredAt, nem updatedAt -- lasd a Lackor2-sor melletti indoklast.
        const snapFresh = snap && !isStale(snap.measuredAt, Date.now())
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
            measuredAt: snap.measuredAt,
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
            // A panel-leolvasas MOST tortent; ha az elavult (`scraped.stale`),
            // akkor a gyorsitotarazott ertek kora a pillanatkepe.
            measuredAt: scraped.stale ? (snap?.measuredAt ?? null) : Date.now(),
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
          measuredAt: snap?.measuredAt ?? null,
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
      upstreamSync: readUpstreamSyncStatus(),
    })
    return true
  }

  return false
}
