import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  normalizeGateConfig,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
} from '../context-restart-gate.js'

const CONFIG_PATH = join(PROJECT_ROOT, 'store', 'context-restart-gate.json')
const STATE_PATH  = join(PROJECT_ROOT, 'store', 'context-restart-gate-state.json')

// ---- Config (per-agent, keyed by agent name) --------------------------------

function readConfigRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

export function readGateConfig(name: string): GateConfig {
  const raw = readConfigRaw()
  return name in raw ? normalizeGateConfig(raw[name]) : { ...DEFAULT_GATE_CONFIG }
}

export function writeGateConfig(name: string, cfg: unknown): GateConfig {
  const normalized = normalizeGateConfig(cfg)
  const raw = readConfigRaw()
  raw[name] = normalized
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2))
  return normalized
}

// ---- State (per-agent run-state: blocking streak tracking) ------------------

export interface GateRunState {
  /** Epoch ms when continuous blocking started; null when not blocked. */
  firstBlockedAt: number | null
  /** Epoch ms of the last persistent-block alert sent to bigme. */
  lastAlertAt: number | null
  /** Epoch ms when the last /clear was successfully sent. */
  lastClearAt: number | null
}

const EMPTY_STATE: GateRunState = {
  firstBlockedAt: null,
  lastAlertAt: null,
  lastClearAt: null,
}

function readStateRaw(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function normalizeState(raw: unknown): GateRunState {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const msOrNull = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : null
  return {
    firstBlockedAt: msOrNull(o.firstBlockedAt),
    lastAlertAt:    msOrNull(o.lastAlertAt),
    lastClearAt:    msOrNull(o.lastClearAt),
  }
}

export function readGateRunState(name: string): GateRunState {
  const raw = readStateRaw()
  return name in raw ? normalizeState(raw[name]) : { ...EMPTY_STATE }
}

export function writeGateRunState(name: string, state: GateRunState): void {
  const raw = readStateRaw()
  raw[name] = state
  atomicWriteFileSync(STATE_PATH, JSON.stringify(raw, null, 2))
}

// ---- Live status (observability only, never an input to a decision) ---------
//
// The gate evaluates every few minutes and logs its decision at debug level,
// which the info-level logger drops -- so from the outside an enabled gate with
// a 100000 threshold and an agent sitting at 300207 looked identical to a
// broken one (Boss, 2026-08-12: "ezt mondtam hogy nem mukodik"). This file is
// the answer to "why has it not cleared?": last decision, its reason, and the
// numbers it was made from, one entry per agent.

const STATUS_PATH = join(PROJECT_ROOT, 'store', 'context-restart-gate-status.json')

export interface GateStatus {
  ts: number
  action: string
  reason: string
  contextTokens: number | null
  thresholdTokens: number
  enabled: boolean
  aboveThreshold: boolean
}

export function writeGateStatus(name: string, status: GateStatus): void {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(STATUS_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch { /* first write */ }
  raw[name] = status
  try { atomicWriteFileSync(STATUS_PATH, JSON.stringify(raw, null, 2)) } catch { /* observability must never break the gate */ }
}

export function readGateStatus(name: string): GateStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(STATUS_PATH, 'utf-8'))
    const entry = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>)[name] : null
    return (entry && typeof entry === 'object') ? entry as GateStatus : null
  } catch { return null }
}
