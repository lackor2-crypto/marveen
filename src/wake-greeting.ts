// Kanban #202 (231cb999): a felebredeskori koszones FELTETELES.
//
// A #106 (1aad386f) szabalya szerint minden ebredes elso mondata egy rovid
// koszones a tulajdonos sajat csatornajan. A szabaly egy dolgot nem tudott
// megmerni: hogy a TULAJDONOS szamara volt-e egyaltalan szunet. 2026-09-02
// 01:21-kor ket uzenetet kuldott ("kesz. jovahagytam..." es egy "?"), es a
// valasz elott lefutott egy SessionStart hook -- amitol a szabaly szerint
// kotelezo volt koszonessel kezdeni, holott az o szemszogebol a beszelgetes egy
// pillanatra sem szakadt meg. Kivulrol ez zaj: a koszones eletjel, es ahol
// nincs mitol felni, ott nem informacio.
//
// A dontesi jel a beszelgetes-ledger (conversation_log, lasd getConversationEdge
// a src/db.ts-ben): van-e a tulajdonostol olyan uzenet, ami MAR VALASZ NELKUL
// maradt, es MIOTA.
//   regota valasz nelkul  -> 'kieses'     -> koszonj (ez az eletjel)
//   epp most irt          -> 'folyamatos' -> NE koszonj, csak valaszolj
//   nincs valaszra varo   -> 'csend'      -> a #106 valtozatlan (koszonj)
//   nem mertem            -> 'nem_tudom'  -> a #106 valtozatlan (koszonj)
//
// "A nulla ket dolgot jelenthet": egy URES ledger NEM azt jelenti, hogy nem volt
// kieses -- azt jelenti, hogy nem latok oda. (A ledger-hookok ma csak a fo agens
// sessionjeire vannak bekotve, es friss telepitesen amugy sincs egyetlen sor
// sem.) Ezert a nem-mert eset SOSE nemit el egy koszonest: a kimaradt eletjel a
// sulyosabb hiba, es friss telepitesen a viselkedes valtozatlan marad.

/** A ledger ket szelso pontja egy agensre. Minden idobelyeg epoch MILLIszekundum
 *  (a conversation_log masodpercet tarol -- a valtas a db.ts olvasoban tortenik,
 *  hogy ez a modul egyetlen mertekegyseggel dolgozzon). */
export interface ConversationEdge {
  /** A tulajdonos utolso uzenete (direction='in'), vagy null ha nincs ilyen sor. */
  lastInboundAt: number | null
  /**
   * A LEGREGEBBI meg valasz nelkul allo tulajdonos-uzenet ideje, vagy null.
   *
   * EZ a varakozas hossza, nem a `lastInboundAt`. A ketto akkor valik el, amikor
   * a tulajdonos a kieses alatt TOBBSZOR is irt: ha 5 orayal ezelott kerdezett,
   * es a valasz elmaradasa miatt 2 perce ujra irt ("?"), akkor a legfrissebb sor
   * 2 percet mutat -- es a kod "folyamatos"-nak latna azt az 5 orat, amit a
   * tulajdonos vegigvart. Pont ott maradna el az eletjel, ahol a legtobbet er.
   *
   * Opcionalis, hogy a regi hivok (es a tesztek) ne toerjenek el: ha hianyzik,
   * a `lastInboundAt` a tartalek -- az a #202 elso valtozatanak viselkedese.
   */
  oldestUnansweredAt?: number | null
  /** Kapott-e mar a LEGUTOLSO bejovo uzenet kesobbi kimeno valaszt. Ugyanaz a
   *  feltetel, amit a ledger_lib.open_question() hasznal (azonos masodpercnel
   *  az id dont), hogy a ket oldal ne mondhasson mast ugyanarrol az allapotrol. */
  answered: boolean
  /** Hany bejovo sor van EGYALTALAN ehhez az agenshez. A nulla itt a "nem latok
   *  oda" jelzese: bejovo naplo nelkul a "nincs valaszra varo uzenet" nem allitas,
   *  csak a merohiany. */
  inboundRows: number
  /** Sikerult-e egyaltalan olvasni a ledgert. false = DB-hiba, NEM ures naplo. */
  readable: boolean
}

export type WakeGreetingVerdict = 'kieses' | 'folyamatos' | 'csend' | 'nem_tudom'

export interface WakeGreetingDecision {
  verdict: WakeGreetingVerdict
  /** A vegso kerdes: kimenjen-e a koszones. Ez az egyetlen, amit a hivo hasznal. */
  greet: boolean
  /** Mennyi ideje var a tulajdonos utolso uzenete valasz nelkul; null, ha nincs ilyen. */
  waitedMs: number | null
  /** Rovid, gepi ok -- naplohoz es teszthez, nem kepernyore. */
  reason: string
}

/** Ennel regebb ota valasz nelkul allo tulajdonos-uzenet mar VALODI kieses: a
 *  tulajdonos vart, tehat a koszones eletjel es nem zaj. Ennel frissebbnel a
 *  session-inditas az o szemszogebol eszrevehetetlen volt (tomorites, restart),
 *  ott a koszones csak megszakitja a sajat beszelgeteset.
 *
 *  A 30 perc a panaszolt esetbol jon: a tulajdonos ott mar egy "?"-t is kuldott
 *  (tehat perceket vart), es MEGIS folyamatosnak elte meg -- par perces kuszob
 *  ezert nem oldana meg a problemat. */
export const GREETING_OUTAGE_AFTER_MS = 30 * 60_000

/** Csendes csatorna (nincs valaszra varo uzenet): koszonjon-e. Alapertelmezesben
 *  IGEN -- ez a #106 eredeti esete (keret-reset utani ebredes hajnalban, amikor
 *  semmi nem var valaszra, es a tulajdonos EPP a csatornan meri, hogy elunk-e).
 *  A #202 csak az AKTIV beszelgetes kozbeni koszonest nemiti el. */
export const GREET_ON_QUIET_CHANNEL = true

export interface WakeGreetingOptions {
  thresholdMs?: number
  greetOnQuiet?: boolean
}

/**
 * Kell-e koszonni ennel az ebredesnel. Tiszta fuggveny: se ora, se DB, se fajl --
 * a `nowMs` es az `edge` a teljes bemenet.
 */
export function decideWakeGreeting(
  edge: ConversationEdge,
  nowMs: number,
  opts: WakeGreetingOptions = {},
): WakeGreetingDecision {
  const threshold = opts.thresholdMs ?? GREETING_OUTAGE_AFTER_MS
  const greetOnQuiet = opts.greetOnQuiet ?? GREET_ON_QUIET_CHANNEL
  const unknown = (reason: string): WakeGreetingDecision => ({
    verdict: 'nem_tudom', greet: true, waitedMs: null, reason,
  })

  // 1. Nem lattam oda. Ez NEM csend, es sosem nemithat el egy eletjelet.
  if (!edge.readable) return unknown('ledger-olvashatatlan')

  // 2. Nincs egyetlen bejovo sor sem: friss telepites, vagy ennel az agensnel
  //    nincs bekotve a ledger-capture hook. Megint csak merohiany, nem allitas.
  if (edge.inboundRows <= 0 || edge.lastInboundAt === null) return unknown('nincs-bejovo-naplo')

  // 3. Jovobeli idobelyeg = elallitott ora. Ugyanaz a kezeles, mint a
  //    limit-wake looksLikeRealOutage-eben: nem talalgatunk, a biztonsagos ag megy.
  if (edge.lastInboundAt > nowMs) return unknown('ora-elorement')

  // 4. Van-e valaszra varo uzenet egyaltalan.
  if (edge.answered) {
    return {
      verdict: 'csend',
      greet: greetOnQuiet,
      waitedMs: null,
      reason: 'nincs-valaszra-varo-uzenet',
    }
  }

  // 5. Van valaszra varo uzenet: a KORA donti el, eszlelte-e a tulajdonos a szunetet.
  //    A LEGREGEBBI valaszra varo sortol merunk (lasd `oldestUnansweredAt`): a
  //    varakozas akkor kezdodott, amikor eloszor irt, nem amikor utoljara.
  const openedAt = edge.oldestUnansweredAt ?? edge.lastInboundAt
  // Egy jovobeli (elallitott ora) vagy a legutolso bejovonal KESOBBI nyito
  // idobelyeg ellentmondas -- ott sem talalgatunk (lasd a 3. pontot).
  if (openedAt > nowMs) return unknown('ora-elorement')
  const waitedMs = nowMs - openedAt
  return waitedMs >= threshold
    ? { verdict: 'kieses', greet: true, waitedMs, reason: 'valasz-nelkul-a-kuszob-felett' }
    : { verdict: 'folyamatos', greet: false, waitedMs, reason: 'valasz-nelkul-de-friss' }
}

function perc(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000))
}

/**
 * A SessionStart-kor injektalando szoveg, vagy null.
 *
 * SZANDEKOSAN csak akkor beszel, amikor MERT allitasa van: a 'csend' es a
 * 'nem_tudom' eseten a CLAUDE.md allando szabalya (#106) amugy is koszonest ir
 * elo, tehat egy plusz bekezdes ott csak kontextust enne. A 'kieses' azert kap
 * sort, mert a varakozas hosszat egyedul ez tudja megmondani.
 */
export function buildWakeGreetingContext(d: WakeGreetingDecision): string | null {
  if (d.verdict === 'folyamatos') {
    return [
      '=== EBREDES-KOSZONES: NE koszonj (kanban #202) ===',
      `Merve a beszelgetes-naplobol: a tulajdonos utolso uzenete ${perc(d.waitedMs ?? 0)} perce erkezett, es meg `
        + 'nem kapott ra valaszt. Az o szemszogebol a beszelgetes FOLYAMATOS -- ez a session-inditas technikai '
        + '(tomorites, folyamat-restart), nem eszlelt kieses.',
      'Ezert NE kezdd "Szia, itt vagyok, felebredtem"-mel: egyszeruen folytasd, illetve add meg a valaszt. '
        + 'A koszones eletjel egy VALODI kieses utan; ahol nem volt szunet, ott csak megszakitja a beszelgetest.',
    ].join('\n\n')
  }
  if (d.verdict === 'kieses') {
    return [
      '=== EBREDES-KOSZONES: koszonj eloszor (kanban #202 / #106) ===',
      `Merve a beszelgetes-naplobol: a tulajdonos utolso uzenete ${perc(d.waitedMs ?? 0)} perce var valasz nelkul. `
        + 'Az o szemszogebol ez VALODI kieses volt.',
      'Az elso mondatod ezert egy rovid koszones a sajat csatornadon ("Szia, itt vagyok, felebredtem"), es CSAK '
        + 'utana a munka, illetve a valasz.',
    ].join('\n\n')
  }
  return null
}

/**
 * A SessionStart additionalContext osszefuzese. A koszones-dontes elore kerul:
 * az a legelso lepesrol szol, a fuggo munka pedig a masodikrol. Ha egyik sincs,
 * null -- a hook ilyenkor hallgat (nem injektal ures blokkot).
 */
export function composeSessionStartContext(
  greeting: string | null,
  pending: string | null,
): string | null {
  const parts = [greeting, pending].filter((s): s is string => !!s && s.trim() !== '')
  return parts.length ? parts.join('\n\n') : null
}
