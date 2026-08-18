// ===========================================================================
// Mi fut MOST a foagens paneljeben?
//
// Boss (2026-08-18), meresi naplo: "na akkor most figyeld mert ujrainditom
// parszor es kivalasztok mas agentekek. te meg figyeld mi tortenik". Amit a
// meres mutatott, ket egymas utani mintaban:
//
//   18:24:10  Marvin_fut=claude-opus-5        beallitva=claude-opus-4-8[1m]  jelveny=SARGA
//   18:24:14  Marvin_fut=claude-opus-4-8[1m]  beallitva=claude-opus-4-8[1m]  jelveny=SARGA
//
// A masodik sor a hiba: az ujrainditas MEGTORTENT, a futo modell mar EGYEZIK,
// a jelveny megis sarga maradt. Az ok a sor vegen latszott: a tmux
// `session_created` mindket mintaban ugyanaz (15:29:59). Marvin ujrainditasa
// `tmux respawn-pane` -- UGYANABBAN a munkamenetben indul uj folyamat --, ezert
// a munkamenet letrejottenek ideje SOHA nem lep elore. Igy a
// `changedAt <= sessionsStartedAt` feltetel soha nem teljesulhet, es a jelveny
// akarhany ujrainditas utan sargan marad.
//
// A forditottja is bent volt ugyanabban a naploban (18:23:11): a panel
// `claude-opus-5`-ot futtatott, a beallitas `claude-sonnet-5` volt, a jelveny
// megis TISZTA -- vagyis elhallgatott egy valodi teendot. Ez a rosszabbik hiba.
//
// A megoldas nem egy jobb ora, hanem az, hogy nem is orat kerdezunk: a panel
// parancssoraban OTT ALL, melyik modellel indult a folyamat. Ez foldigazsag --
// nem kell hozza sem naplo, sem idobelyeg, es nem tud elavulni.
//
// A sub-agensekre ez a modul nem vonatkozik: azok `kill-session` +
// `new-session` parral indulnak ujra, ott a `session_created` valoban elorelep.
// ===========================================================================

import { execFileSync } from 'node:child_process'
import { exactTmuxTarget } from './tmux-target.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

const TMUX = 'tmux'

export interface MainAgentRuntime {
  /** A panelben futo claude folyamat pid-je, vagy null, ha nem talalhato. */
  pid: number | null
  /**
   * Mikor indult ez a folyamat (ms). Ez az az idopont, amihez a beallitas-
   * valtozasokat merni kell -- NEM a munkamenet letrejotte.
   */
  startedAtMs: number | null
  /**
   * Melyik modellel indult (`--model` a parancssorban), vagy null, ha nincs
   * ott. A null itt "nem tudjuk"-et jelent, nem "nincs modell": ha a
   * channels.sh nem tudta feloldani a modellt, a zaszlo egyszeruen kimarad, es
   * a claude a sajat beallitasait hasznalja.
   */
  model: string | null
}

const UNKNOWN: MainAgentRuntime = { pid: null, startedAtMs: null, model: null }

function ps(pid: number, field: string): string | null {
  try {
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', field],
      { timeout: 2000, encoding: 'utf-8' })
    return out.trim() || null
  } catch { return null }
}

/**
 * A panelben futo claude pid-je.
 *
 * Ket alak fordul elo ezen a gepen (a #938 meres szerint): a panel MAGA a
 * claude (foagens, sub-agensek), vagy a panel egy shell, es a claude a gyereke
 * (worker-munkamenetek). A foagens az elso alak, de a gyerek-keresest is
 * elvegezzuk -- egy felteves itt nem hibauzenetet ad, hanem csendben a BASH
 * parancssorat olvasna, amiben nincs `--model`, es akkor visszaesnenk a hibas
 * ora-osszehasonlitasra.
 */
function findClaudePid(session: string): number | null {
  let panePid: number | null = null
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf-8' })
    const p = parseInt(raw.split('\n')[0]?.trim() ?? '', 10)
    panePid = Number.isFinite(p) && p > 0 ? p : null
  } catch { return null }
  if (panePid === null) return null

  if (ps(panePid, 'comm=') === 'claude') return panePid

  // A panel nem claude: a KOZVETLEN gyerekei kozott keressuk.
  let kids: number[] = []
  try {
    const out = execFileSync('/bin/ps', ['--ppid', String(panePid), '-o', 'pid='],
      { timeout: 3000, encoding: 'utf-8' })
    kids = out.split('\n').map(l => parseInt(l.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
  } catch { kids = [] }
  for (const kid of kids) {
    if (ps(kid, 'comm=') === 'claude') return kid
  }
  return null
}

/**
 * Kiolvassa a `--model X` erteket egy parancssorbol.
 *
 * A modellnevben szogletes zarojel is lehet (`claude-opus-4-8[1m]`), ezert a
 * kovetkezo szokozig olvasunk, es nem probalunk "ervenyes modellnev" mintat
 * illeszteni: a mi dolgunk az, ami OTT ALL, nem az, aminek ott kellene lennie.
 * Exportalva a tesztekhez.
 */
export function extractModelFlag(args: string): string | null {
  const m = args.match(/--model[= ]+("[^"]*"|'[^']*'|\S+)/)
  if (!m) return null
  const raw = m[1] ?? ''
  const unq = raw.replace(/^["']|["']$/g, '')
  return unq || null
}

/**
 * Mit futtat MOST a foagens. Minden mezo kulon lehet null: a hivo ilyenkor a
 * korabbi, ido-alapu jelre esik vissza, nem pedig hamis biztonsagot allit.
 */
export function readMainAgentRuntime(session: string = MAIN_CHANNELS_SESSION): MainAgentRuntime {
  const pid = findClaudePid(session)
  if (pid === null) return UNKNOWN

  let startedAtMs: number | null = null
  const etimes = ps(pid, 'etimes=')
  if (etimes !== null) {
    const secs = parseInt(etimes, 10)
    // A `ps etimes` masodperc-felbontasu: a folyamat indulasat egy masodperccel
    // KESOBBRE tesszuk (kerekitve lefele a kort), hogy egy ugyanabban a
    // masodpercben tortent beallitas-valtozas ne szamitson "ujraindulas
    // utaninak". Egy masodperc tevedes ebbe az iranyba a jelvenyt kiirja, a
    // masik iranyba elhallgatja.
    if (Number.isFinite(secs) && secs >= 0) startedAtMs = Date.now() - secs * 1000
  }

  const args = ps(pid, 'args=')
  const model = args ? extractModelFlag(args) : null

  return { pid, startedAtMs, model }
}
