/**
 * "Commit es Push Most" -- a Szinkron gomb testvere.
 *
 * Boss, 2026-09-18: a Szinkron most 10 taroloból csak 2-t frissit, mert a
 * tobbinel commit+push hianyzik (a szinkron SOHA nem ir felul mentetlen
 * munkat). Kell egy gomb, ami a legokosabb ELO, token-nel biro agensre bizza,
 * hogy minden elmaradt tarolot atvizsgaljon, commitoljon es pusholjon (barki
 * hagyta ott) -- utana a Szinkron csont nelkul megy.
 *
 * Ez a modul a DISZPECSER: felmeri az elmaradt tarolokat, kivalasztja a
 * legokosabb elerheto agenst, es kiad neki egy ONMAGABAN teljes munkacsomagot
 * (pontos utak, parancsok, kikotesek). A tenyleges git-munkat az agens vegzi
 * el a sajat munkamenetében -- itt csak a felmeres, a valasztas es a kiadas
 * tortenik. A "kesz" allapotot NEM egy jelentes-fajlbol olvassuk vissza (az
 * nema kudarcra hajlamos), hanem MINDIG friss felmeresbol: a foldi igazsag
 * maguk a tarolok.
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { createAgentMessage } from '../db.js'
import { logger } from '../logger.js'
import { scanReposNeedingCommitPush, type CommitPushRepo, type CommitPushScan } from '../git-sync.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { listAgentNames, readAgentModel } from './agent-config.js'
import { agentSessionName, sessionExistsOnHost } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { readRateLimitSnapshot } from './rate-limit-status-io.js'
import { pickSmartestWorker, type WorkerCandidate, type WorkerPick } from './smartest-worker.js'

/** Ide jegyezzuk fel az utolso kiadast -- ezt mutatja a gomb alatti sor. */
const DISPATCH_FILE = join(STORE_DIR, 'commit-push-dispatch.json')

/** Egy korabbi kiadas nyoma. A friss allapot mindig a felmeresbol jon. */
export interface CommitPushDispatch {
  /** Mikor adtuk ki (ISO). */
  at: string
  /** Melyik agensnek. */
  agent: string
  /** Milyen modellen fut az agens (a valasztas indoklasahoz). */
  model: string
  /** Hany tarolot kapott. */
  repoCount: number
  /** Az inter-agent uzenet azonositoja (visszakovethetoseghez). */
  messageId: number
}

/** Egy elo agens-jelolt allapota (fut-e, mennyi az 5 oras kerete). */
function liveCandidate(agent: string): WorkerCandidate {
  const session = agent === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(agent)
  const snap = readRateLimitSnapshot(agent)
  return {
    agent,
    model: readAgentModel(agent),
    running: sessionExistsOnHost(null, session),
    // KIZAROLAG az 5 oras keret szamit (Boss ismetelt szabalya) -- a heti szam
    // KIJELZES, nem korlat, ezert ide nem vesszuk be.
    fiveHourPct: snap?.fiveHour?.usedPct ?? null,
    usageAt: snap?.updatedAt && snap.updatedAt > 0 ? snap.updatedAt : null,
  }
}

/** Minden szoba johato agens elo allapota: a fo-agens es a flotta. */
export function listWorkerCandidates(): WorkerCandidate[] {
  return [MAIN_AGENT_ID, ...listAgentNames()].map(liveCandidate)
}

export function readLastDispatch(): CommitPushDispatch | null {
  if (!existsSync(DISPATCH_FILE)) return null
  try { return JSON.parse(readFileSync(DISPATCH_FILE, 'utf8')) as CommitPushDispatch } catch { return null }
}

function writeLastDispatch(d: CommitPushDispatch): void {
  try { atomicWriteFileSync(DISPATCH_FILE, JSON.stringify(d, null, 2)) } catch { /* a kiadas ettol meg ervenyes */ }
}

/**
 * A munkacsomag szovege -- ONMAGABAN teljes, hogy egy friss telepitesen is
 * ertheto legyen, skill nelkul is. Pontos utak, parancsok es kikotesek.
 * Tiszta fuggveny (nincs I/O), hogy egysegteszt lefedhesse.
 */
export function buildWorkPackage(repos: CommitPushRepo[]): string {
  const lines: string[] = []
  lines.push('[COMMIT-PUSH-MUNKA] A Raktár git-tárolóiban mentetlen munka áll, ezért a Szinkron kihagyja őket.')
  lines.push('Feladat: vizsgáld át MINDEGYIKET, és vidd készre (commit + push) -- teljesen mindegy, ki hagyta ott.')
  lines.push('')
  lines.push(`Érintett tárolók (${repos.length}):`)
  for (const r of repos) {
    const bits: string[] = []
    if (r.dirty > 0) bits.push(`${r.dirty} helyben módosított fájl`)
    if (r.ahead > 0) bits.push(`${r.ahead} fel nem töltött commit`)
    if (r.diverged) bits.push('FIGYELEM: a helyi és a távoli ág szétvált')
    if (!r.hasUpstream) bits.push('nincs távoli ág (első push kell)')
    lines.push(`  - ${r.abs}  (${bits.join(', ') || 'mentetlen munka'})${r.account ? `  [fiók: ${r.account}]` : ''}`)
  }
  lines.push('')
  lines.push('Lépések tárolónként:')
  lines.push('  1. cd a tároló útjába, és nézd meg mi változott: `git status` + `git diff` (és `git diff --staged`).')
  lines.push('  2. Ellenőrizd, nincs-e a változás közt véletlenül titok/kulcs/nagy bináris. Ha gyanús, NE commitold vakon: hagyd ki azt a fájlt, és a végén jelezd Bossnak.')
  lines.push('  3. `git add -A`, majd ÉRTELMES commit-üzenettel: `git commit -m "..."` (írd le MIT tartalmaz a változás, ne "wip"/"update").')
  lines.push('  4. `git push`. Ha nincs upstream: `git push -u origin HEAD`.')
  lines.push('  5. Ha a helyi és a távoli ág SZÉTVÁLT (diverged): SOHA ne `push --force`. Húzd le fetch-csel, nézd meg, és ha nem egyértelmű a feloldás, hagyd ki és jelezd Bossnak -- inkább maradjon, mint hogy elvesszen valami.')
  lines.push('')
  lines.push('Amikor MIND kész: írj Bossnak a Telegram-csatornáján egy rövid sort (hány tároló, mi maradt ki és miért), és hogy most már a "Szinkron most" csont nélkül lefut.')
  lines.push('A tárolók a felhasználó saját git-repói (a Raktárban), NEM a marveen élő fája -- ott a commit+push pontosan a cél.')
  return lines.join('\n')
}

export type DispatchOutcome =
  | { ok: true; kind: 'dispatched'; agent: string; model: string; repoCount: number; messageId: number; message: string }
  | { ok: true; kind: 'nothing'; message: string }
  | { ok: false; kind: 'root_error' | 'no_agent'; message: string }

/**
 * A gomb szervoldali muvelete: felmer, valaszt, kiad.
 *
 * A candidate-listat parameterkent is at lehet adni (teszthez); alapbol az elo
 * flottabol epul.
 */
export async function dispatchCommitPush(
  opts: { scan?: CommitPushScan; candidates?: WorkerCandidate[]; now?: number } = {},
): Promise<DispatchOutcome> {
  const scan = opts.scan ?? await scanReposNeedingCommitPush()

  // A depo gyokere nem jarhato be -- a NULLA itt "nem lattam oda", nem
  // "minden rendben". Hangosan kell mondani.
  if (scan.rootError) {
    return {
      ok: false, kind: 'root_error',
      message: `Nem látok a tárolók mappájába (${scan.rootError}). Amíg ez nem áll helyre, nem tudom felmérni, mi maradt el.`,
    }
  }

  if (scan.repos.length === 0) {
    return {
      ok: true, kind: 'nothing',
      message: 'Nincs elmaradt tároló: mindegyik commitolva és feltöltve van. A Szinkron most csont nélkül lefut.',
    }
  }

  const candidates = opts.candidates ?? listWorkerCandidates()
  const pick: WorkerPick | null = pickSmartestWorker(candidates, opts.now ?? Date.now())
  if (!pick) {
    return {
      ok: false, kind: 'no_agent',
      message: 'Most egyetlen ágens sem tud dolgozni (élő + van 5 órás tokene). Indíts el egy ágenst, és próbáld újra.',
    }
  }

  const content = buildWorkPackage(scan.repos)
  const msg = createAgentMessage(MAIN_AGENT_ID, pick.agent, content)
  const dispatch: CommitPushDispatch = {
    at: new Date().toISOString(),
    agent: pick.agent,
    model: pick.model,
    repoCount: scan.repos.length,
    messageId: msg.id,
  }
  writeLastDispatch(dispatch)
  logger.info({ agent: pick.agent, model: pick.model, repos: scan.repos.length, messageId: msg.id }, '[commit-push] kiadva a legokosabb elo agensnek')

  return {
    ok: true, kind: 'dispatched',
    agent: pick.agent, model: pick.model, repoCount: scan.repos.length, messageId: msg.id,
    message: `${scan.repos.length} tárolót kiadtam a(z) ${pick.agent} ágensnek (${pick.model}) commit+push-ra. Amint kész, Bossnak szól a Telegramon, utána a Szinkron csont nélkül megy.`,
  }
}
