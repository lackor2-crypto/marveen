// Perces elo keret-mintavetel a fo fiokra, a bongeszotol FUGGETLENUL (#710).
//
// A hiba: a Telegram-keretriaszto (scripts/ratelimit-telegram-alert.sh) a
// statusline-pillanatkepet olvassa, az pedig csak akkor frissul, amikor a fo
// agens dolgozik. Egy tetlen agens mellett -- amikor ugyanazt a fiokot egy masik
// kliens (VS Code) egeti -- a fajl orakig all, a riaszto pedig a 30 percnel
// regebbi pillanatkepet "kihagyva" naploz: pont akkor nem szol, amikor 99%-on
// jar a keret. A dashboard kijelzese mar az elo fiok-lekerdezesbol dolgozik
// (claude-usage-api.ts), de csak amig valaki nyitva tartja az Attekintest.
//
// Ez a modul percenkent megkerdezi a fo fiokot, es az eredmenyt a
// pillanatkep-fajlokkal AZONOS alakban a store/rate-limit-status/live-<fo>.json-ba
// irja. A riaszto a friss elo fajlt elonyben reszesiti, es csak ha az hianyzik
// vagy regi, esik vissza a statusline-pillanatkepre.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../config.js'
import { resolveMainAgentConfigDir } from './agent-process.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { appendUsageSample, usageHistoryPath } from './usage-history.js'
import {
  liveUsageForAccount, readAccountAccessToken, readFleetToken,
  type LiveUsageResult,
} from './claude-usage-api.js'

export const LIVE_USAGE_SAMPLE_INTERVAL_MS = 60_000
export const LIVE_USAGE_SAMPLE_INITIAL_DELAY_MS = 15_000

/** A fo fiok OAuth tokenje: a sajat config-konyvtarabol, ennek hianyaban a flotta setup-tokenjebol. */
export function mainAccountUsageToken(): string | null {
  const explicit = resolveMainAgentConfigDir()
  const fromDir = readAccountAccessToken(explicit ?? join(homedir(), '.claude'))
  if (fromDir) return fromDir
  return readFleetToken(join(PROJECT_ROOT, 'store', '.claude-oauth-token'))
}

export function liveUsageFilePath(agentId: string = MAIN_AGENT_ID, storeDir: string = STORE_DIR): string {
  return join(storeDir, 'rate-limit-status', `live-${agentId}.json`)
}

/** A fajl tartalma: ugyanaz az alak, mint a statusline-pillanatkepe (agent, fiveHour, sevenDay, updatedAt). */
export function liveUsageFileBody(agentId: string, r: Extract<LiveUsageResult, { ok: true }>): string {
  const win = (w: { usedPct: number; resetsAt: number | null } | null) =>
    w ? { usedPct: w.usedPct, resetsAt: w.resetsAt } : null
  const { usage } = r
  return JSON.stringify({
    agent: agentId,
    fiveHour: win(usage.fiveHour),
    sevenDay: win(usage.sevenDay),
    updatedAt: usage.measuredAt,
    windowsUpdatedAt: usage.measuredAt,
    source: 'live-account-usage',
  })
}

let lastFailure = ''

/** Egy mintavetel. Sosem dob: a mintavevo nem allithatja meg a dashboardot. */
export async function sampleMainLiveUsage(
  deps: {
    token?: () => string | null
    fetchUsage?: (token: string | null) => Promise<LiveUsageResult>
    write?: (path: string, data: string) => void
    path?: string
    historyPath?: string
  } = {},
): Promise<'written' | 'skipped'> {
  try {
    const r = await (deps.fetchUsage ?? ((t) => liveUsageForAccount(MAIN_AGENT_ID, t)))((deps.token ?? mainAccountUsageToken)())
    if (!r.ok) {
      // A csend nem valasz, de percenkenti naplo-zaj sem: csak a hiba VALTOZASAT naplozzuk.
      const key = `${r.reason}:${r.detail}`
      if (key !== lastFailure) {
        lastFailure = key
        logger.warn({ account: MAIN_AGENT_ID, reason: r.reason, detail: r.detail }, 'live usage sampler: nincs elo keret-meres')
      }
      return 'skipped'
    }
    lastFailure = ''
    ;(deps.write ?? ((p, d) => { mkdirSync(dirname(p), { recursive: true }); atomicWriteFileSync(p, d, { mode: 0o600 }) }))(deps.path ?? liveUsageFilePath(), liveUsageFileBody(MAIN_AGENT_ID, r))
    // #799: keep the reading, the live file above is overwritten every minute.
    // An injected writer means a test: it must not touch the real store, so no default history path then.
    const historyPath = deps.historyPath ?? (deps.write ? null : usageHistoryPath(MAIN_AGENT_ID))
    if (historyPath) appendUsageSample(historyPath, {
      t: r.usage.measuredAt,
      fiveHourPct: r.usage.fiveHour?.usedPct ?? null,
      fiveHourResetsAt: r.usage.fiveHour?.resetsAt ?? null,
      sevenDayPct: r.usage.sevenDay?.usedPct ?? null,
    })
    return 'written'
  } catch (err) {
    logger.warn({ err }, 'live usage sampler: mintavetel hiba')
    return 'skipped'
  }
}

export function startLiveUsageSampler(): NodeJS.Timeout | undefined {
  if (process.env.MARVEEN_LIVE_USAGE_SAMPLER === '0') return undefined
  setTimeout(() => { void sampleMainLiveUsage() }, LIVE_USAGE_SAMPLE_INITIAL_DELAY_MS).unref()
  return setInterval(() => { void sampleMainLiveUsage() }, LIVE_USAGE_SAMPLE_INTERVAL_MS)
}
