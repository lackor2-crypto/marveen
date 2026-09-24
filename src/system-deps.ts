/**
 * KULSO PROGRAMOK -- MIT KELL A GEPRE TELEPITENI, HOGY MINDEN MUKODJON
 * (kanban d7acdd75).
 *
 * Boss, 2026-09-23 (uzenet 1217): "ossze kellene szedni az osszes ilyen
 * programot, LibreOffice ... hogy mit kell telepiteni ahhoz, hogy
 * szazszazalekosan mukodjon a Marvin minden funkcioja, es a varazsloba ezt
 * betenni ... es az onellenorzes is erzekelje ... uj telepitesnel is".
 *
 * Ez az EGYETLEN lista. Innen olvas:
 *   - a Beallitasok / Varazslo "Kulso programok" lepese (/api/system-deps),
 *   - az Attekintes onellenorzese (system-health.ts, systemDepRows),
 *   - a teszt, ami ellenorzi, hogy az install-linux.sh MINDEN alap es ajanlott
 *     csomagot telepit (system-deps.test.ts) -- igy a lista es a telepito nem
 *     csuszhat el egymastol.
 *
 * Aki uj kulso programot kot be a Marveenbe, IDE vesz fel egy sort, es a
 * telepitobe a csomagjat. Ha csak az egyikbe kerul, a teszt elbukik.
 *
 * A NULLA KET DOLGOT JELENTHET: a meres `not_installed` (nincs ilyen program)
 * es `check_failed` (van, de nem tudtuk megkerdezni) kulon allapot -- a
 * capability-probe ugyanazt a szabalyt oriz. Amig meg nem mertunk, a pillanatkep
 * `null`: az "nem tudom", nem "minden rendben".
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { probeCommand, type CommandProbe } from './capability-probe.js'

export type DepTier = 'core' | 'recommended' | 'extra'
export type DepState = 'ok' | 'not_installed' | 'check_failed'
type Text = { hu: string; en: string }

export interface SystemDep {
  id: string
  /** A program neve, ahogy a felhasznalo ismeri. Nem forditjuk. */
  name: string
  /** core = enelkul a Marveen nem mukodik; recommended = egy funkcio all le
   *  nelkule; extra = kenyelmi, a hianya SOHA nem sarga/piros. */
  tier: DepTier
  /** Mire kell -- hetkoznapi nyelven. */
  what_for: Text
  /** Mi marad el nelkule. */
  affects: Text
  /** Debian/Ubuntu csomagok. Ures, ha nem apt-bol jon (pl. himalaya, bun). */
  apt: string[]
  /** Fedora/RHEL csomagok. */
  dnf: string[]
  /** macOS Homebrew csomagok. */
  brew: string[]
  /** Ha nincs csomag: kezi lepes (a telepito maga intezi, ld. install-linux.sh). */
  manual?: Text
  /** Hova kattintson, ha maga akarja beszerezni. */
  url: string
  /** A meres. Alapbol `probeCommand` a `commands` jeloltekkel. */
  commands: string[]
  versionArgs: string[]
  probe?: (force: boolean) => Promise<CommandProbe>
  /** A Marveen maga telepiti egy gombbal (nem rendszercsomag), pl. 'vision'
   *  = a helyi arcfelismero (`/api/vision/install`, vision-install.ts). */
  selfInstall?: 'vision'
}

const localBin = (name: string): string => join(homedir(), '.local', 'bin', name)

export const SYSTEM_DEPS: SystemDep[] = [
  {
    id: 'git', name: 'Git', tier: 'core',
    what_for: { hu: 'A Marveen frissítése, a mentések és a projektek verziókezelése.', en: 'Updating Marveen, backups and version control of projects.' },
    affects: { hu: 'A Marveen nem tud frissülni és menteni.', en: 'Marveen cannot update itself or make backups.' },
    apt: ['git'], dnf: ['git'], brew: ['git'], url: 'https://git-scm.com/downloads',
    commands: ['git'], versionArgs: ['--version'],
  },
  {
    id: 'tmux', name: 'tmux', tier: 'core',
    what_for: { hu: 'Ebben futnak az ágensek a háttérben.', en: 'The agents run inside it in the background.' },
    affects: { hu: 'Egyetlen ágens sem tud elindulni.', en: 'No agent can start.' },
    apt: ['tmux'], dnf: ['tmux'], brew: ['tmux'], url: 'https://github.com/tmux/tmux/wiki/Installing',
    commands: ['tmux', '/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux'], versionArgs: ['-V'],
  },
  {
    id: 'curl', name: 'curl', tier: 'core',
    what_for: { hu: 'Ezzel beszélnek az ágensek a Marveen felületével és egymással.', en: 'The agents use it to talk to the Marveen dashboard and to each other.' },
    affects: { hu: 'Az ágensek nem tudnak üzenni, emlékezni, kártyát kezelni.', en: 'The agents cannot send messages, save memories or handle cards.' },
    apt: ['curl'], dnf: ['curl'], brew: ['curl'], url: 'https://curl.se/download.html',
    commands: ['curl'], versionArgs: ['--version'],
  },
  {
    id: 'python3', name: 'Python 3', tier: 'core',
    what_for: { hu: 'A Google-kapcsolat (naptár, levél, Drive) és több háttérfeladat ezen fut.', en: 'The Google connection (calendar, mail, Drive) and several background jobs run on it.' },
    affects: { hu: 'A Google-funkciók és a háttérőrök nem futnak.', en: 'Google features and background watchers do not run.' },
    apt: ['python3'], dnf: ['python3'], brew: ['python'], url: 'https://www.python.org/downloads/',
    commands: ['python3'], versionArgs: ['--version'],
  },
  {
    id: 'lsof', name: 'lsof', tier: 'recommended',
    what_for: { hu: 'Újraindításkor ezzel találja meg a Marveen a saját, beragadt folyamatát.', en: 'On restart Marveen uses it to find its own stuck process.' },
    affects: { hu: 'Egy beragadt felület újraindítása kézi beavatkozást kérhet.', en: 'Restarting a stuck dashboard may need manual help.' },
    apt: ['lsof'], dnf: ['lsof'], brew: [], url: 'https://github.com/lsof-org/lsof',
    commands: ['lsof', '/usr/bin/lsof', '/usr/sbin/lsof'], versionArgs: ['-v'],
  },
  {
    id: 'ffmpeg', name: 'FFmpeg', tier: 'recommended',
    what_for: { hu: 'Hangüzenetek átalakítása (beszéd ↔ szöveg) és a videók előnézete a Munkapadon.', en: 'Converting voice messages (speech ↔ text) and video previews in the Workbench.' },
    affects: { hu: 'A hangüzeneteket nem tudom leírni és hangban válaszolni; a videók nem látszanak.', en: 'Voice messages cannot be transcribed or answered by voice; videos do not preview.' },
    apt: ['ffmpeg'], dnf: ['ffmpeg'], brew: ['ffmpeg'], url: 'https://ffmpeg.org/download.html',
    commands: ['ffmpeg'], versionArgs: ['-version'],
    // Lusta import: a workbench-capabilities sok modult huz be, es az
    // onellenorzes (system-health) importalja ezt a fajlt -- korkoros import ne legyen.
    probe: async (force) => (await import('./workbench-capabilities.js')).probeFfmpeg({ force }),
  },
  {
    id: 'libreoffice', name: 'LibreOffice', tier: 'recommended',
    what_for: { hu: 'Word-, Excel- és PowerPoint-fájlok előnézete és PDF-be alakítása a Munkapadon.', en: 'Previewing Word, Excel and PowerPoint files and turning them into PDF in the Workbench.' },
    affects: { hu: 'Az irodai dokumentumok nem látszanak beágyazva (letölteni ettől még lehet).', en: 'Office documents do not show embedded (they can still be downloaded).' },
    apt: ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'],
    dnf: ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress'],
    brew: ['--cask libreoffice'], url: 'https://www.libreoffice.org/download/download/',
    commands: ['soffice'], versionArgs: ['--version'],
    probe: async (force) => (await import('./office-convert.js')).probeLibreOffice({ force }),
  },
  {
    id: 'poppler', name: 'Poppler (pdftotext)', tier: 'recommended',
    what_for: { hu: 'A Beérkező mappában ezzel olvasom ki a PDF-ek szövegét (feladó, dátum, tárgy).', en: 'In the Inbox it reads the text of PDFs (sender, date, subject).' },
    affects: { hu: 'A PDF-eket gyengébben ismerem fel, többször kell kézzel mappát választanod.', en: 'PDFs are recognised less well, so you pick the folder by hand more often.' },
    apt: ['poppler-utils'], dnf: ['poppler-utils'], brew: ['poppler'], url: 'https://poppler.freedesktop.org/',
    commands: ['pdftotext'], versionArgs: ['-v'],
  },
  {
    id: 'tesseract', name: 'Tesseract OCR', tier: 'recommended',
    what_for: { hu: 'Szkennelt papírok és fotók szövegének felismerése a Beérkező mappában.', en: 'Reading the text of scanned papers and photos in the Inbox.' },
    affects: { hu: 'A szkennelt levelek szövegét nem látom, csak a fájl nevét.', en: 'The text of scanned letters is not read, only the file name.' },
    apt: ['tesseract-ocr', 'tesseract-ocr-hun', 'tesseract-ocr-eng'], dnf: ['tesseract', 'tesseract-langpack-hun'],
    brew: ['tesseract', 'tesseract-lang'], url: 'https://tesseract-ocr.github.io/tessdoc/Installation.html',
    commands: ['tesseract'], versionArgs: ['--version'],
  },
  {
    id: 'himalaya', name: 'Himalaya', tier: 'recommended',
    what_for: { hu: 'Az Email oldal ezzel válaszol, továbbít, mozgat és töröl leveleket.', en: 'The Email page uses it to reply, forward, move and delete mail.' },
    affects: { hu: 'A leveleket olvasni lehet, de válaszolni, áthelyezni, törölni nem.', en: 'Mail can be read, but not replied to, moved or deleted.' },
    apt: [], dnf: [], brew: ['himalaya'],
    manual: {
      hu: 'Nincs hozzá rendszercsomag: a Marveen telepítője magától letölti a ~/.local/bin mappába. Ha utólag kell: futtasd újra a telepítőt, vagy töltsd le a kiadások oldaláról.',
      en: 'There is no system package for it: the Marveen installer downloads it into ~/.local/bin by itself. To add it later: run the installer again, or download it from the releases page.',
    },
    url: 'https://github.com/pimalaya/himalaya/releases',
    commands: [localBin('himalaya'), 'himalaya'], versionArgs: ['--version'],
  },
  {
    id: 'bun', name: 'Bun', tier: 'recommended',
    what_for: { hu: 'Ezen fut a Telegram-csatorna: ezen keresztül írsz az ágenseknek és ők neked.', en: 'The Telegram channel runs on it: this is how you message the agents and they message you.' },
    affects: { hu: 'Az ágensek nem kapják meg a Telegram-üzeneteidet és nem tudnak ott válaszolni.', en: 'The agents do not receive your Telegram messages and cannot reply there.' },
    apt: [], dnf: [], brew: [],
    manual: {
      hu: 'Nincs hozzá rendszercsomag: a Marveen telepítője magától letölti a ~/.bun mappába. Ha utólag kell: futtasd újra a telepítőt, vagy ezt az egy sort: curl -fsSL https://bun.sh/install | bash',
      en: 'There is no system package for it: the Marveen installer downloads it into ~/.bun by itself. To add it later: run the installer again, or this one line: curl -fsSL https://bun.sh/install | bash',
    },
    url: 'https://bun.sh/docs/installation',
    // agent-process.ts a Telegram-plugint a ~/.bun/bin/bun-nal inditja.
    commands: [join(homedir(), '.bun', 'bin', 'bun'), 'bun'], versionArgs: ['--version'],
  },
  {
    id: 'jq', name: 'jq', tier: 'recommended',
    what_for: { hu: 'Az ágens-őr ezzel olvassa ki, melyik modellen kell újraindítani a fő ágenst.', en: 'The agent watchdog uses it to read which model to restart the main agent on.' },
    affects: { hu: 'Egy automatikus újraindítás után a fő ágens az alap modellre állhat vissza.', en: 'After an automatic restart the main agent may fall back to the default model.' },
    apt: ['jq'], dnf: ['jq'], brew: ['jq'], url: 'https://jqlang.org/download/',
    commands: ['jq'], versionArgs: ['--version'],
  },
  {
    id: 'sqlite3', name: 'SQLite', tier: 'recommended',
    what_for: { hu: 'Módosítás előtti adatbázis-mentés és a karbantartó szkriptek.', en: 'The database backup taken before risky changes, and the maintenance scripts.' },
    affects: { hu: 'A módosítás előtti biztonsági mentés az adatbázist kihagyja.', en: 'The pre-change safety backup skips the database.' },
    apt: ['sqlite3'], dnf: ['sqlite'], brew: ['sqlite'], url: 'https://www.sqlite.org/download.html',
    commands: ['sqlite3'], versionArgs: ['--version'],
  },
  {
    id: 'unzip', name: 'unzip', tier: 'recommended',
    what_for: { hu: 'Tömörített (ZIP) skillek feltöltése a felületen.', en: 'Uploading zipped (ZIP) skills on the dashboard.' },
    affects: { hu: 'ZIP-ben kapott skillt nem lehet feltölteni.', en: 'A skill received as a ZIP cannot be uploaded.' },
    apt: ['unzip'], dnf: ['unzip'], brew: [], url: 'https://infozip.sourceforge.net/',
    commands: ['unzip'], versionArgs: ['-v'],
  },
  {
    id: 'gh', name: 'GitHub CLI', tier: 'extra',
    what_for: { hu: 'Ha a Marveen saját fejlesztését GitHubon vezeted: a változások beküldése.', en: 'If you develop Marveen itself on GitHub: submitting the changes.' },
    affects: { hu: 'Semmi a mindennapi használatban.', en: 'Nothing in everyday use.' },
    apt: ['gh'], dnf: ['gh'], brew: ['gh'], url: 'https://cli.github.com/',
    commands: ['gh'], versionArgs: ['--version'],
  },
  {
    id: 'ollama', name: 'Ollama', tier: 'extra',
    what_for: { hu: 'Helyi keresés a régi beszélgetések között, internet nélkül.', en: 'Local search in old conversations, without the internet.' },
    affects: { hu: 'A keresés ettől még működik, csak lassabb.', en: 'Search still works, just slower.' },
    apt: [], dnf: [], brew: ['ollama'],
    manual: { hu: 'A letöltési oldalon egy sorral telepíthető, utána a Varázsló „Ollama” lépésében add meg a címét.', en: 'It installs with one line from its download page; then give its address in the wizard’s “Ollama” step.' },
    url: 'https://ollama.com/download',
    commands: ['ollama'], versionArgs: ['--version'],
  },
  {
    id: 'rclone', name: 'rclone', tier: 'extra',
    what_for: { hu: 'MEGA fiókok bekötése: a Tárolók alatt a MEGA mappa és a tárhely-mérés.', en: 'Connecting MEGA accounts: the MEGA folder under Storages and its space measurement.' },
    affects: { hu: 'MEGA fiókot nem lehet hozzáadni. A Drive, a Fotók és a Git ettől függetlenül működik.', en: 'MEGA accounts cannot be added. Drive, Photos and Git work regardless.' },
    apt: [], dnf: [], brew: ['rclone'],
    manual: {
      hu: 'A Marveen telepítője magától letölti a ~/.local/bin mappába (rendszergazdai jog nélkül). Ha utólag kell: futtasd újra a telepítőt, vagy töltsd le a letöltési oldalról.',
      en: 'The Marveen installer downloads it into ~/.local/bin by itself (no admin rights needed). To add it later: run the installer again, or download it from its download page.',
    },
    url: 'https://rclone.org/downloads/',
    commands: [localBin('rclone'), 'rclone'], versionArgs: ['version'],
  },
  {
    id: 'face-recognizer', name: 'face_recognition', tier: 'extra',
    what_for: { hu: 'A Beérkező mappában a fotóról felismeri, kié a kép, és a személy mappáját ajánlja. Mindez a gépeden fut, internet nélkül.', en: 'In the Inbox it recognises whose photo it is and suggests that person’s folder. It all runs on your machine, without the internet.' },
    affects: { hu: 'A fotók mappáját kézzel választod ki. Minden más működik.', en: 'You pick the folder of photos by hand. Everything else works.' },
    apt: [], dnf: [], brew: [],
    manual: {
      hu: 'Nincs hozzá rendszercsomag: a Telepítés gombbal a Marveen maga telepíti (10–20 perc, közben a felület használható).',
      en: 'There is no system package for it: the Install button makes Marveen install it by itself (10–20 minutes, the dashboard stays usable meanwhile).',
    },
    url: 'https://github.com/ageitgey/face_recognition#installation',
    commands: [], versionArgs: [],
    selfInstall: 'vision',
    probe: async (force) => {
      const { VISION_PYTHON, FACE_SCRIPT } = await import('./life-vision-adapter.js')
      if (!existsSync(FACE_SCRIPT)) {
        return { available: false, path: null, version: null, reason: 'not_installed', detail: null, checked_at: Date.now() }
      }
      return probeCommand({
        id: 'sysdep:face-recognizer', configured: null, candidates: [VISION_PYTHON],
        versionArgs: ['-c', 'import face_recognition as f; print("face_recognition " + f.__version__)'],
        timeoutMs: 20_000,
      }, { force })
    },
  },
  {
    id: 'tailscale', name: 'Tailscale', tier: 'extra',
    what_for: { hu: 'A Marveen felülete elérhető a telefonodról is, otthonon kívülről.', en: 'Reaching the Marveen dashboard from your phone, away from home.' },
    affects: { hu: 'Csak erről a gépről (és a helyi hálózatról) érhető el a felület.', en: 'The dashboard is reachable only from this machine (and the local network).' },
    apt: [], dnf: [], brew: ['--cask tailscale'],
    manual: { hu: 'A letöltési oldalon egy sorral telepíthető.', en: 'It installs with one line from its download page.' },
    url: 'https://tailscale.com/download',
    commands: ['tailscale'], versionArgs: ['version'],
  },
]

export interface DepResult {
  id: string
  name: string
  tier: DepTier
  state: DepState
  version: string | null
  path: string | null
  /** A VALODI hibauzenet, ha nem sikerult megkerdezni. */
  detail: string | null
  what_for: Text
  affects: Text
  packages: string[]
  manual: Text | null
  url: string
  /** A felulet Telepites gombot mutat, ha hianyzik. */
  self_install: 'vision' | null
}

export interface DepsSnapshot {
  measured_at: number
  pkg_manager: PkgManager
  items: DepResult[]
}

export type PkgManager = 'apt' | 'dnf' | 'brew' | null

/** Melyik csomagkezelo van ezen a gepen. A parancsot ehhez igazitjuk, hogy a
 *  felhasznalo azt masolja be, ami NALA mukodik. */
export function detectPkgManager(exists: (p: string) => boolean = existsSync): PkgManager {
  if (exists('/usr/bin/apt-get')) return 'apt'
  if (exists('/usr/bin/dnf') || exists('/usr/bin/yum')) return 'dnf'
  if (exists('/opt/homebrew/bin/brew') || exists('/usr/local/bin/brew')) return 'brew'
  return null
}

export function packagesFor(dep: SystemDep, pm: PkgManager): string[] {
  if (pm === 'apt') return dep.apt
  if (pm === 'dnf') return dep.dnf
  if (pm === 'brew') return dep.brew
  return []
}

/**
 * Egy bemasolhato sor, ami a hianyzo ALAP es AJANLOTT programokat telepiti.
 * `null`, ha nincs mit, vagy nem ismerjuk a csomagkezelot (akkor a felulet
 * programonkent a letoltesi linket mutatja). Az extrak SOSE kerulnek bele:
 * azokat a felhasznalo maga valasztja.
 */
export function installCommand(items: DepResult[], pm: PkgManager): string | null {
  const pkgs = items
    .filter(i => i.state !== 'ok' && i.tier !== 'extra')
    .flatMap(i => i.packages)
  if (pm === null || pkgs.length === 0) return null
  const uniq = [...new Set(pkgs)]
  if (pm === 'apt') return `sudo apt-get install -y --no-install-recommends ${uniq.join(' ')}`
  if (pm === 'dnf') return `sudo dnf install -y ${uniq.join(' ')}`
  const casks = uniq.filter(p => p.startsWith('--cask ')).map(p => p.slice(7))
  const formulae = uniq.filter(p => !p.startsWith('--cask '))
  return [formulae.length ? `brew install ${formulae.join(' ')}` : '', casks.length ? `brew install --cask ${casks.join(' ')}` : '']
    .filter(Boolean).join(' && ')
}

function toResult(dep: SystemDep, p: CommandProbe, pm: PkgManager): DepResult {
  return {
    id: dep.id, name: dep.name, tier: dep.tier,
    state: p.reason,
    version: p.version, path: p.path, detail: p.detail,
    what_for: dep.what_for, affects: dep.affects,
    packages: packagesFor(dep, pm),
    manual: dep.manual ?? null,
    url: dep.url,
    self_install: dep.selfInstall ?? null,
  }
}

async function measureOne(dep: SystemDep, force: boolean): Promise<CommandProbe> {
  if (dep.probe) return dep.probe(force)
  return probeCommand({
    id: `sysdep:${dep.id}`,
    configured: null,
    candidates: dep.commands,
    versionArgs: dep.versionArgs,
    timeoutMs: 20_000,
  }, { force })
}

let snapshot: DepsSnapshot | null = null
let monitorStartedAt: number | null = null

/** Minden programot megmer. `force` = ne a 5 perces gyorsitotarbol valaszoljon
 *  (a felulet "Ellenorzes most" gombja, telepites utan). */
export async function measureSystemDeps(force = false, deps: SystemDep[] = SYSTEM_DEPS): Promise<DepsSnapshot> {
  const pm = detectPkgManager()
  const probes = await Promise.all(deps.map(async (d) => {
    try {
      return toResult(d, await measureOne(d, force), pm)
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return toResult(d, { available: false, path: null, version: null, reason: 'check_failed', detail, checked_at: Date.now() }, pm)
    }
  }))
  const snap: DepsSnapshot = { measured_at: Date.now(), pkg_manager: pm, items: probes }
  if (deps === SYSTEM_DEPS) snapshot = snap
  return snap
}

/** Az utolso meres, vagy `null`, ha meg nem mertunk ("nem tudom", nem "rendben"). */
export function systemDepsSnapshot(): DepsSnapshot | null { return snapshot }

/** Mikor indult a hatter-meres (`null`: el sem indult). Az onellenorzes ebbol
 *  tudja, hogy a hianyzo pillanatkep "meg fut" vagy "nem latok oda". */
export function systemDepsMonitorStartedAt(): number | null { return monitorStartedAt }

const REFRESH_MS = 6 * 60 * 60 * 1000

/** Indulaskor egyszer, utana 6 orankent ujramer. A dashboard inditja. */
export function startSystemDepsMonitor(): void {
  if (monitorStartedAt !== null) return
  monitorStartedAt = Date.now()
  const run = (): void => { void measureSystemDeps(true).catch(() => { /* a pillanatkep marad */ }) }
  run()
  setInterval(run, REFRESH_MS).unref?.()
}

/** Csak teszthez. */
export function _setSystemDepsSnapshot(s: DepsSnapshot | null, startedAt: number | null = null): void {
  snapshot = s
  monitorStartedAt = startedAt
}
