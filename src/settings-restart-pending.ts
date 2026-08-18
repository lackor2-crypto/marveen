// "Ujraindítás után lép életbe" as a STATE, not as a permanent label.
//
// Boss, 2026-08-16: "nem akarok latni ilyet hogy sargan oda van barhova is irva
// hogy ujrainditas utan lep eletbe. sokszor ujra lett mar inditva a marvin es
// megis itt vannak ezek a sarga betuk. itt valami bug van."
//
// He is right, and the bug is exactly what he describes. The badge was driven by
// `requiresRestart`, a field of the setting's DEFINITION -- so it was on screen
// forever, on nine keys, no matter what he did. Restarting could never clear it,
// because it never depended on a restart in the first place. A permanent warning
// in warning colours is worse than no warning: it teaches the owner that yellow
// means nothing.
//
// What actually answers the question "is there something pending here?" is a
// comparison: the value THIS process loaded at boot versus the value that is
// effective right now (config-overrides.json > .env > default, resolved live by
// getEffectiveSettingValue). Different -> the running process is working from a
// stale value and a restart is genuinely owed. Same -> nothing to say.
//
// The snapshot must be taken at process start, which is why this module has
// module-level initialisation and is imported from the boot path. Taking it
// lazily on the first request would snapshot values the owner had ALREADY
// changed, and the badge would then never appear -- the opposite bug, and a
// quieter one.

import { SETTINGS_REGISTRY } from './config-registry.js'
import { getEffectiveSettingValue } from './settings-store.js'

export type SettingValue = string | number

/** Keys whose value this process froze at boot (config.ts constants). */
export function restartRelevantKeys(): string[] {
  return SETTINGS_REGISTRY.filter(d => d.requiresRestart).map(d => d.key)
}

/**
 * Read the given keys through `read`, skipping any that throw.
 *
 * Fail-soft on purpose: one unreadable key must not cost the snapshot of the
 * other eight, because a missing snapshot entry silently means "never pending".
 */
export function snapshotValues(
  keys: string[],
  read: (key: string) => SettingValue,
): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const key of keys) {
    try {
      out[key] = read(key)
    } catch {
      // skip
    }
  }
  return out
}

/**
 * Which keys changed since boot, i.e. which ones actually owe a restart.
 *
 * Compared as strings: `.env` yields "1" where an override may yield 1, and a
 * type difference is not a change the owner made. A key missing from either
 * side is NOT reported -- there is no evidence of a change, and inventing one
 * would put the badge back on screen permanently, which is the bug being fixed.
 */
export function computeRestartPending(
  boot: Record<string, SettingValue>,
  current: Record<string, SettingValue>,
): string[] {
  const pending: string[] = []
  for (const [key, bootValue] of Object.entries(boot)) {
    if (!(key in current)) continue
    if (String(bootValue) !== String(current[key])) pending.push(key)
  }
  return pending
}

// Frozen at module load -- see the header for why this cannot be lazy.
const bootValues: Record<string, SettingValue> = snapshotValues(
  restartRelevantKeys(),
  getEffectiveSettingValue,
)

/** The boot snapshot, for tests and diagnostics. */
export function bootSnapshot(): Record<string, SettingValue> {
  return { ...bootValues }
}

/** Keys whose effective value has drifted from what this process is running. */
export function pendingRestartKeys(): string[] {
  return computeRestartPending(
    bootValues,
    snapshotValues(Object.keys(bootValues), getEffectiveSettingValue),
  )
}

export function isRestartPending(key: string): boolean {
  const boot = bootValues[key]
  if (boot === undefined) return false
  try {
    return String(getEffectiveSettingValue(key)) !== String(boot)
  } catch {
    return false
  }
}

// ===========================================================================
// Melyik FOLYAMATNAK szol a beallitas?
//
// A fenti boot-osszehasonlitas pontos -- de csak arra a folyamatra, amelyik ezt
// a kodot futtatja: a vezerlopultra. A kulcsok egy resze viszont NEM ott el:
// a MAIN_AGENT_MODEL-t peldaul a foagens sajat tmux-munkamenete olvassa el
// induláskor. Ott a boot-osszehasonlitas ket iranyban is hazudik:
//
//   - a Boss ujrainditja a foagenst, az mar az UJ modellel indul, a jelveny
//     megis sarga marad (a vezerlopult boot-erteke nem valtozott) -- pontosan
//     az a panasz, ami miatt ez a modul szuletett;
//   - a vezerlopult indul ujra, a jelveny ELTUNIK, kozben a foagens tovabbra
//     is a regi modellel fut. Ez a rosszabbik: elhallgat egy valodi teendot.
//
// Amit tudni lehet: mikor valtozott a beallitas (naplo), es mikor indult a
// cel-munkamenet (tmux session_created). Ha a valtozas KESOBBI, akkor a futo
// folyamat elavult ertekkel dolgozik -- fuggetlenul attol, hany masik dolgot
// inditottak azota ujra.
// ===========================================================================

/**
 * MELYIK tmux-munkamenetek olvassak a kulcsot?
 *
 * Ez nem reszletkerdes. Az elso valtozat egyetlen "legregebbi munkamenet"
 * idot hasznalt MINDEN kulcshoz -- vagyis a foagens modelljehez is beleszamolt
 * egy napok ota futo sub-agens munkamenetet. Eredmeny: a modell atallitasa
 * utan hiaba indul ujra Marvin, a jelveny sarga marad, mert `agent-lagunas`
 * regebbi a valtozasnal. Pontosan az eredeti panasz, uj koentosben.
 *
 * A MAIN_AGENT_* kulcsokat a scripts/channels.sh olvassa a FOAGENS
 * munkamenetenek inditasakor -- a sub-agenseknek semmi kozuk hozzajuk.
 */
export type PendingSessionScope =
  /** Egy tmux-folyamat sem olvassa (tisztan vezerlopult-beallitas). */
  | 'none'
  /** Csak a foagens sajat (channels) munkamenete. */
  | 'main'
  /** Csak a heartbeat sub-agens munkamenete. */
  | 'heartbeat'
  /** A foagens ES minden futo sub-agens. */
  | 'all'

/** Melyik folyamatot erinti a kulcs? */
export interface PendingTargetKind {
  /** A vezerlopult (ez a folyamat) is olvassa. */
  readsDashboard: boolean
  /** Mely tmux-munkamenetek olvassak. */
  sessions: PendingSessionScope
}

export function targetKind(target: string | undefined): PendingTargetKind {
  switch (target) {
    case 'main-agent': return { readsDashboard: false, sessions: 'main' }
    case 'dashboard+agents': return { readsDashboard: true, sessions: 'all' }
    case 'dashboard+heartbeat': return { readsDashboard: true, sessions: 'heartbeat' }
    default: return { readsDashboard: true, sessions: 'none' }
  }
}

export interface PendingFacts {
  /** Kulonbozik-e a vezerlopult bootkori erteke a mostanitol. */
  bootDiffers: boolean
  kind: PendingTargetKind
  /** Mikor valtozott utoljara a kulcs (ms), vagy null, ha nem tudjuk. */
  changedAt: number | null
  /**
   * A legkorabbi indulas azon munkamenetek kozul, amelyeket a `kind.sessions`
   * kijelol (ms) -- vagy null, ha egy sem fut, illetve nem olvashato a tmux.
   * A hivo dolga a helyes halmazt kivalasztani; itt mar csak egy szam van.
   */
  sessionsStartedAt: number | null
  /**
   * Milyen ertekkel indult a cel-munkamenet (naplobol), es mi az ertek MOST.
   * Ha mindketto ismert, ez donti el a kerdest az idobelyegek helyett -- igy
   * az "atallitottam, majd visszaallitottam" eset nem hagy hatra teendot.
   * Hianyozhat: ilyenkor marad a puszta ido-osszehasonlitas.
   */
  valueAtSessionStart?: string | null
  currentValue?: string | number | boolean | null
  /**
   * Amit a futo folyamat TENYLEG hasznal, ha kiolvashato a parancssorabol
   * (ma: a foagens `--model` zaszloja).
   *
   * Ez foldigazsag, es minden idobelyeget felulir. Boss meresi naploja
   * (2026-08-18) mindket ora-alapu hibat elkapta EGY masfel perces ablakban:
   * a jelveny sarga maradt egy sikeres ujrainditas utan (18:24:14), es tiszta
   * volt egy valodi eltereskor (18:23:11). Az ok: Marvin `respawn-pane`-nel
   * indul ujra, a tmux `session_created` tehat SOHA nem lep elore, igy a
   * 3. lepes soha nem tud tisztitani. Egy jobb ora nem javitja meg -- azt
   * kell megkerdezni, ami fut.
   *
   * undefined = nem tudjuk kiolvasni -> a lentebbi ido-alapu jelek dontenek.
   */
  runningValue?: string | null
}

/**
 * Van-e MOST valodi teendo ezzel a kulccsal?
 *
 * Tiszta fuggveny: minden meres (naplo, tmux) kivul tortenik, hogy a dontes
 * maga tesztelheto legyen -- egy ilyen szabalyt "kiprobalni" nem lehet, mert a
 * hibas valasz eppen az, hogy semmi nem tortenik a kepernyon.
 */
export function decideRestartPending(f: PendingFacts): boolean {
  // 1. A vezerlopult sajat, PONTOS jele: amit ez a folyamat bootkor befagyasztott.
  if (f.kind.readsDashboard && f.bootDiffers) return true
  if (f.kind.sessions === 'none') return false
  // 1b. Ha kiolvashato, MIT hasznal a futo folyamat, akkor nincs mit
  //     kovetkeztetni: az a valasz. Se naplo, se tmux-ora nem szol bele.
  if (f.runningValue !== undefined && f.runningValue !== null && f.currentValue !== undefined) {
    return f.runningValue !== String(f.currentValue ?? '')
  }
  // 2. Nem tudjuk megmerni (nincs naplo-bejegyzes, vagy nem olvashato a tmux):
  //    a regi, ertek-alapu jelre esunk vissza. Ez inkabb KIIRJA a jelvenyt,
  //    mint elhallgassa -- egy felesleges emlekezteto olcsobb, mint egy
  //    csendben elavult foagens.
  if (f.changedAt === null || f.sessionsStartedAt === null) return f.bootDiffers
  // 3. A munkamenet minden valtozas UTAN indult: friss ertekkel fut.
  if (f.changedAt <= f.sessionsStartedAt) return false
  // 4. A munkamenet regebbi az utolso valtozasnal. Ez meg nem teendo: szamit,
  //    hogy vegul MAS ertekre jutottunk-e. Atallitas + visszaallitas utan a
  //    futo folyamat erteke helyes, hiaba ket naplo-bejegyzes.
  if (f.valueAtSessionStart !== undefined && f.valueAtSessionStart !== null && f.currentValue !== undefined) {
    return f.valueAtSessionStart !== String(f.currentValue ?? '')
  }
  return true
}
