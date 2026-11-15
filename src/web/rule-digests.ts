// Startup-context diet (#799). Every generated rule block in CLAUDE.md used to
// carry its FULL text, ~100k tokens of start for the whole fleet. Now the
// CLAUDE.md block holds a short digest (the binding core of the rule) and the
// full text is written, unchanged, to ~/.claude/rule-details/<key>.md, where any
// agent can read it on demand. Nothing is lost: the full body is still produced
// by the same build*Body() function, this module only decides what goes where.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

/** Directory holding the full text of every digested rule. */
export function ruleDetailsDir(): string {
  return join(homedir(), '.claude', 'rule-details')
}

/** Digest text per rule key (the marker name without the "-rule" decoration is
 *  NOT used: the key is exactly what ruleBody() is called with). The heading of
 *  the full body (its first line) is kept above the digest automatically. */
export const RULE_DIGESTS: Record<string, string> = {
  'ask-back': 'Ha egy utasitasnak egynel tobb ertelme van, KOTELEZO visszakerdezni, akkor is, ha erted. Mindig kerdezz: torles, kifele meno uzenet valodi cimzettnek, jelszo/jogosultsag, penzmozgas, tomeges muvelet, eles szolgaltatas leallitasa; es ha a halmazt neked kell megallapitanod ("mind"), nincs megnevezve MIN, vagy a mondatnak ket olvasata van. Egy uzenetben az OSSZES nyitott kerdes, A/B valasztassal; rutin dontest (fajlnev, sorrend) ne kerdezz.',
  'wake-greeting': 'Felebredeskor (keret-visszaallas, ujrainditas) az ELSO mondat egy rovid koszones a tulajdonos csatornajan: "Szia, itt vagyok, felebredtem." Kiveve ha a start "EBREDES-KOSZONES: NE koszonj" sort kap. Kieseskor hallgatsz.',
  'recheck': 'Egy tenyt masodszor kimondani elott ujra le kell merni (allapot, datum, verzio/commit, fajl, jelszo/token, darabszam, "meg fennall-e"). A sajat korabbi valaszod es az emlekezet nem forras. Ha nem tudod ujramerni, mondd meg mikori adatbol beszelsz; ha az ujrameres mast mutat, a friss adat nyer.',
  'delegate-check': 'Munka atadasa elott ELSO lepes: elo forrasbol ellenorizni, hogy a cimzett tud-e dolgozni (fut, be van jelentkezve, nincs kimerult keretnel). Ha nem: van-e harmadik elerheto agens; ha nincs, magad vegzed el. Sose emlekezetbol.',
  'agent-identity': 'Ha meg kell mondanod, KI irt vagy csinalt valamit: ellenorizheto forrast nezz (csatorna/bot, worktree/branch nev, approval agent_id, komment szerzoje), ne talalgass temabol. A sajat korabbi kontextus a SAJAT munkad; modellvaltas nem valtoztat azon, melyik agens vagy. Ha nincs forras, mondd meg.',
  'no-live-tree': 'Az elo checkoutban (a fo PROJECT_ROOT) nem szerkesztesz, nem commitolsz, nem valtasz branchet, es SEMMIT nem torolsz/mozgatsz/csonkitasz. Minden munka izolalt worktree-ben (scripts/agent-worktree.sh <nev>), landolas scripts/land-pr.sh-val, kikerules scripts/deploy-live.sh-val. Torles csak worktree-ben, ABSZOLUT uttal; ideiglenes fajl /tmp vagy a session scratch.',
  'completion-report': 'Rad bizott feladat vegen KOTELEZO egy rovid, EGY soros kesz-uzenet a tulajdonos sajat csatornajan: mi lett kesz + ellenorizheto azonosito (commit/PR/#kartya). Heartbeatre es belso karbantartasra nem vonatkozik.',
  'kanban-waiting-move': 'Kartyat a waiting oszlopbol kimozgatni (barmi korabbi oszlopba) CSAK KULON, konkret kerdes utan a tulajdonosnak ES a valasz megvarasa utan; a munkautasitas ("csinald meg") nem engedely. A munkat a kartya mozgatasa NELKUL is el lehet vegezni (komment + worktree). Elore mozgatas (in_progress -> waiting) rutin.',
  'card-reference': 'Kanban kartyara mindig a SORSZAMAVAL hivatkozz (#369, az API seq mezoje); a 8 karakteres belso id csak zarojelben, a sorszam UTAN: #369 (27410f1b).',
  'no-stray-files': 'Onmagatol ne keletkezzen fajl. Ideiglenes fajl /tmp vagy session scratch, sose a projektfaba. Amit fejleszteshez letrehoztal, a vegen torold; a munkaegyseg vegen git status tiszta. Lezaras: hatasvizsgalat + bugkereses, azonnal commit ES push, chat-naplo bejegyzes. Nem sajat fajl torlese elott kerdezz vagy mozgasd /tmp ala.',
  'landing': 'main-re DIREKT PUSH TILOS. Landolas sajat worktree-bol: scripts/land-pr.sh "cim" (PR, CI zold, merge; a MERGE-ELVE sor a bizonyitek). Piros CI-t javitsd, ne kerüld meg. Landolas utan a munka nem kesz, amig a deploy nem fut: store/.deployed-sha == origin/main, vagy a store/deploy.log utolso sora DEPLOYED; kulonben scripts/deploy-live.sh (mas agenst nem akadalyozol; REFUSING-et jelentesz, nem tisztitasz).',
  'one-card-one-fix': 'Egy hiba = egy kartya, azonnal es teljesen keszre; hibat kartyabol masik ala athelyezni tilos; uj hiba a javitas kozben azonnal javitando; a waiting nem felmentes a befejezes alol. Egy projekt = egy kartya, amig nincs waitingben (komment/alfeladat). Az elso ellenorzes utan a waiting kartya zarolt: uj munka uj kartya, a leirasa #N-nel hivatkozik a regire.',
  'availability': 'Masik agens elerhetosegerol/kereterol elo allapotot nezz (GET /api/agents/availability), regi meres nem forras. Ha elerhetove valt es van varakozo munka, azonnal add ki neki.',
  'short-reply': 'Rovid valasz ("A", "B", "igen", "nem", "mehet") a SAJAT utolso kimeno kerdesedre valasz: elobb nezd vissza a sajat utolso 10-20 uzenetedet. Visszakerdezni csak akkor, ha a visszanezes utan is tobb nyitott kerdes illik ra, vagy egy sem.',
  'browser-clickthrough': 'Felületet (web/, dashboard, Munkapad) erinto munkanal a "kesz" ELOTT valodi bongeszos (Playwright) vegigkattintas kulon, ures web-only peldanyon: minden erintett gomb, funkcio, fajl-kimenet; kicsi javitasnal is. Az eredmeny a kartya kommentjebe. A "nem kattintottam vegig" kesz-uzenetben tilos: akkor a munka nincs kesz.',
  'follow-reference': 'Linkelt/hivatkozott tartalmat (annex, belinkelt fajl, DB-bejegyzes) sose vegy uresnek a mappa vagy a talalatszam alapjan: kovesd a linket, nezd meg mire mutat. A NULLA jelentheti: "nincs semmi" vagy "nem lattam oda".',
  'no-hidden-limits': 'Fejlesztesnel onmagadtol ne epits be korlatot, tiltast, meret- vagy hely-hatart. Ha szerinted fontos, ELOBB jelezd a tulajdonosnak a csatornajan, csak az engedelyevel told be, a felulet mondja ki. Meglevo rejtett korlatot jelezz, es keresre vedd le.',
  'web-research-save': 'A WebSearch/WebFetch talalatokat a rendszer (hook) magatol menti a Kutatasba. Te: munkadarabnal a talalt tenyeket es a forrast a Kontextus fajlba (context.append), a teendoket a Teendok koze; mas eszkoznel (curl, bongeszo) a lenyeget te mented.',
  'test-sandbox': 'Probalgatashoz (dokumentum, torles, linkeles, mappa, melleklet, import, forditas, level) a `sandbox` slugu PROBA projektet hasznald, sose valodi ugyfel- vagy hivatali projektet. Ha nincs, nyiss egyet sandbox slugkent.',
  'root-cause-fix': 'Hibajelzesnel keresd meg, hol hasznalodik maskeppen ugyanaz a fuggveny/szabaly/vegpont/renderer, es a KOZOS okot javitsd minden elofordulasnal egyszerre; a jelentesben nevezd meg a tovabbi erintett helyeket.',
  'regression-test': 'Minden hibajavitashoz regresszios teszt UGYANABBAN a commitban: javitas nelkul piros, javitassal zold (elobb nezd meg, hogy a javitatlan kodon bukik). A commit/PR cimeben jelezd. Ha gepi teszttel tenyleg nem foghato meg, a kartyara ird, miert nincs, es mivel merted helyette.',
  'workitem-folder-files': 'Munkadarab mappajaban CSAK a "Kontextus - <nev>.md" es a rendszer altal gyartott "Teendo - <nev>.md" lehet; sajat segedfajl (jogi kontextus, osszefoglalo, dokumentum-masolat) tilos. A tudast a Kontextus fajlba ird (context.append/rewrite); a kikuldott anyag az "Elkeszitett anyagok" mappaba megy.',
  'letter-head': 'Hivatalos level (birosag, hatosag, hivatal) feje: a FELADO keretes tablablokk JOBBRA FENT (utolso sor `#w=45&a=l&x=55&y=0&o=1`), a CIMZETT BALRA az ablak helyen (4 ures sor elotte, 2 utana; ures sor = egy U+200B), utana hely+datum, targy, megszolitas; a reszek kozt egy ures sor; forditasnal ugyanaz a fej. A teljes elrendezes a reszletes fajlban.',
}

// Remembers what this process already wrote, per FILE (the home directory can
// change under a test, and a deleted details dir must be rewritten, so a
// missing file always invalidates the memo).
const registry = new Map<string, string>()

/** Returns what the CLAUDE.md block should carry for `key`: the heading of the
 *  full body, the digest and a pointer to the full text. The full body is
 *  written to the details directory as a side effect (idempotent, never throws).
 *  A key without a digest returns the full body unchanged. */
export function ruleBody(key: string, full: string): string {
  const digest = RULE_DIGESTS[key]
  if (!digest) return full
  const file = join(ruleDetailsDir(), `${key}.md`)
  if (registry.get(file) !== full || !existsSync(file)) {
    registry.set(file, full)
    try {
      mkdirSync(ruleDetailsDir(), { recursive: true })
      const current = existsSync(file) ? readFileSync(file, 'utf-8') : ''
      if (current !== full + '\n') atomicWriteFileSync(file, full + '\n')
    } catch {
      /* a failed detail write must never break the CLAUDE.md update */
    }
  }
  const heading = full.split('\n').find((l) => l.startsWith('## ')) ?? ''
  const lines = heading ? [heading, ''] : []
  lines.push(digest, '', `Teljes szoveg (olvasd el, ha kell): ~/.claude/rule-details/${key}.md`)
  return lines.join('\n')
}

/** What a PER-AGENT CLAUDE.md carries for a digested rule. Every Claude Code
 *  session also loads the user-level ~/.claude/CLAUDE.md, which holds the same
 *  digest, so repeating it here only doubles the start cost (#799): the agent
 *  file keeps the heading and a pointer, the rule itself is not lost. */
export function agentRuleBody(key: string, full: string): string {
  if (!RULE_DIGESTS[key]) return full
  ruleBody(key, full) // keeps the full-text file current
  const heading = full.split('\n').find((l) => l.startsWith('## ')) ?? ''
  const lines = heading ? [heading, ''] : []
  lines.push(
    'Szabaly a globalis ~/.claude/CLAUDE.md-ben (minden session betolti); teljes szoveg: ' +
      `~/.claude/rule-details/${key}.md`,
  )
  return lines.join('\n')
}
