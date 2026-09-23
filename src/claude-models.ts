/**
 * A CLAUDE-MODELLEK EGYETLEN FORRASA.
 *
 * Boss, 2026-09-23 (Telegram 1196): "Miert nincs es miert nem frissul, pedig a
 * Cloud mar kiadta az Opus 5.5-ot. Itt latszania kellene, tehat ez egy bug, nem
 * frissiti a listat."
 *
 * Igaza volt, ketszeresen is. A lista OT kulon helyen allt kezzel beirva
 * (`/api/models/available`, ket legordulo a `web/index.html`-ben, a Kod-hid
 * legorduloje, es harom `valueSet` a `config-registry.ts`-ben), es semmi nem
 * frissitette egyiket sem. Az OpenRouter-katalogusnak van heti frissitese; a
 * Claude-nak nulla volt.
 *
 * Az ot lista MAR MA IS ellentmondott egymasnak: a Kod-hid legorduloje ismerte
 * a `claude-fable-5-1`-et, a masik negy nem; a `config-registry` harom
 * listajabol hianyzott a `claude-sonnet-4-6`. A kezi szinkron nem "elromlott" --
 * strukturalisan nem tud mukodni, es a kodban ott is allt rola a sajat
 * figyelmeztetesunk ("keep it in sync ... does not silently offer a stale set").
 *
 * Ezert ez a modul EGYETLEN forras. Aki Claude-modellt kinal a felhasznalonak,
 * innen olvassa -- a szetcsuszas igy nem "tilos", hanem lehetetlen.
 *
 * A LISTA GONDOZOTT, NEM GEPI. A cimke es a sorrend embertol jon, mert a gepi
 * kigyujtes a telepitett programbol a Haiku 3.5-ig minden regi modellt
 * felhozna. Ami gepi: a `claude-model-discovery` eszreveszi, ha a telepitett
 * Claude program olyan UJABB modellt ismer, ami innen hianyzik -- es azt kulon
 * csoportban fel is kinalja. Igy a lista gondozott marad, de nem tud csendben
 * lemaradni.
 */

export type ClaudeFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

export interface ClaudeModel {
  /** Amit a `--model` kap. Az `[1m]` toldalek az 1M kontextusu valtozat. */
  id: string
  /** A modell sajat neve, ahogy a gyarto hivja (nem forditando). */
  name: string
  family: ClaudeFamily
  /** A cimke zarojeles resze -- KETNYELVU, mert kepernyore kerul. */
  hu: string
  en: string
}

/**
 * A felkinalt modellek, KEPESSEG szerint csokkeno sorrendben.
 *
 * A sorrendet a gyarto sajat leirasa adja, amit a telepitett program szovegebol
 * olvastunk ki (2026-09-23, CLI 2.1.280), nem a sajat tippunk:
 *   - "Fable 5.1 - most capable for your hardest and longest-running tasks"
 *   - "Opus 5.5 - best for everyday, complex tasks"
 *   - "Haiku 4.5 - fastest for quick answers. Lower cost but less capable..."
 */
export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', family: 'fable',
    hu: 'a legerősebb, a leghosszabb feladatokra', en: 'most capable, for the longest tasks' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', family: 'opus',
    hu: 'legújabb Opus', en: 'latest Opus' },
  { id: 'claude-opus-5-5[1m]', name: 'Opus 5.5', family: 'opus',
    hu: '1M kontextus, hosszú munkamenetekhez', en: '1M context, for long sessions' },
  { id: 'claude-fable-5', name: 'Fable 5', family: 'fable',
    hu: 'előző Fable', en: 'previous Fable' },
  { id: 'claude-opus-5', name: 'Opus 5', family: 'opus',
    hu: 'előző Opus', en: 'previous Opus' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', family: 'sonnet',
    hu: 'legújabb Sonnet, Opus-közeli', en: 'latest Sonnet, close to Opus' },
  { id: 'claude-opus-4-8[1m]', name: 'Opus 4.8', family: 'opus',
    hu: '1M kontextus', en: '1M context' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', family: 'sonnet',
    hu: 'gyors és okos', en: 'fast and smart' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', family: 'haiku',
    hu: 'leggyorsabb', en: 'fastest' },
]

export const CLAUDE_MODEL_IDS: string[] = CLAUDE_MODELS.map((m) => m.id)

/** Ismeri-e a gondozott lista ezt az azonositot? */
export function isKnownClaudeModel(id: string): boolean {
  return CLAUDE_MODEL_IDS.includes(String(id || ''))
}

/** `Opus 5.5 (legújabb Opus)` -- a felulet nyelven. */
export function claudeModelLabel(m: ClaudeModel, lang: string = 'hu'): string {
  const zarojel = lang === 'en' ? m.en : m.hu
  return zarojel ? `${m.name} (${zarojel})` : m.name
}

/**
 * Egy azonosito verzio-kulcsa: `claude-opus-5-5[1m]` -> { family, major, minor }.
 *
 * A datumos valtozat (`claude-haiku-4-5-20251001`) utolso tagja NEM alverzio,
 * ezert a nyolcjegyu szamot eldobjuk -- kulonben a Haiku 4.5 "4.20251001"-kent
 * minden masnal ujabbnak latszana.
 */
export function parseClaudeModelId(
  id: string,
): { family: ClaudeFamily; major: number; minor: number } | null {
  const m = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(String(id || '').toLowerCase())
  if (!m) return null
  const minorNyers = m[3] ? Number(m[3]) : 0
  // 8 jegyu = datum-belyeg, nem alverzio.
  const minor = m[3] && m[3].length >= 7 ? 0 : minorNyers
  return { family: m[1] as ClaudeFamily, major: Number(m[2]) || 0, minor }
}

/** Osszehasonlithato szam a verziobol (nagyobb = ujabb), csaladon BELUL. */
export function claudeVersionRank(id: string): number {
  const v = parseClaudeModelId(id)
  if (!v) return -1
  return v.major * 1000 + Math.min(v.minor, 999)
}

/** A gondozott lista legujabb verzioja az adott csaladban (-1, ha nincs ilyen). */
export function newestKnownInFamily(family: ClaudeFamily): number {
  let max = -1
  for (const m of CLAUDE_MODELS) {
    if (m.family !== family) continue
    const r = claudeVersionRank(m.id)
    if (r > max) max = r
  }
  return max
}

/** A legordulokbe valo `{ id, label }` parok, a felulet nyelven. */
export function claudeModelOptions(lang: string = 'hu'): { id: string; label: string }[] {
  return CLAUDE_MODELS.map((m) => ({ id: m.id, label: claudeModelLabel(m, lang) }))
}
