// Which model is the main agent running, and what do we say when we cannot see it.
//
// Boss, 2026-08-16: "a beallitas agent alatt a sonett 5 van beallitva. marvinnak.
// akkor miert meg mindig a haiku van?" Measured the same day, the dashboard was
// not saying Haiku OR Sonnet: `/api/marveen` answered `"model": "unknown"`, and
// the card badge printed that word. The process was in fact running Haiku 4.5,
// exactly as configured, so the only broken thing was the READING.
//
// Boss, 2026-08-24: "meg mindig opus5 . vicces. mintha nem akarna valtani."
// Megmerve ugyanakkor: a futo folyamat parancssora MAR `--model claude-sonnet-5`
// volt, a beallitas is sonnet, es a `valueSavedAt` -> `runningSince` kulonbseg
// 4,2 MASODPERC. Vagyis az ujrainditas azonnal megtortent; a KEPERNYO maradt
// opus-on, mert ez a fuggveny a TRANSZKRIPTET kerdezte eloszor -- egy frissen
// respawnolt session pedig meg egyetlen assistant-sort sem irt, igy a kereso a
// KORABBI (opus-os) transzkriptet olvasta, es azt mondta ki tenykent.
//
// Ezert a futo FOLYAMAT sajat `--model` kapcsoloja lett az elso forras: ez a
// legkozvetlenebb valasz arra, hogy MIT futtat MOST, es a respawn pillanataban
// mar olvashato -- nem kell megvarni, amig a modell megszolal.
//
// Negy helyrol johet a valasz, es maskepp romlanak el, ezert szamit a sorrend:
//
//   0. a futo folyamat parancssora (`--model`) -- azonnali es egyertelmu, de
//      csak akkor van, ha egyaltalan latunk futo folyamatot
//   1. a live transcript -- the truth about the RUNNING process, but it goes
//      quiet: a session can carry no `message.model` line at all
//   2. the statusline snapshot -- the same data Claude Code renders every tick,
//      usable only while FRESH (a stale one reports an hours-old model, and its
//      price, as current)
//   3. the configured value -- the Settings page's saved override, else .env
//      MAIN_AGENT_MODEL, else .claude/settings.json `model`, mirroring
//      scripts/channels.sh's resolve_main_model()
//
// The configured value is the one that was missing. It is weaker evidence than
// the other two (it says what the next start WILL use, not what is running), but
// it is never worse than the word "unknown", which tells the owner nothing and
// reads like a fault.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { MODEL_ALIASES } from './agent-config.js'
import { readActiveModelFromProjectDir } from './active-model.js'
import { readMainAgentRuntime } from './main-agent-runtime.js'
import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import { isStale } from '../rate-limit-status.js'

export type MainModelSource = 'runtime' | 'transcript' | 'statusline' | 'configured' | 'none'

export interface MainModelResolution {
  /** What to show. 'unknown' only when every source is silent. */
  model: string
  source: MainModelSource
}

export interface MainModelSources {
  /**
   * The `--model` flag on the live claude process, or null when no process is
   * visible. Highest priority: it is what the process was ACTUALLY started
   * with, and it is readable the moment the respawn happens.
   */
  fromRuntime?: () => string | null
  /** The running process's own transcript, or null when it names no model. */
  fromTranscript: () => string | null
  /** A FRESH statusline reading, or null. Staleness is the caller's job. */
  fromStatusline: () => string | null
  /** The configured model ('' when nothing is configured). */
  configured: () => string
}

/**
 * Read the configured main-agent model: the Settings page first, then .env.
 *
 * Precedence mirrors scripts/channels.sh's resolve_main_model() exactly, and it
 * is now THREE layers, not two:
 *
 *   1. store/config-overrides.json -- what the Settings page saves
 *   2. .env MAIN_AGENT_MODEL       -- the setup wizard, or a hand-edited install
 *   3. .claude/settings.json model -- the tracked repo default
 *
 * Layer 1 is the one that was missing, and its absence is the whole of the
 * owner's 2026-08-16 report. The Settings page writes ONLY to
 * config-overrides.json, so a model chosen there was validated, saved, echoed
 * back -- and then read by nobody: neither this function nor the launcher ever
 * looked at that file. The setting appeared to work and changed nothing.
 *
 * The override file is read here directly rather than through
 * settings-store.ts, so this stays a pure function of `projectRoot`: the
 * launcher-side helper and the tests each point it at a root of their own.
 *
 * Returns '' when nothing is set, never a guess.
 */
export function readConfiguredMainModel(projectRoot: string): string {
  try {
    const overridePath = join(projectRoot, 'store', 'config-overrides.json')
    if (existsSync(overridePath)) {
      const parsed = JSON.parse(readFileSync(overridePath, 'utf-8'))
      const saved = parsed?.MAIN_AGENT_MODEL
      if (typeof saved === 'string' && saved.trim()) return saved.trim()
    }
  } catch {
    /* egy serult override-fajl ne nemitsa el a masik ket forrast */
  }
  try {
    const envPath = join(projectRoot, '.env')
    if (existsSync(envPath)) {
      const line = readFileSync(envPath, 'utf-8')
        .split('\n')
        .find((l) => l.startsWith('MAIN_AGENT_MODEL='))
      const envModel = line?.slice('MAIN_AGENT_MODEL='.length).trim()
      if (envModel) return envModel
    }
  } catch {
    /* fall through to settings.json */
  }
  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return ''
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const model = parsed?.model
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Compose the three sources into one answer plus WHERE it came from.
 *
 * The source travels with the value on purpose: a caller that wants to tell the
 * owner "this is what it will run at the next start" can only do that if it
 * knows the answer came from the configuration rather than from the live
 * process. Pure, so the precedence is provable without touching the filesystem.
 */
export function resolveMainAgentModel(sources: MainModelSources): MainModelResolution {
  const runtime = sources.fromRuntime ? safe(sources.fromRuntime) : null
  if (runtime) return { model: runtime, source: 'runtime' }
  const transcript = safe(sources.fromTranscript)
  if (transcript) return { model: transcript, source: 'transcript' }
  const statusline = safe(sources.fromStatusline)
  if (statusline) return { model: statusline, source: 'statusline' }
  const configured = safe(sources.configured)
  if (configured) return { model: configured, source: 'configured' }
  return { model: 'unknown', source: 'none' }
}

/**
 * Turn the statusline's human model label ("Sonnet 5", "Opus 5", "Haiku 4.5")
 * into the canonical id the cost table is keyed by. The alias map already knows
 * "sonnet-5"; this only bridges the spacing/case difference.
 *
 * EXACT alias only. Falling back to the family word ('sonnet-4.5' -> 'sonnet')
 * resolved to whatever version the alias map happens to point at today, so a
 * statusline reading "Sonnet 4.5" would have been reported as Sonnet 5 -- with
 * Sonnet 5's price attached, shown to the owner as fact (lackor3's second
 * review). An unknown label is better answered with "unknown" than with a
 * confident wrong version.
 */
export function modelIdFromStatuslineLabel(label: string): string | null {
  const slug = label.trim().toLowerCase().replace(/\s+/g, '-')
  if (!slug) return null
  return MODEL_ALIASES[slug] ?? null
}

/**
 * The main agent's model as the dashboard should present it, everywhere.
 *
 * One function, so the Agents page, the team graph and /api/marveen cannot
 * drift into three different answers for the same question -- which is how the
 * team graph ended up printing "unknown" while the card had a working
 * statusline fallback.
 */
export function mainAgentModelNow(): MainModelResolution {
  return resolveMainAgentModel({
    fromRuntime: () => readMainAgentRuntime().model,
    fromTranscript: () => readActiveModelFromProjectDir(PROJECT_ROOT),
    fromStatusline: () => {
      const snap = readRateLimitSnapshot(MAIN_AGENT_ID)
      if (!snap || isStale(snap.updatedAt, Date.now())) return null
      return snap.model ? modelIdFromStatuslineLabel(snap.model) : null
    },
    configured: () => readConfiguredMainModel(PROJECT_ROOT),
  })
}

/** One silent source must not take the other two down with it. */
function safe(read: () => string | null): string | null {
  try {
    const v = read()
    return typeof v === 'string' && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}
