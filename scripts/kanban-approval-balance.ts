#!/usr/bin/env -S npx tsx
//
// Boss's rule, 2026-08-16: the kanban `waiting` column and the `pending`
// approvals must line up, one to one. This is the runner the periodic sweep
// calls -- it reads `{"cards":[...],"approvals":[...]}` on stdin and prints a
// Hungarian report, or nothing at all when the board is in order.
//
// It imports the SERVER's own pairing logic (waitingApprovalBalance ->
// approvalCardId) rather than reimplementing it in the audit script. That is
// the whole point: the first hand-written measurement of this imbalance matched
// on action_payload only, missed every approval that carries the card id in its
// description text, and reported cards as orphans that already had one. A guard
// with its own private notion of "paired" produces exactly that false alarm.
//
// Never exits nonzero on a bad board: the imbalance is the FINDING, not a
// failure of this script. A nonzero exit here would look like the sweep itself
// broke.

import { waitingApprovalBalance } from '../src/kanban-related.js'
import type { BalanceApproval, BalanceCard } from '../src/kanban-related.js'

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => { buf += c })
    process.stdin.on('end', () => resolve(buf))
  })
}

const label = (c: { id: string; seq?: number | null; title?: string }): string =>
  `  #${c.seq ?? '?'} ${c.id.slice(0, 8)} -- ${(c.title || '').slice(0, 60)}`

const REASON: Record<string, string> = {
  'no-card': 'nem hivatkozik kartyara',
  'unknown-card': 'a hivatkozott kartya nincs a tablan',
  'card-not-waiting': 'a kartya nem varakozo',
}

/**
 * Both endpoints answer either with a bare array or with `{ cards: [...] }` /
 * `{ approvals: [...] }` depending on the route, and the caller pastes whatever
 * came back straight into this input. Unwrap both shapes rather than assuming
 * one -- the first measurement script written against these endpoints crashed
 * on exactly this ('list' object has no attribute 'get').
 */
function rows<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key]
    if (Array.isArray(inner)) return inner as T[]
  }
  return []
}

async function main(): Promise<void> {
  let cards: BalanceCard[] = []
  let approvals: BalanceApproval[] = []
  try {
    const parsed = JSON.parse(await readStdin()) as { cards?: unknown; approvals?: unknown }
    cards = rows<BalanceCard>(parsed.cards, 'cards')
    approvals = rows<BalanceApproval>(parsed.approvals, 'approvals')
  } catch {
    return // unreadable input says nothing about the board; stay quiet
  }

  const b = waitingApprovalBalance(cards, approvals)
  if (b.balanced && b.waitingCount === b.pendingCount) return

  const lines = [
    `VARAKOZO/JOVAHAGYAS ELTERES: ${b.waitingCount} varakozo kartya, ${b.pendingCount} fuggo jovahagyas.`,
  ]

  if (b.waitingWithoutApproval.length > 0) {
    lines.push(`VARAKOZO, DE SENKIT NEM KERDEZUNK ROLA (${b.waitingWithoutApproval.length}):`)
    for (const c of b.waitingWithoutApproval.slice(0, 10)) lines.push(label(c))
    lines.push('  -> nezd meg a KODBAN kesz-e (a kartya leirasa nem bizonyitek). Ha igen: add fel')
    lines.push('     jovahagyasra. Ha nem: told vissza folyamatban-ba.')
  }

  if (b.pendingWithoutWaitingCard.length > 0) {
    lines.push(`FUGGO JOVAHAGYAS VARAKOZO KARTYA NELKUL (${b.pendingWithoutWaitingCard.length}):`)
    for (const p of b.pendingWithoutWaitingCard.slice(0, 10)) {
      const why = REASON[p.reason] + (p.cardStatus ? ` (${p.cardStatus})` : '')
      const ref = p.cardId ? ` kartya ${p.cardId.slice(0, 8)}` : ''
      lines.push(`  jovahagyas ${p.approval.id.slice(0, 8)}${ref} -- ${why}`)
    }
  }

  if (b.waitingCount !== b.pendingCount && b.balanced) {
    // Counts differ while every pair matched: more than one approval on the
    // same card, which the idempotent auto-raise is supposed to prevent.
    lines.push('  (a parositas rendben, csak a darabszam ter el -- valoszinuleg ket jovahagyas ul ugyanazon a kartyan)')
  }

  console.log(lines.join('\n'))
}

void main()
