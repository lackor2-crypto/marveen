// Tanult felado-szabalyok az Email oldalhoz.
//
// Boss, 2026-08-15: "es ha spambe huzom akkor jeloje meg es a jovobeni
// leveleket azonnal a spambe iranyitsa."
//
// AMI MERT KORLAT, es amiert ez a fajl letezik:
//  - A Gmail SAJAT szuroit csak a Gmail API `settings.basic` scope-javal
//    lehetne letrehozni. A Marveen a leveleket IMAP-on (himalaya) kezeli, ez a
//    scope nincs meg -- tehat "igazi" Gmail-szurot nem tudunk irni.
//  - A Promociok nezet ugyanigy nem IMAP-mappa, hanem szuro az Inbox felett
//    (lasd email-promo-classify.ts). Oda "athuzni" egy levelet csak ugy lehet,
//    hogy a FELADOT jegyezzuk meg.
//
// Ezert a szabalyok itt, helyben allnak, es a Marveen maga hajtja vegre oket:
// spam-szabalynal a bejovo listazasakor a levelet a Spam mappaba mozgatjuk,
// promo-szabalynal pedig a Promociok nezetbe soroljuk. A Google sajat
// tanulasat ez nem helyettesiti, hanem kiegesziti.
//
// A fajl szandekosan tiszta fuggvenyekbol all (a betoltes/mentes kivetelevel),
// hogy a dontesi logika halozat es IMAP nelkul is merheto legyen.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { PROJECT_ROOT } from './config.js'

export type EmailRuleKind = 'spam' | 'promo'

export interface EmailRule {
  kind: EmailRuleKind
  /** Melyik bekotott fiokban ervenyes. Tiz fioknal ez nem elhanyagolhato. */
  account: string
  /** A felado cime, kisbetusen (normalizeSender). */
  sender: string
  createdAt: string
}

const RULES_PATH = join(PROJECT_ROOT, 'store', 'email-rules.json')

/** Egy megjelolesbol csak a cim, kisbetusen: "Nev <A@B.hu>" -> "a@b.hu". */
export function normalizeSender(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  // A "Nev <cim>" alakbol a csucsos zarojelek kozotti resz a cim.
  const angled = /<([^>]+)>/.exec(s)
  const addr = (angled ? angled[1] : s).trim().toLowerCase()
  // Egy cimnek egy @-ja van; ami nem ilyen, azt nem tekintjuk cimnek --
  // kulonben egy elgepelt vagy hianyos mezo egesz feladokat nemitana el.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return ''
  return addr
}

export interface EnvelopeLike {
  from?: Array<{ name?: string | null; email?: string | null }> | null
}

/** A boritek feladoja, normalizalva. Ures, ha nem allapithato meg. */
export function envelopeSender(env: EnvelopeLike | null | undefined): string {
  return normalizeSender(env?.from?.[0]?.email || '')
}

export function loadRules(): EmailRule[] {
  try {
    if (!existsSync(RULES_PATH)) return []
    const parsed = JSON.parse(readFileSync(RULES_PATH, 'utf-8'))
    const list = Array.isArray(parsed) ? parsed : parsed?.rules
    if (!Array.isArray(list)) return []
    return list.filter(isRule)
  } catch {
    // Serult fajl nem allithatja meg az egesz Email oldalt: szabaly nelkul
    // minden a regi modon mukodik tovabb.
    //
    // De FELRE is tesszuk. A hivasi minta ugyanis `saveRules(addRule(loadRules()
    // ...))`: az ures lista utan a kovetkezo mentes RAIRNA a serult fajlra, es a
    // korabbi szabalyok nyomtalanul eltunnenek. Igy legalabb visszaallithatok.
    // (Ugyanaz a hazi minta, mint az agents.ts `.corrupt-` mentese.)
    try {
      renameSync(RULES_PATH, `${RULES_PATH}.serult-${Date.now()}`)
    } catch { /* ha nem megy, akkor is szabaly nelkul megyunk tovabb */ }
    return []
  }
}

function isRule(x: unknown): x is EmailRule {
  const r = x as EmailRule
  return !!r && (r.kind === 'spam' || r.kind === 'promo')
    && typeof r.account === 'string' && r.account !== ''
    && typeof r.sender === 'string' && r.sender !== ''
}

export function saveRules(rules: EmailRule[]): void {
  mkdirSync(dirname(RULES_PATH), { recursive: true })
  writeFileSync(RULES_PATH, JSON.stringify({ rules }, null, 2))
}

/** Ugyanaz a szabaly ketszer nem kerul be (a Boss ketszer is rahuzhat). */
export function addRule(rules: EmailRule[], kind: EmailRuleKind, account: string, sender: string): EmailRule[] {
  const s = normalizeSender(sender)
  if (!s || !account) return rules
  if (rules.some((r) => r.kind === kind && r.account === account && r.sender === s)) return rules
  return [...rules, { kind, account, sender: s, createdAt: new Date().toISOString() }]
}

export function removeRule(rules: EmailRule[], kind: EmailRuleKind, account: string, sender: string): EmailRule[] {
  const s = normalizeSender(sender)
  return rules.filter((r) => !(r.kind === kind && r.account === account && r.sender === s))
}

/** Egy fiok adott fajta szabalyainak feladoi -- gyors kereseshez. */
export function rulesFor(rules: EmailRule[], kind: EmailRuleKind, account: string): Set<string> {
  return new Set(rules.filter((r) => r.kind === kind && r.account === account).map((r) => r.sender))
}

/** Ervenyes-e ra szabaly? Felado nelkuli boritekra SOSEM. */
export function matchesRule(senders: Set<string>, env: EnvelopeLike): boolean {
  const s = envelopeSender(env)
  return s !== '' && senders.has(s)
}
