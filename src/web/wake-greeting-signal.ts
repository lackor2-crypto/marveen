// Kanban #202 (231cb999): a felebredeskori koszones-dontes ELO adatbol.
//
// A tiszta logika a src/wake-greeting.ts-ben van (se DB, se ora); ez a modul
// csak a merest vegzi el hozza, es elkapja a DB-hibat. A megkulonboztetes nem
// stilus: egy elszallt lekerdezes NEM lehet ugyanaz, mint egy ures naplo -- az
// elso "nem latok oda", a masodik "nincs mit latni", es a ketto ellentetes
// dontest erdemelne. Itt mindketto a biztonsagos agra fut (koszonj), de a
// `reason` megmondja, melyikrol volt szo.

import { getConversationEdge } from '../db.js'
import {
  decideWakeGreeting,
  buildWakeGreetingContext,
  type ConversationEdge,
  type WakeGreetingDecision,
} from '../wake-greeting.js'

/** Az agens neve == a ledger agent_id-je (a ledger_lib a cwd-bol ugyanezt
 *  szarmaztatja a fo agensre es a sub-agensekre is). Kulon fuggveny, hogy ha ez
 *  valaha elvalna, egy helyen kelljen javitani. */
export function agentIdForLedger(name: string): string {
  return name
}

export function readConversationEdge(agent: string): ConversationEdge {
  try {
    const e = getConversationEdge(agentIdForLedger(agent))
    return { ...e, readable: true }
  } catch {
    return { lastInboundAt: null, answered: false, inboundRows: 0, readable: false }
  }
}

export function getWakeGreetingDecision(agent: string, nowMs: number = Date.now()): WakeGreetingDecision {
  return decideWakeGreeting(readConversationEdge(agent), nowMs)
}

/** A SessionStart-kor injektalando koszones-blokk, vagy null (lasd
 *  buildWakeGreetingContext: csak a MERT agakon beszel). */
export function getWakeGreetingContext(agent: string, nowMs: number = Date.now()): string | null {
  return buildWakeGreetingContext(getWakeGreetingDecision(agent, nowMs))
}
