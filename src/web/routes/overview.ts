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
      openrouterCredits,
    })
    return true
  }

  return false
}
