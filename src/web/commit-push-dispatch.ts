// Kartya acc07213: a "Commit es Push Most" gomb hattere. Felmeri az elmaradt
// tarolokat (git-sync.findOutstandingRepos), kivalasztja a legokosabb ELO,
// token-nel biro agenst, es kiadja neki a commit+push feladatot. Ha nincs
// elerheto agens, a fo agens (mi) kapja -- delegate-availability-check elve:
// a munka nem maradhat kiadatlanul.

import { MAIN_AGENT_ID } from '../config.js'
import { listBrokerCandidates } from './context-broker-store.js'
import { readAgentModel } from './agent-config.js'
import { tierForPct } from '../rate-limit-status.js'
import { findOutstandingRepos, type OutstandingRepo } from '../git-sync.js'
import { createAgentMessage } from '../db.js'
import { logger } from '../logger.js'

/**
 * Modell-"okossag" rangsor (Boss, 2026-09-18: "ne a high cut valassza, hanem
 * inkabb az opus 5-ost, mindig a legmagasabb verzioju modellt"). A tier dominal
 * (opus > sonnet > haiku > egyeb/free), azon belul a verzioszam dont. Nem hasznal
 * kulso katalogust -- a modell-id-bol olvas, hogy mindig, offline is mukodjon.
 */
export function modelSmartnessRank(model: string | null | undefined): number {
  const m = String(model || '').toLowerCase()
  let tier: number
  if (m.includes('opus')) tier = 400
  else if (m.includes('sonnet')) tier = 300
  else if (m.includes('haiku')) tier = 200
  else if (m.includes('claude')) tier = 250      // ismeretlen tier-u Claude
  else tier = 100                                 // OpenRouter / :free / ismeretlen -> legalul
  const vm = m.match(/(\d+(?:[.\-]\d+)?)/)
  const ver = vm ? parseFloat(vm[1].replace('-', '.')) : 0
  return tier + (Number.isFinite(ver) ? Math.min(ver, 99) : 0)
}

export interface AgentPick {
  agent: string
  running: boolean
  usedPct: number | null
  model: string
  rank: number
}

/**
 * Tiszta valaszto: a jeloltekbol (nev + elo + usage + modell) a legokosabb ELO,
 * NEM kritikus (van tokenje) agenst adja vissza. Ha egy sincs, null. Azonos
 * rangnal a tobb szabad kerettel (kisebb usedPct) biro nyer.
 */
export function pickSmartestAgent(candidates: AgentPick[]): AgentPick | null {
  const usable = candidates.filter((c) => c.running && tierForPct(c.usedPct) !== 'critical')
  if (usable.length === 0) return null
  usable.sort((a, b) => b.rank - a.rank || ((a.usedPct ?? -1) - (b.usedPct ?? -1)) || a.agent.localeCompare(b.agent))
  return usable[0]
}

/** Elo forrasbol epiti a jelolteket es kivalasztja a legjobbat (I/O). */
export function pickCommitPushAgent(): { agent: string; reason: 'legokosabb-elo' | 'nincs-elerheto-fo-agens'; pick: AgentPick | null } {
  const candidates: AgentPick[] = listBrokerCandidates().map((c) => {
    const model = readAgentModel(c.agent)
    return { agent: c.agent, running: c.running, usedPct: c.usedPct, model, rank: modelSmartnessRank(model) }
  })
  const best = pickSmartestAgent(candidates)
  if (best) return { agent: best.agent, reason: 'legokosabb-elo', pick: best }
  // Senki nem elerheto: a fo agens vegzi el, hogy a munka ne maradjon kiadatlan.
  return { agent: MAIN_AGENT_ID, reason: 'nincs-elerheto-fo-agens', pick: null }
}

/** A kivalasztott agensnek szolo, onmagaban ertheto feladat-szoveg. */
export function buildCommitPushPrompt(repos: OutstandingRepo[]): string {
  const lista = repos.map((r) => {
    const mit = [r.dirty ? `${r.dirty} commitolatlan fajl` : null, r.ahead ? `${r.ahead} fel nem toltott commit` : null].filter(Boolean).join(', ')
    return `  - ${r.rel}  (${mit})${r.hasUpstream ? '' : '  [nincs upstream]'}\n      ${r.abs}`
  }).join('\n')
  return [
    '[FELADAT: elmaradt commit+push] Boss a "Commit es Push Most" gombbal kerte.',
    'Az alabbi tarolókban commit vagy push hianyzik. Mindegyiket vidd keszre,',
    'hogy a kovetkezo Szinkron mindent le tudjon hozni:',
    '',
    lista,
    '',
    'Minden tarolónal, a SAJAT mappajaban:',
    '1. git add -A',
    '2. git commit ertelmes uzenettel (irja le mi valtozott; ha tenyleg felbehagyott/',
    '   bizonytalan, "wip: <rovid leiras>" is jo -- a lenyeg hogy legyen szerzoje es uzenete).',
    '3. git push  (ha nincs upstream: git push -u origin HEAD).',
    '4. Ha a push protected branch / diverged miatt elszall: nyiss egy wip-<datum> branchet',
    '   es oda pushold, es ird bele a jelentesbe.',
    '',
    'NE nyulj a listan kivuli tarolóhoz. Amikor MIND kesz, kuldj Boss-nak Telegramon',
    'egy rovid osszefoglalot: hany taroló kesz, mi ment kulon branchre, mi bukott es miert.',
  ].join('\n')
}

export interface CommitPushDispatchResult {
  ok: boolean
  dispatched: boolean
  /** Elonezet: a kiadas (visszafordithatatlan) elott a hivonak meg kell erositenie. */
  needsConfirm?: boolean
  repos: { rel: string; dirty: number; ahead: number }[]
  agent: string | null
  reason: string | null
  message: string
}

/**
 * A gomb hattere: felmeres -> valasztas -> (elonezet) -> kiadas.
 * `confirm !== true` eseten csak ELONEZETET ad (mit tenne, ki csinalna), NEM ad ki
 * semmit -- a commit+push tobb tarolóban visszafordithatatlan, ezert elonezet elozi.
 */
export async function dispatchCommitPush(opts: { confirm?: boolean } = {}): Promise<CommitPushDispatchResult> {
  const outstanding = await findOutstandingRepos()
  const repos = outstanding.map((r) => ({ rel: r.rel, dirty: r.dirty, ahead: r.ahead }))
  if (outstanding.length === 0) {
    return { ok: true, dispatched: false, repos: [], agent: null, reason: null,
      message: 'Nincs elmaradt commit vagy push -- minden tároló mentve van. A Szinkron mosttól mindent lehoz.' }
  }
  const { agent, reason } = pickCommitPushAgent()
  const who = reason === 'nincs-elerheto-fo-agens'
    ? `${agent} (nincs más elérhető élő ágens, a fő ágens végzi)`
    : agent

  if (opts.confirm !== true) {
    return { ok: true, dispatched: false, needsConfirm: true, repos, agent, reason,
      message: `${outstanding.length} tárolóban van elmaradt commit vagy push. Kiadom ${who} részére, hogy commitolja és pusholja mindet?` }
  }

  const prompt = buildCommitPushPrompt(outstanding)
  try {
    createAgentMessage(MAIN_AGENT_ID, agent, prompt)
  } catch (err: any) {
    logger.warn({ err, agent }, '[commit-push] a feladat kiadasa nem sikerult')
    return { ok: false, dispatched: false, repos, agent, reason,
      message: `Nem sikerült kiadni a feladatot (${String(err?.message || err)}).` }
  }
  logger.info({ agent, reason, repos: outstanding.length }, '[commit-push] kiadva')
  return { ok: true, dispatched: true, repos, agent, reason,
    message: `Kiadva ${who} részére: ${outstanding.length} tároló. Jelez, amint kész, utána mehet a Szinkron.` }
}
