/**
 * MUNKAPAD -- KEPESSEGEK ES FUGGOSEGEK (kanban #336, 8. fazis; spec 1-2).
 *
 * Egy kerdesre felel: MI AZ, AMI EZEN A GEPEN MOST MUKODIK, es ami nem, azzal
 * mi a teendo. A spec 2. szakasza ezt "graceful degradation"-nek hivja: egy
 * hianyzo komponens NEM teheti hasznalhatatlanna a Munkapadot.
 *
 * NEGY SZABALY, amit ez a fajl oriz:
 *
 * 1. A NULLA KET DOLGOT JELENTHET. A "nincs meg" allapotot NEM mossuk ossze a
 *    "nem tudtam megkerdezni"-vel: `not_installed` / `not_configured` csendes,
 *    varhato allapot egy friss telepitesen -- `check_failed` viszont hiba, mas
 *    teendovel. Ezert kulon allapot mindegyik.
 * 2. SOSE TALALGATUNK OKOT. A `detail` mindig a VALODI hibauzenet (stderr,
 *    `e.message`); ha nincs, akkor `null`, es azt mondjuk, hogy nem tudjuk.
 * 3. AZ EXTRA HIANYA NEM VESZJELZES. Minden kepesseg `tier`-t kap: az `extra`
 *    hianyat a felulet SOHA nem mutathatja pirosan (CLAUDE.md, 2026-08-11).
 * 4. FRISS TELEPITESEN IS VEGIGMEGY. Amihez ut vagy cim kell, ahhoz tartozik
 *    egy FELULETROL irhato beallitas (`setting`), tehat nem kell sem terminal,
 *    sem .env-szerkesztes. Amihez telepites kell, ahhoz `how_to` lepesek.
 *
 * Amihez NINCS megvalositasunk (Gemini/Veo/ElevenLabs), azt `not_implemented`
 * allapottal, KIMONDVA soroljuk fel -- nem kinalunk hozza varazslot, ami ugysem
 * vezetne sehova. A hazug "majdnem kesz" rosszabb, mint a nyilt "ez meg nincs".
 */
import { probeCommand, resetProbeCache, type CommandProbe } from './capability-probe.js'
import { configuredSoffice, sofficeCandidates, probeLibreOffice, OFFICE_CONVERTIBLE } from './office-convert.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { getSettingDefinition } from './config-registry.js'
import { ensureWorkbenchAgent } from './workbench-agent/index.js'
import { listAIProviders } from './workbench-agent/provider.js'
import { activeWebSearchProvider, lastWebSearchProbe, probeWebSearch } from './workbench-agent/web-search.js'

export type CapabilityState =
  /** Mukodik, meg is mertuk. */
  | 'ok'
  /** Nincs telepitve ezen a gepen (a program hianyzik). Csendes allapot. */
  | 'not_installed'
  /** Telepitve/elerheto volna, de nincs beallitva (cim, kulcs, ut). Csendes. */
  | 'not_configured'
  /** LETEZIK, de nem tudtuk megkerdezni. Ez HIBA, es mas a teendo. */
  | 'check_failed'
  /** Ebben a verzioban meg nincs megvalositva. Kimondjuk, nem igerjuk. */
  | 'not_implemented'

/** Mennyire fontos. A felulet ez alapjan szinez: `extra` hianya SOHA nem piros. */
export type CapabilityTier = 'core' | 'recommended' | 'extra'

export type Lang = 'hu' | 'en'
type Text = { hu: string; en: string }

export interface CapabilitySetting {
  /** A `config-registry` kulcsa -- CSAK ez irhato a kepesseg-vegponton at. */
  key: string
  /** A jelenlegi ertek. Titoknal SOSE az ertek, csak hogy van-e. */
  value: string | null
  secret: boolean
  configured: boolean
  label: Text
  placeholder: string
}

export interface CapabilityDescriptor {
  key: string
  tier: CapabilityTier
  title: Text
  /** Mire jo -- hetkoznapi nyelven, szakszo nelkul. */
  what_for: Text
  /** Mi marad el, ha hianyzik. A felhasznalo ebbol tudja, siet-e vele. */
  affects: Text
  /** Szamozhato lepesek: hogyan szerezheto be / allithato be. */
  how_to: { hu: string[]; en: string[] }
  /** Ahova kattintani kell (letoltes, dokumentacio). Nem csak a neve: LINK. */
  obtain_url: string | null
  /** A FELULETROL irhato beallitas kulcsa, ha van ilyen. */
  setting_key?: string
  /** Van-e ertelme "Ellenorzes most" gombot adni hozza. */
  testable: boolean
  measure(force: boolean): Promise<{ state: CapabilityState; detail: string | null; version: string | null; path: string | null }>
  /** Extra mezok a valaszban (pl. milyen kiterjeszteseket erint). */
  extra?(): Record<string, unknown>
}

function fromProbe(p: CommandProbe): { state: CapabilityState; detail: string | null; version: string | null; path: string | null } {
  return {
    state: p.reason === 'ok' ? 'ok' : p.reason,
    detail: p.detail,
    version: p.version,
    path: p.path,
  }
}

/** Hol keressuk az FFmpeg-et. A megadott ut (beallitas vagy kornyezeti valtozo)
 *  ELSObbseget elvez, es ha AZ rossz, azt kimondjuk -- nem hasznalunk csendben
 *  egy masik peldanyt, mert akkor a felhasznalo azt hinne, jo, amit beirt. */
export function ffmpegConfigured(): { path: string; source: string } | null {
  const env = (process.env['MARVEEN_FFMPEG'] || '').trim()
  if (env) return { path: env, source: 'MARVEEN_FFMPEG' }
  let setting = ''
  try { setting = String(getEffectiveSettingValue('WORKBENCH_FFMPEG_PATH') ?? '').trim() } catch { setting = '' }
  if (setting) return { path: setting, source: 'WORKBENCH_FFMPEG_PATH' }
  return null
}

export function ffmpegCandidates(): string[] {
  const c = ffmpegConfigured()
  if (c) return [c.path]
  return [
    'ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/snap/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ]
}

export async function probeFfmpeg(opts: { force?: boolean; candidates?: string[]; timeoutMs?: number } = {}): Promise<CommandProbe> {
  return probeCommand({
    id: 'ffmpeg',
    configured: ffmpegConfigured(),
    candidates: ffmpegCandidates(),
    versionArgs: ['-version'],
    timeoutMs: 20_000,
  }, opts)
}

function onlyofficeUrl(): string {
  try { return String(getEffectiveSettingValue('WORKBENCH_ONLYOFFICE_URL') ?? '').trim() } catch { return '' }
}

export const CAPABILITIES: CapabilityDescriptor[] = [
  {
    key: 'pdf_preview',
    tier: 'core',
    title: { hu: 'PDF- és képelőnézet', en: 'PDF and image preview' },
    what_for: {
      hu: 'A PDF-eket és a képeket a Munkapad magától megmutatja, telepítés nélkül. Ehhez nem kell semmit beállítanod.',
      en: 'The Workbench shows PDFs and images on its own, with nothing to install. There is nothing for you to set up here.',
    },
    affects: { hu: 'Semmi: ez a böngészőben van, mindig működik.', en: 'Nothing: this lives in the browser and always works.' },
    how_to: { hu: [], en: [] },
    obtain_url: null,
    testable: false,
    async measure() { return { state: 'ok', detail: null, version: null, path: null } },
  },
  {
    key: 'office_to_pdf',
    tier: 'recommended',
    title: { hu: 'Irodai dokumentum előnézete (DOCX, XLSX, PPTX)', en: 'Office document preview (DOCX, XLSX, PPTX)' },
    what_for: {
      hu: 'A böngésző a Word-, Excel- és PowerPoint-fájlokat magától nem tudja megmutatni. A LibreOffice csinál belőlük egy PDF-et, és azt a Munkapad már be tudja ágyazni.',
      en: 'Browsers cannot display Word, Excel or PowerPoint files on their own. LibreOffice turns them into a PDF, which the Workbench can then embed.',
    },
    affects: {
      hu: 'Enélkül is minden működik: a dokumentum feltölthető, letölthető, új verzió tölthető vissza belőle. Csak a beágyazott előnézet marad el.',
      en: 'Everything still works without it: the document can be uploaded, downloaded and re-uploaded as a new version. Only the embedded preview is missing.',
    },
    how_to: {
      hu: [
        'Linux (Ubuntu/Debian): nyiss egy terminált, és add ki: sudo apt install libreoffice',
        'Windows: töltsd le a libreoffice.org oldalról, és telepítsd a szokásos módon.',
        'macOS: töltsd le a libreoffice.org oldalról, és húzd az Alkalmazások mappába.',
        'Ha telepítve van, de a Marveen nem találja (például hordozható változat), írd be alább a teljes útvonalát, például: /usr/bin/soffice',
        'Utána nyomd meg az "Ellenőrzés most" gombot -- azonnal újra megméri.',
      ],
      en: [
        'Linux (Ubuntu/Debian): open a terminal and run: sudo apt install libreoffice',
        'Windows: download it from libreoffice.org and install it the usual way.',
        'macOS: download it from libreoffice.org and drag it into Applications.',
        'If it is installed but Marveen cannot find it (a portable copy, say), type its full path below, for example: /usr/bin/soffice',
        'Then press "Check now" -- it measures again immediately.',
      ],
    },
    obtain_url: 'https://www.libreoffice.org/download/download-libreoffice/',
    setting_key: 'WORKBENCH_LIBREOFFICE_PATH',
    testable: true,
    async measure(force) { return fromProbe(await probeLibreOffice({ force })) },
    extra() {
      return { extensions: Object.keys(OFFICE_CONVERTIBLE), candidates: sofficeCandidates(), configured_by: configuredSoffice()?.source ?? null }
    },
  },
  {
    key: 'office_embedded_edit',
    tier: 'extra',
    title: { hu: 'Word-dokumentum szerkesztése a böngészőben', en: 'Editing Word documents in the browser' },
    what_for: {
      hu: 'Egy ONLYOFFICE Document Server címével a dokumentumot közvetlenül a böngészőben lehetne szerkeszteni, letöltés nélkül.',
      en: 'With the address of an ONLYOFFICE Document Server you could edit the document right in the browser, without downloading it.',
    },
    affects: {
      hu: 'Ez kényelmi lehetőség. Enélkül a bevált út működik: letöltöd, szerkeszted a saját géped programjával, visszatöltöd -- és abból új verzió lesz, semmi nem vész el.',
      en: 'This is a convenience. Without it the proven path works: download, edit in your own program, upload again -- that creates a new version and nothing is lost.',
    },
    how_to: {
      hu: [
        'Ehhez egy külön kiszolgálóra van szükség (ONLYOFFICE Document Server), ami nem része a Marveennek.',
        'Ha már fut ilyen a hálózatodon, írd be alább a címét, például: http://localhost:8080',
        'Ha nincs ilyened, hagyd üresen: a letöltés -> szerkesztés -> visszatöltés út ugyanúgy új verziót készít.',
      ],
      en: [
        'This needs a separate server (ONLYOFFICE Document Server), which is not part of Marveen.',
        'If you already run one, type its address below, for example: http://localhost:8080',
        'If you do not have one, leave it empty: download -> edit -> upload still creates a new version.',
      ],
    },
    obtain_url: 'https://www.onlyoffice.com/download-docs.aspx',
    setting_key: 'WORKBENCH_ONLYOFFICE_URL',
    testable: false,
    async measure() {
      const u = onlyofficeUrl()
      if (!u) return { state: 'not_configured', detail: null, version: null, path: null }
      return { state: 'ok', detail: null, version: null, path: u }
    },
  },
  {
    key: 'video_render',
    tier: 'extra',
    title: { hu: 'Videó- és hangműveletek (FFmpeg)', en: 'Video and audio operations (FFmpeg)' },
    what_for: {
      hu: 'Az FFmpeg egy ingyenes program, ami videót és hangot tud vágni, átalakítani, összefűzni. A Munkapad ezt használja majd a videó-munkadarabokhoz.',
      en: 'FFmpeg is a free program that can cut, convert and join video and audio. The Workbench uses it for video work items.',
    },
    affects: {
      hu: 'A Munkapad többi része enélkül is teljesen működik. Videófájlt enélkül is feltölthetsz és letölthetsz, csak a gépi feldolgozás marad el.',
      en: 'The rest of the Workbench works fully without it. You can still upload and download video files; only machine processing is missing.',
    },
    how_to: {
      hu: [
        'Linux (Ubuntu/Debian): sudo apt install ffmpeg',
        'Windows: töltsd le a ffmpeg.org oldalról, csomagold ki, és írd be alább a teljes útvonalát (például: C:\\ffmpeg\\bin\\ffmpeg.exe).',
        'macOS: brew install ffmpeg',
        'Utána nyomd meg az "Ellenőrzés most" gombot.',
      ],
      en: [
        'Linux (Ubuntu/Debian): sudo apt install ffmpeg',
        'Windows: download it from ffmpeg.org, unpack it, and type the full path below (for example: C:\\ffmpeg\\bin\\ffmpeg.exe).',
        'macOS: brew install ffmpeg',
        'Then press "Check now".',
      ],
    },
    obtain_url: 'https://ffmpeg.org/download.html',
    setting_key: 'WORKBENCH_FFMPEG_PATH',
    testable: true,
    async measure(force) { return fromProbe(await probeFfmpeg({ force })) },
  },
  {
    key: 'ai_agent',
    tier: 'core',
    title: { hu: 'Munkapad-ügynök (szövegírás, átdolgozás)', en: 'Workbench agent (writing and rewriting)' },
    what_for: {
      hu: 'Ez felel a Munkapad beszélgetős oldaláért: ő írja és dolgozza át a munkadarabot, amikor kérsz tőle valamit.',
      en: 'This powers the conversation side of the Workbench: it writes and rewrites the work item when you ask it to.',
    },
    affects: {
      hu: 'Enélkül a Munkapad kézi szerkesztőként továbbra is teljesen működik (verziózás, előnézet, fájlok), csak az ügynök nem válaszol.',
      en: 'Without it the Workbench still works fully as a manual editor (versions, preview, files); only the agent will not answer.',
    },
    how_to: {
      hu: [
        'Alapesetben nem kell semmit tenned: a gépen bejelentkezett Claude-előfizetést használja, ugyanabból az 5 órás keretből, mint a többi ügynök.',
        'Ha "nincs beállítva" áll itt, akkor ezen a gépen nincs bejelentkezett Claude-fiók: futtasd le a bejelentkezést (claude login) abban a felhasználói fiókban, amelyikben a Marveen fut.',
        'Külön, előfizetéstől független számlázáshoz a Beállítások / Munkapad oldalon megadható egy saját API-kulcs. Ez nem kötelező, és a kulcs sosem kerül a böngészőbe.',
      ],
      en: [
        'Normally there is nothing to do: it uses the Claude subscription signed in on this machine, from the same 5-hour budget as the other agents.',
        'If this says "not configured", there is no signed-in Claude account on this machine: run the login (claude login) as the user Marveen runs as.',
        'For separate, subscription-independent billing you can enter your own API key on the Settings / Workbench page. It is optional, and the key never reaches the browser.',
      ],
    },
    obtain_url: null,
    setting_key: 'WORKBENCH_ANTHROPIC_API_KEY',
    testable: true,
    async measure() {
      ensureWorkbenchAgent()
      const providers = listAIProviders()
      // A NULLA itt is ketfele: "egy szolgaltato sincs bejegyezve" mas hiba,
      // mint "van, de nincs beallitva" -- ezert kulon mondjuk ki.
      if (providers.length === 0) {
        return { state: 'check_failed', detail: 'no AI provider is registered in this build', version: null, path: null }
      }
      for (const p of providers) {
        try {
          const a = p.availability()
          if (a.available) return { state: 'ok', detail: a.detail ?? null, version: p.model(), path: p.id }
        } catch (e) {
          return { state: 'check_failed', detail: (e as Error).message, version: null, path: p.id }
        }
      }
      const first = providers[0]!
      let detail: string | null = null
      try { detail = first.availability().detail ?? null } catch { detail = null }
      return { state: 'not_configured', detail, version: null, path: null }
    },
  },
  // #404: webkereses a Claude SAJAT keresojevel, a bejelentkezett
  // elofizetesrol -- nincs kulcs, nincs mit beallitani (a Brave-et a
  // tulajdonos 2026-09-26-an kivetette). Az "Ellenorzes most" egy valodi,
  // egytalalatos keresessel mer: csak igy derul ki, hogy tenyleg mukodik.
  {
    key: 'web_search',
    tier: 'extra',
    title: { hu: 'Webkeresés', en: 'Web search' },
    what_for: {
      hu: 'Ezzel a Munkapad ügynöke rá tud keresni valamire az interneten (árak, szabványok, hírek), és a talált oldalak címét is megmondja.',
      en: 'With this the Workbench agent can look things up on the internet (prices, standards, news) and tells you the address of each page it found.',
    },
    affects: {
      hu: 'Enélkül minden más működik, csak az ügynök nem keres a weben: amit nem tud, azt megmondja, és nem talál ki helyette semmit.',
      en: 'Without it everything else works; only the agent will not search the web: what it does not know, it says so and does not make it up.',
    },
    how_to: {
      hu: [
        'Nem kell hozzá kulcs és bankkártya: a keresés a bejelentkezett Claude-előfizetésedet használja, és a közös 5 órás keretből megy.',
        'Ha „nincs beállítva” áll itt, jelentkezz be a Claude-fiókoddal a Beállítások → Varázsló → Claude bejelentkezés lépésben.',
        'Nyomd meg az „Ellenőrzés most” gombot: egy próbakereséssel megnézi, hogy a keresés tényleg működik-e (kb. 20 másodperc).',
      ],
      en: [
        'No key and no bank card needed: search uses your signed-in Claude subscription and counts toward the shared 5-hour limit.',
        'If this says "not set up", sign in with your Claude account under Settings → Wizard → Claude sign-in.',
        'Press "Check now": it runs one test search to see whether search really works (about 20 seconds).',
      ],
    },
    obtain_url: null,
    testable: true,
    async measure(force) {
      const p = activeWebSearchProvider()
      if (!p.configured()) return { state: 'not_configured', detail: 'no signed-in Claude account', version: null, path: null }
      if (!force) {
        // Nem egetunk keresest minden oldalbetoltesnel: a legutobbi VALODI
        // meres all; ha meg nem mertunk, kimondjuk.
        const last = lastWebSearchProbe()
        if (last) return last
        return { state: 'ok', detail: 'signed in, not tested yet -- press "Check now"', version: null, path: p.id }
      }
      return probeWebSearch()
    },
  },
  // Amire NINCS megvalositasunk. Kimondva soroljuk fel, hogy a felhasznalo ne
  // keressen olyan kapcsolot, ami nincs -- es ne varjon olyan gombra, ami nem
  // csinalna semmit. A spec 1. szakasza emliti oket; a bekotesuk kesobbi munka.
  {
    key: 'image_gen',
    tier: 'extra',
    title: { hu: 'Képgenerálás (Gemini / Imagen)', en: 'Image generation (Gemini / Imagen)' },
    what_for: { hu: 'Kép készítése szöveges leírásból, a Munkapadon belül.', en: 'Creating an image from a text description, inside the Workbench.' },
    affects: {
      hu: 'A Munkapad minden más része működik. Képet most is használhatsz: feltöltheted a sajátodat, és a munkadarab részévé teheted.',
      en: 'Every other part of the Workbench works. You can still use images: upload your own and make it part of the work item.',
    },
    how_to: {
      hu: ['Ebben a verzióban még nincs bekötve, ezért nincs mit beállítani hozzá. Amint elkészül, itt fog megjelenni a beállítása.'],
      en: ['It is not wired up in this version, so there is nothing to configure. Once it is ready, its setting will appear here.'],
    },
    obtain_url: null,
    testable: false,
    async measure() { return { state: 'not_implemented', detail: null, version: null, path: null } },
  },
  {
    key: 'video_gen',
    tier: 'extra',
    title: { hu: 'Videógenerálás (Veo)', en: 'Video generation (Veo)' },
    what_for: { hu: 'Videó készítése szöveges leírásból, a Munkapadon belül.', en: 'Creating a video from a text description, inside the Workbench.' },
    affects: {
      hu: 'A Munkapad minden más része működik. Saját videót most is feltölthetsz.',
      en: 'Every other part of the Workbench works. You can still upload your own video.',
    },
    how_to: {
      hu: ['Ebben a verzióban még nincs bekötve, ezért nincs mit beállítani hozzá.'],
      en: ['It is not wired up in this version, so there is nothing to configure.'],
    },
    obtain_url: null,
    testable: false,
    async measure() { return { state: 'not_implemented', detail: null, version: null, path: null } },
  },
  {
    key: 'tts',
    tier: 'extra',
    title: { hu: 'Felolvasás (ElevenLabs)', en: 'Text to speech (ElevenLabs)' },
    what_for: { hu: 'A megírt szöveg felolvastatása, hangfájlba.', en: 'Reading the written text aloud into an audio file.' },
    affects: { hu: 'A Munkapad minden más része működik.', en: 'Every other part of the Workbench works.' },
    how_to: {
      hu: ['Ebben a verzióban még nincs bekötve, ezért nincs mit beállítani hozzá.'],
      en: ['It is not wired up in this version, so there is nothing to configure.'],
    },
    obtain_url: null,
    testable: false,
    async measure() { return { state: 'not_implemented', detail: null, version: null, path: null } },
  },
]

export function getCapability(key: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.find((c) => c.key === key)
}

/** CSAK ezeket a beallitasokat szabad a kepesseg-vegponton at irni. A lista a
 *  leirasokbol keszul, nem kezzel -- igy nem tud szetcsuszni a ketto. */
export function writableSettingKeys(): string[] {
  return CAPABILITIES.map((c) => c.setting_key).filter((k): k is string => !!k)
}

function settingOf(key: string): CapabilitySetting | null {
  const def = getSettingDefinition(key)
  if (!def) return null
  let raw = ''
  try { raw = String(getEffectiveSettingValue(key) ?? '') } catch { raw = '' }
  const secret = def.secret === true
  return {
    key,
    // TITOK SOSE MEGY KI a bongeszobe -- csak az, hogy van-e beallitva.
    value: secret ? null : raw,
    secret,
    configured: raw.trim().length > 0,
    label: {
      hu: key === 'WORKBENCH_LIBREOFFICE_PATH' ? 'A LibreOffice teljes útvonala (üresen: magától megkeresi)'
        : key === 'WORKBENCH_FFMPEG_PATH' ? 'Az FFmpeg teljes útvonala (üresen: magától megkeresi)'
        : key === 'WORKBENCH_ONLYOFFICE_URL' ? 'ONLYOFFICE Document Server címe (üresen: nem használjuk)'
        : key === 'WORKBENCH_ANTHROPIC_API_KEY' ? 'Saját Anthropic API-kulcs (üresen: a bejelentkezett előfizetés)'
        : key,
      en: key === 'WORKBENCH_LIBREOFFICE_PATH' ? 'Full path to LibreOffice (empty: found automatically)'
        : key === 'WORKBENCH_FFMPEG_PATH' ? 'Full path to FFmpeg (empty: found automatically)'
        : key === 'WORKBENCH_ONLYOFFICE_URL' ? 'ONLYOFFICE Document Server address (empty: not used)'
        : key === 'WORKBENCH_ANTHROPIC_API_KEY' ? 'Your own Anthropic API key (empty: the signed-in subscription)'
        : key,
    },
    placeholder: key === 'WORKBENCH_LIBREOFFICE_PATH' ? '/usr/bin/soffice'
      : key === 'WORKBENCH_FFMPEG_PATH' ? '/usr/bin/ffmpeg'
      : key === 'WORKBENCH_ONLYOFFICE_URL' ? 'http://localhost:8080'
      : key === 'WORKBENCH_ANTHROPIC_API_KEY' ? 'sk-ant-...'
      : '',
  }
}

/** EMBERI mondat az allapotrol. A `detail` (nyers hibauzenet) MELLE megy, nem
 *  helyette: a mondatot a felhasznalo olvassa, a reszletet a hibakereso. */
function stateMessage(c: CapabilityDescriptor, state: CapabilityState, lang: Lang, version: string | null): string {
  const affects = c.affects[lang]
  if (lang === 'en') {
    switch (state) {
      case 'ok': return version ? `Available (${version}).` : 'Available.'
      case 'not_installed': return `Not installed on this machine. ${affects} The steps below say how to get it.`
      case 'not_configured': return `Not set up yet. ${affects} The steps below say what to enter.`
      case 'check_failed': return 'It could not be determined whether this is available -- so this does NOT mean it is missing. The exact error is in the details.'
      case 'not_implemented': return `Not wired up in this version. ${affects}`
    }
  }
  switch (state) {
    case 'ok': return version ? `Elérhető (${version}).` : 'Elérhető.'
    case 'not_installed': return `Nincs telepítve ezen a gépen. ${affects} A lenti lépések megmondják, hogyan szerezheted be.`
    case 'not_configured': return `Még nincs beállítva. ${affects} A lenti lépések megmondják, mit kell megadni.`
    case 'check_failed': return 'Nem sikerült megállapítani, hogy elérhető-e -- ez tehát NEM azt jelenti, hogy hiányzik. A pontos hibaüzenet a részleteknél olvasható.'
    case 'not_implemented': return `Ebben a verzióban még nincs bekötve. ${affects}`
  }
}

export interface CapabilityRow {
  key: string
  tier: CapabilityTier
  title: string
  what_for: string
  affects: string
  how_to: string[]
  obtain_url: string | null
  optional: boolean
  available: boolean
  state: CapabilityState
  /** EMBERI mondat az allapotrol -- a kepernyore ez megy, nem a gepi kod. */
  message: string
  detail: string | null
  version: string | null
  path: string | null
  checked_at: number
  testable: boolean
  setting: CapabilitySetting | null
  [k: string]: unknown
}

/** Egy kepesseg megmerese + a felulet szamara osszerakott sor. */
export async function describeCapability(c: CapabilityDescriptor, lang: Lang, force = false): Promise<CapabilityRow> {
  let m: { state: CapabilityState; detail: string | null; version: string | null; path: string | null }
  try {
    m = await c.measure(force)
  } catch (e) {
    // A meres maga dolt el: ez `check_failed`, a VALODI hibauzenettel -- es
    // semmikepp nem "nincs telepitve".
    m = { state: 'check_failed', detail: (e as Error).message, version: null, path: null }
  }
  const row: CapabilityRow = {
    key: c.key,
    tier: c.tier,
    title: c.title[lang],
    what_for: c.what_for[lang],
    affects: c.affects[lang],
    how_to: c.how_to[lang],
    obtain_url: c.obtain_url,
    optional: c.tier !== 'core',
    available: m.state === 'ok',
    state: m.state,
    message: stateMessage(c, m.state, lang, m.version),
    detail: m.detail,
    version: m.version,
    path: m.path,
    checked_at: Date.now(),
    testable: c.testable,
    setting: c.setting_key ? settingOf(c.setting_key) : null,
  }
  if (c.extra) Object.assign(row, c.extra())
  return row
}

export async function describeAllCapabilities(lang: Lang, force = false): Promise<CapabilityRow[]> {
  const out: CapabilityRow[] = []
  for (const c of CAPABILITIES) out.push(await describeCapability(c, lang, force))
  return out
}

/** Csak tesztnek / „allitottal rajta" esetre. */
export function resetCapabilityProbes(): void {
  resetProbeCache()
}
