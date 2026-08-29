// KI VAN EBBEN A SLOTBAN? -- nevesitett Claude-fiokok azonossag-orzese.
//
// Boss, 2026-08-29: "hogy lehet ezt igy csinalni? ne legyen ugyanabba a fiokba
// bejelentkezve. hat hiszen a lackor3 az egy kulon email klon fiokkal... mit
// keres az az usalackorban? ez igy nagyon gaz."
//
// MI TORTENT. Egy nevesitett fiok ("plan") eddig csak egy CIMKE volt egy
// config-konyvtar folott. Hogy melyik Anthropic-fiok LAKIK benne, azt sehol nem
// rogzitettuk -- a `claude-plans.json` semaja evek ota tartalmazza az
// `expectedEmail` mezot, de EGYETLEN sor kod nem hasznalta. A bejelentkezes
// bongeszoben tortenik, es a bongeszo azt a fiokot hagyja jova, amelyik EPPEN
// be van benne jelentkezve. Ha az nem az, amit ehhez a slothoz szantunk, semmi
// nem szolt: ket kulon nevu elofizetes csendben ugyanarra a fiokra mutatott, es
// ketten ettek ugyanannak az egy fioknak a keretet -- kozben a masik hasznalatlanul
// allt.
//
// A NULLA/CSEND ITT IS KET DOLOG. Ha egy fiokot meg nem tudtunk megkerdezni, az
// NEM "rendben van": kulon allapota van ('blind'). Egy hamis zold sor rosszabb a
// hianyzo sornal.
//
// Ez a modul tisztan szamol: be, ki, mit allapitunk meg. I/O nincs benne, hogy
// egysegtesztelheto legyen -- a bekotes a claude-auth-runner.ts-ben es a
// system-health.ts-ben lakik.

/** Egy fiok-slot allapota a meres pillanataban. */
export interface IdentitySlot {
  /** A plan azonositoja; `null` a gep sajat (~/.claude) bejelentkezese. */
  id: string | null
  /** Emberi nev a felulethez. */
  label: string
  /** A CLI valasza szerinti cim, vagy null. */
  email: string | null
  /** A CLI szerint be van-e jelentkezve. */
  loggedIn: boolean
  /** Sikerult-e egyaltalan megkerdezni. `false` = nem latok oda. */
  probeOk: boolean
  /** A slothoz rogzitett cim (claude-plans.json `expectedEmail`), ha van. */
  expectedEmail?: string | null
}

export type SlotVerdict =
  /** Nem tudtam megkerdezni -- errol a slotrol semmit nem allitok. */
  | { kind: 'blind' }
  /** Ki van jelentkezve: nincs mit osszehasonlitani (a piros savot mas adja). */
  | { kind: 'signed_out' }
  /** Be van jelentkezve, de nincs rogzitve, KINEK kellene lennie. */
  | { kind: 'unpinned'; actual: string }
  /** Be van jelentkezve, es NEM az van benne, akit ide rogzitettunk. */
  | { kind: 'drift'; expected: string; actual: string }
  /** Be van jelentkezve, es pontosan az, akit ide rogzitettunk. */
  | { kind: 'ok'; actual: string }

/** Ket vagy tobb slot ugyanazzal a cimmel. */
export interface IdentityCollision {
  email: string
  /** A plan-azonositok; a gep sajat fiokja `null`-kent szerepel. */
  ids: Array<string | null>
  labels: string[]
}

export interface IdentityAudit {
  /** Slotonkenti itelet; a kulcs a plan id, a gep sajat fiokjae `''`. */
  bySlot: Record<string, SlotVerdict>
  /** Cimenkent csoportositva, ahol egynel tobb slot ul ugyanazon a fiokon. */
  collisions: IdentityCollision[]
  /** Hany slotrol nem tudtunk semmit. Nem nulla = az utkozes-lista HIANYOS. */
  blind: number
}

/** Cimek osszehasonlitasa: a kis/nagybetu es a kornyezo szokoz nem szamit.
 *  Tobbet szandekosan nem normalizalunk (pl. a Gmail pont-trukkjet nem):
 *  talalgatni, hogy ket kulonbozo cim "ugyanaz-e", rosszabb a semminel. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return v.length > 0 ? v : null
}

function verdictFor(slot: IdentitySlot): SlotVerdict {
  if (!slot.probeOk) return { kind: 'blind' }
  const actual = normalizeEmail(slot.email)
  if (!slot.loggedIn || !actual) return { kind: 'signed_out' }
  const expected = normalizeEmail(slot.expectedEmail)
  if (!expected) return { kind: 'unpinned', actual }
  if (expected !== actual) return { kind: 'drift', expected, actual }
  return { kind: 'ok', actual }
}

/**
 * Az osszes slot atvizsgalasa egyben.
 *
 * Az utkozes-keresesbe a gep sajat fiokja IS beleszamit: ha egy nevesitett
 * elofizetes a gep alap-fiokjara csuszik at, az ugyanaz a hiba.
 */
export function auditIdentities(slots: IdentitySlot[]): IdentityAudit {
  const bySlot: Record<string, SlotVerdict> = {}
  const byEmail = new Map<string, IdentitySlot[]>()
  let blind = 0

  for (const slot of slots) {
    const v = verdictFor(slot)
    bySlot[slot.id ?? ''] = v
    if (v.kind === 'blind') { blind++; continue }
    if (v.kind === 'signed_out') continue
    const email = v.kind === 'drift' || v.kind === 'ok' || v.kind === 'unpinned' ? v.actual : null
    if (!email) continue
    const list = byEmail.get(email) || []
    list.push(slot)
    byEmail.set(email, list)
  }

  const collisions: IdentityCollision[] = []
  for (const [email, list] of byEmail) {
    if (list.length < 2) continue
    collisions.push({
      email,
      ids: list.map(s => s.id),
      labels: list.map(s => s.label || s.id || ''),
    })
  }
  // Determinisztikus sorrend, hogy a felulet ne ugraljon ket lekerdezes kozott.
  collisions.sort((a, b) => a.email.localeCompare(b.email))

  return { bySlot, collisions, blind }
}

/** Igaz, ha van barmi, amirol a felhasznalonak SZOLNI kell (piros sor). */
export function hasIdentityProblem(audit: IdentityAudit): boolean {
  if (audit.collisions.length > 0) return true
  return Object.values(audit.bySlot).some(v => v.kind === 'drift')
}

/**
 * Mi tortenjen egy MOST befejezodott bejelentkezes utan.
 *
 * - `pin`: ehhez a slothoz meg nem tartozott cim -> rogzitsuk ezt. Igy friss
 *   telepitesen az ELSO bejelentkezes hatarozza meg, ki lakik a slotban, es
 *   minden kesobbi ehhez merodik. Nem kell hozza semmit kezzel beallitani.
 * - `drift`: mas cim jott be, mint ami rogzitve van -> NEM irjuk felul csendben,
 *   hanem megmondjuk a felhasznalonak, es o dont.
 * - `ok` / `unknown`: nincs teendo (az utobbi: nem tudtuk leolvasni a cimet).
 */
export type PostLoginAction =
  | { kind: 'pin'; email: string }
  | { kind: 'drift'; expected: string; actual: string }
  | { kind: 'ok'; email: string }
  | { kind: 'unknown' }

export function decidePostLogin(
  expectedEmail: string | null | undefined,
  actualEmail: string | null | undefined,
): PostLoginAction {
  const actual = normalizeEmail(actualEmail)
  if (!actual) return { kind: 'unknown' }
  const expected = normalizeEmail(expectedEmail)
  if (!expected) return { kind: 'pin', email: actual }
  if (expected !== actual) return { kind: 'drift', expected, actual }
  return { kind: 'ok', email: actual }
}
