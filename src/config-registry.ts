// Single source of truth for settings the dashboard's "Beallitasok" page can
// show and edit. Each entry describes one .env-backed config key: its type
// (drives the input widget + validation), default, human description, the
// module it belongs to (drives UI grouping), whether it is secret (drives
// API redaction), and whether changing it needs a process restart to take
// effect (drives the UI warning badge).
//
// v1 scope is intentionally narrow: the 9 Kanban WIP keys. Extending this
// array is how a future setting becomes editable from the UI -- no route or
// frontend change needed beyond what already reads the registry.

// The model a fresh install runs when DEFAULT_AGENT_MODEL is unset. Kept here
// (a zero-import module) so the registry default and the boot-time constant in
// config.ts cannot drift apart -- bumping the distribution default is a
// one-line change in exactly one place.
export const DISTRIBUTION_DEFAULT_AGENT_MODEL = 'claude-opus-4-8[1m]'

export type SettingType = 'int' | 'string' | 'color' | 'boolean'

/**
 * WHAT has to be restarted for a changed value to take effect.
 *
 * Boss, 2026-08-16: "sokszor ujra lett mar inditva a marvin es megis itt vannak
 * ezek a sarga betuk." He was restarting the wrong thing, and the label could
 * not have told him otherwise -- it only ever said "after a restart", never
 * whose. Three different processes read these keys, and `requiresRestart: true`
 * flattens all three into one word.
 *
 *   'dashboard'          the control panel process itself (POST /api/system/restart)
 *   'main-agent'         only the main agent's channels session; restarting the
 *                        control panel does nothing at all for these
 *   'dashboard+agents'   the value is also baked into the agents' CLAUDE.md by
 *                        the scaffold, so each agent picks it up on ITS next start
 *   'dashboard+heartbeat' same, but only the heartbeat sub-agent is affected
 */
export type RestartTarget = 'dashboard' | 'main-agent' | 'dashboard+agents' | 'dashboard+heartbeat'

export interface SettingDefinition {
  key: string
  type: SettingType
  default: string | number
  description: string
  module: string
  secret: boolean
  requiresRestart: boolean
  /**
   * Required whenever requiresRestart is true (enforced by
   * src/__tests__/settings-restart-target.test.ts). Meaningless otherwise.
   */
  restartTarget?: RestartTarget
  /** Optional fixed set of allowed values (enum-style settings). */
  valueSet?: string[]
  /** Inclusive bounds, only meaningful for type 'int'. */
  min?: number
  max?: number
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    key: 'LIFE_TRASH_DAYS',
    type: 'int',
    default: 60,
    min: 0,
    max: 3650,
    description: 'Az Intéző Kukájában ennyi nap után magától véglegesen törlődnek a tételek. 0 = soha (csak kézzel).',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_PLANNED',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "planned" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_IN_PROGRESS',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'Az "in_progress" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_TESTING',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "testing" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WAITING',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "waiting" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_DONE',
    type: 'int',
    default: 0,
    min: 0,
    max: 100,
    description: 'A "done" oszlop WIP-limitje (max. kártyaszám). 0 = korlátlan.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WARN_PCT',
    type: 'int',
    default: 80,
    min: 1,
    max: 100,
    description: 'Kihasználtsági százalék, amely felett a WIP-badge sárgára vált. 0 nem értelmes (azonnali figyelmeztetés), ezért tiltott.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_OK_COLOR',
    type: 'color',
    default: '#6b7280',
    description: 'A WIP-badge színe, amikor az oszlop kihasználtsága a figyelmeztetési küszöb alatt van.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_WARN_COLOR',
    type: 'color',
    default: '#c9a000',
    description: 'A WIP-badge színe a figyelmeztetési küszöb (WARN_PCT) felett, limit előtt.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_FULL_COLOR',
    type: 'color',
    default: '#d46b00',
    description: 'A WIP-badge színe, amikor az oszlop pontosan a limiten áll.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_WIP_OVER_COLOR',
    type: 'color',
    default: '#c53030',
    description: 'A WIP-badge színe, amikor az oszlop túllépte a limitet.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- Kanban archiving (hot-reload via settings-store) ---
  {
    key: 'KANBAN_ARCHIVE_DONE_DAYS',
    type: 'int',
    default: 30,
    min: 1,
    max: 365,
    description: 'Ennyi napnál régebbi "done" kártyák automatikusan archiválódnak a listKanbanCards() hívásakor.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_ARCHIVED_MAX_ROWS',
    type: 'int',
    default: 500,
    min: 10,
    max: 5000,
    description: 'Az archivált kártya-nézetben egyszerre megjelenített kártyák maximális száma.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- Kanban aging thresholds and colours (hot-reload via settings-store) ---
  {
    key: 'KANBAN_AGING_WARN_H',
    type: 'int',
    default: 24,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után jelenik meg az első (sárga) aging-jelzés a kártyán.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CAUTION_H',
    type: 'int',
    default: 72,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után vált narancssárgára az aging-jelzés.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CRITICAL_H',
    type: 'int',
    default: 168,
    min: 1,
    max: 8760,
    description: 'Ennyi óra inaktivitás után vált pirosra (kritikus) az aging-jelzés.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_WARN_COLOR',
    type: 'color',
    default: '#c9a000',
    description: 'Az aging-badge színe a figyelmeztetési küszöbnél (warn).',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CAUTION_COLOR',
    type: 'color',
    default: '#d46b00',
    description: 'Az aging-badge színe az óvatossági küszöbnél (caution).',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_AGING_CRITICAL_COLOR',
    type: 'color',
    default: '#c53030',
    description: 'Az aging-badge színe a kritikus küszöbnél.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- Kanban swimlanes (hot-reload via settings-store) ---
  {
    key: 'KANBAN_SWIMLANE_DEFAULT_GROUP',
    type: 'string',
    default: 'none',
    valueSet: ['none', 'assignee', 'priority'],
    description: 'A tábla alapértelmezett csoportosítása betöltéskor. none = lapos nézet.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'KANBAN_SWIMLANE_SEPARATOR_COLOR',
    type: 'color',
    default: '#374151',
    description: 'Az swimlane-elválasztó fejléc háttérszíne.',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
  },
  // --- System module (requiresRestart -- read at process init) ---
  {
    key: 'DEPOT_AUTO_REMOUNT',
    type: 'boolean',
    default: '0',
    description: 'Ha a depó Windows-meghajtón van, és a WSL felé megszakad a '
      + 'kapcsolata (ismert WSL-hiba újraindítás után), a Marveen magától '
      + 'újracsatolja-e. Alapból KI: bekapcsolva a Marveennek jelszó nélküli '
      + 'jogot kell kapnia pontosan két parancsra (umount és mount, csak erre az '
      + 'egy csatolási pontra) – ezt egy sorral te veszed fel a /etc/sudoers.d/ '
      + 'alá, a Depó oldal végigvezet rajta. Amíg nem adtad meg, a kapcsoló '
      + 'bekapcsolva sem tud semmit: a javítás ilyenkor is a Depó oldalon '
      + 'másolható parancs marad. Kikapcsolva a Marveen soha nem futtat sudo-t.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MARVEEN_DEPOT',
    type: 'string',
    default: '',
    description: 'A depó mappája: ez alá kerül minden fájlod (fotók, Drive-fájlok, '
      + 'projektek), fiókonként külön mappába. Nem kell begépelned: a „Tallózás…” '
      + 'gombbal kiválaszthatod, ahogy egy fájlfeltöltésnél. Windows-alakban is '
      + 'megadható, pl. D:\\Marveen. Üresen hagyva minden a telepítési mappában '
      + 'marad. A meglévő fájlokat nem mozgatja el magától – ahhoz a Depó oldal '
      + '„Átköltöztetés a depóba” gombja kell.',
    module: 'system',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'DASHBOARD_PUBLIC_URL',
    type: 'string',
    default: '',
    description: 'A dashboard nyilvánosan elérhető URL-je (pl. https://marveen.example.com). Üres = nincs CORS whitelist bővítés.',
    module: 'system',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard+agents',
  },
  {
    key: 'OLLAMA_URL',
    type: 'string',
    default: 'http://localhost:11434',
    description: 'Az Ollama API alap-URL-je. Memória-embedding és modell-javaslat ezt használja.',
    module: 'system',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'DASHBOARD_LANG',
    type: 'string',
    default: 'hu',
    valueSet: ['hu', 'en'],
    description: 'A dashboard alapértelmezett megjelenítési nyelve (hu = magyar, en = angol). A böngészőben mentett preferencia (localStorage) felülírja.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  // --- Heartbeat module (hot-reload via settings-store) ---
  {
    key: 'HEARTBEAT_START_HOUR',
    type: 'int',
    default: 9,
    min: 0,
    max: 22,
    description: 'A heartbeat aktív időablakának kezdete (helyi idő, 0-22). Előtte nem küld értesítést.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'HEARTBEAT_END_HOUR',
    type: 'int',
    default: 23,
    min: 1,
    max: 24,
    description: 'A heartbeat aktív időablakának vége (helyi idő, 1-24). Ettől nem küld értesítést.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'HEARTBEAT_AGENT_ENABLED',
    type: 'string',
    default: '1',
    valueSet: ['0', '1'],
    description: 'Heartbeat sub-ágens engedélyezése. 1 = bekapcsolva.',
    module: 'heartbeat',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'HEARTBEAT_CALENDAR_ACCOUNT',
    type: 'string',
    default: '',
    description: 'Google Calendar fiók neve/e-mailje a heartbeat naptár-összefoglalóhoz. Üresen hagyva a heartbeat nem kérdez le naptáreseményeket.',
    module: 'heartbeat',
    secret: false,
    // Consumed as a boot-time const (src/config.ts) -- a saved override takes
    // effect on the next restart, and the UI must say so.
    requiresRestart: true,
    restartTarget: 'dashboard+heartbeat',
  },
  {
    key: 'HEARTBEAT_CALENDAR_ID',
    type: 'string',
    default: '',
    description: 'Google Calendar naptár-azonosítója a heartbeat összefoglalóhoz (pl. primary). Üresen hagyva a heartbeat nem kérdez le naptáreseményeket.',
    module: 'heartbeat',
    secret: false,
    // Boot-time const, see HEARTBEAT_CALENDAR_ACCOUNT above.
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'IDEA_BREAKDOWN_MAX_SUBTASKS',
    type: 'int',
    default: 10,
    min: 2,
    max: 20,
    description: 'Az "Kanbanra (AI)" ötlet-bontás során generált részfeladatok maximális száma.',
    module: 'ideabox',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'IDEA_STALE_DAYS',
    type: 'int',
    default: 7,
    min: 1,
    max: 365,
    description: 'Ennyi napnyi mozdulatlanság után kap "Elavult" jelzést egy "új" státuszú ötlet.',
    module: 'ideabox',
    secret: false,
    requiresRestart: false,
  },
  // --- Audit log module ---
  {
    key: 'AUDIT_LOG_RETENTION_DAYS',
    type: 'int',
    default: 90,
    min: 1,
    max: 3650,
    description: 'Az audit napló (config-változások, ötletláda-audit, store-fájl események) megőrzési ideje napokban. Régebbi bejegyzések a napi sweepkor törlődnek.',
    module: 'audit',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'AUDIT_LOG_MAX_ENTRIES',
    type: 'int',
    default: 10000,
    min: 100,
    max: 1000000,
    description: 'Az audit napló összes forrásra vetített maximális bejegyzésszáma. Az API lekérések ennél soha nem adnak vissza többet (forrásanként egyéni limit: AUDIT_LOG_MAX_ENTRIES / 3).',
    module: 'audit',
    secret: false,
    requiresRestart: false,
  },
  // --- Token usage module ---
  {
    key: 'TOKEN_USAGE_RETENTION_DAYS',
    type: 'int',
    default: 90,
    min: 7,
    max: 3650,
    description: 'A token-használati napló (token_usage tábla) megőrzési ideje napokban. A napi sweep ennél régebbi sorokat törli, így a tábla nem nő korlátlanul. A modell-javaslat csak az utolsó 30 napot nézi, így a 90 nap minden fogyasztónak bőven elég.',
    module: 'system',
    secret: false,
    requiresRestart: false,
  },
  // --- Channels module ---
  {
    key: 'MAIN_AGENT_ISOLATED_CONFIG',
    type: 'boolean',
    default: '0',
    description: 'Bármely platformon: a fő channels-agent kapjon-e saját, izolált CLAUDE_CONFIG_DIR-t (mint a sub-agentek). Bekapcsolva a fő agent a hosszú élettartamú fleet setup-tokenből (store/.claude-oauth-token) hitelesít, nem a megosztott, önmagát frissítő session-hitelesítésből (macOS: rotálódó Keychain OAuth-session; Linux: megosztott ~/.claude/.credentials.json) -- mindkettő periodikusan lejár, és a lejárt fájl a Claude Code precedencia miatt akkor is nyer az érvényes env-tokennel szemben, ha az élő token ott van mellette (2026-07-23 kiesés). Token hiányában no-op. A módosítás a channels session újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
    restartTarget: 'main-agent',
  },
  {
    key: 'MAIN_AGENT_CONFIG_DIR',
    type: 'string',
    default: '',
    description: 'A fő channels-agent explicit CLAUDE_CONFIG_DIR-je (pl. ~/.claude-bot). Akkor kell, ha a botnak SAJÁT Claude-loginja van, külön a flottáétól: a MAIN_AGENT_ISOLATED_CONFIG erre nem alkalmas, mert az a fleet setup-tokenből hitelesít, tehát a flotta identitását adja a botnak (és token nélkül no-op). Üresen hagyva a fő agent a közös ~/.claude-ot használja (alapértelmezés). Ha a megadott könyvtár nem létezik, a beállítás no-op és figyelmeztetést logol. Elsőbbséget élvez a MAIN_AGENT_ISOLATED_CONFIG-gal szemben. A módosítás a channels session újraindításakor lép életbe.',
    module: 'channels',
    secret: false,
    requiresRestart: true,
    restartTarget: 'main-agent',
  },
  // --- System module ---
  {
    key: 'SCHEDULER_TZ',
    type: 'string',
    default: '',
    description: 'A telepítés időzónája (IANA, pl. Europe/Budapest). EGY zóna vezérli az ütemezést (cron) ÉS minden megjelenített időt (heartbeat, napi napló, memória-címkék). Üresen hagyva a gép saját időzónáját használja. A módosítás a szolgáltatás újraindításakor lép életbe.',
    module: 'system',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard+agents',
    valueSet: ['Europe/London', 'Europe/Budapest', 'UTC', 'Europe/Dublin', 'Europe/Berlin', 'Europe/Bucharest', 'America/New_York'],
  },
  {
    key: 'DEFAULT_AGENT_MODEL',
    type: 'string',
    default: DISTRIBUTION_DEFAULT_AGENT_MODEL,
    description: 'Az ÚJ ügynökök alapértelmezett modellje, egyben a háttér-worker sessionök modellje. Ez NEM a fő ügynök (Marvin) modellje — azt eggyel lejjebb, a MAIN_AGENT_MODEL állítja. Meglévő ügynökök NEM változnak: akinek az agent-config.json-jában konkrét modell van, az marad. A módosítás a szolgáltatás újraindításakor lép életbe.',
    module: 'agents',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
    valueSet: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8[1m]',
      'claude-haiku-4-5-20251001',
    ],
  },
  // Boss, 2026-08-16: "a beallitas agent alatt a sonett 5 van beallitva.
  // marvinnak. akkor miert meg mindig a haiku van?"
  //
  // Mert a fenti kulcs az UJ ugynokoke, a fo ugynok modellje pedig sehol nem
  // volt allithato a Beallitasok oldalrol: csak a telepito varazslo .env-mezoje
  // ismerte (MAIN_AGENT_MODEL), az Ugynokok oldalon Marvin modell-valasztoja
  // pedig szandekosan csak olvashato. Aki a Beallitasoknal kereste, egy olyan
  // kapcsolot talalt, ami rá sosem vonatkozott -- es semmilyen ujrainditas nem
  // segitett volna rajta.
  //
  // Hogy a mentes ne csak latszolag mukodjon, HAROM helyen kellett osszekotni:
  // readConfiguredMainModel() (vezerlopult) es a channels.sh resolve_main_model()
  // (indito) is olvassa mostantol a store/config-overrides.json-t, ugyanazon a
  // sorrenden -- kulonben a mentett ertek sehova nem jutna el.
  {
    key: 'MAIN_AGENT_MODEL',
    type: 'string',
    default: '',
    description: 'A fő ügynök (Marvin) modellje. Ezt a channels session induláskor olvassa be, tehát a mentés után Marvint kell újraindítani — a sor melletti gombbal. Üresen hagyva a telepítés saját beállítása marad érvényben (.env MAIN_AGENT_MODEL, annak hiányában a .claude/settings.json „model" értéke). Figyelem: az al-ügynökök modelljét ez NEM változtatja meg — az a fenti DEFAULT_AGENT_MODEL, illetve ügynökönként az Ügynökök oldalon áll.',
    module: 'agents',
    secret: false,
    requiresRestart: true,
    restartTarget: 'main-agent',
    valueSet: [
      '',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-opus-4-8[1m]',
      'claude-haiku-4-5-20251001',
    ],
  },
  // --- Debate module (multi-model cross-check via scripts/debate.mjs) ---
  // Neither entry needs requiresRestart: debate.mjs is a one-shot CLI the
  // main agent invokes fresh each time (no long-lived process to restart),
  // it just reads these via GET /api/settings before deciding what to pass
  // on the command line. The OpenRouter API key itself is NOT here -- it's
  // secret, so it lives in the Vault page like every other API credential,
  // never duplicated into this registry (see settings.ts route comment).
  {
    key: 'DEBATE_MODELS',
    type: 'string',
    default: '',
    description: 'A vitáztatáshoz használt OpenRouter modell-azonosítók, vesszővel elválasztva (pl. "openai/gpt-5,x-ai/grok-4,google/gemini-3-pro"). Üresen hagyva a fő-agens minden vitáztatás-kérésnél megkérdezi, melyik modelleket használja.',
    module: 'debate',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'DEBATE_MAX_ROUNDS',
    type: 'int',
    default: 4,
    min: 1,
    max: 10,
    description: 'Hány kör után adja fel a fő-agens az egyetértés keresését egy vitáztatásnál, ha a modellek addig nem jutnak konszenzusra. Minden kör = N valódi API-hívás, ezért van felső korlát.',
    module: 'debate',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'DEBATE_LOG_MAX_MB',
    type: 'int',
    default: 20,
    min: 1,
    max: 500,
    description: 'A vitaelőzmények naplójának (store/debate-log.jsonl) legnagyobb mérete megabájtban. Ha a napló ezt túllépi, a legrégebbi vita-körök automatikusan törlődnek elölről (önmagát tisztító, "körkörös" napló) -- az újak mindig megmaradnak.',
    module: 'debate',
    secret: false,
    requiresRestart: false,
  },

  // --- Hang (beszédfelismerés) modul -------------------------------------
  // Boss 2026-08-09: a hangfelismerés minden kapcsolója kódban vagy .env-ben ült,
  // és semmi nem mutatta meg, MI fut éppen. Ezek a bejegyzések teszik láthatóvá és
  // állíthatóvá őket a Beállítások alatt egy "hang" fülön.
  //
  // ⚠️A `scripts/voice/_vtools.py` egy KÜLÖN folyamat, ami eredetileg csak az
  // `os.environ`-t nézte -- a Beállítások viszont a `store/config-overrides.json`-be
  // ír. Ezért a szkript kapott egy `_setting()` hidat, ami ugyanazt a fájlt olvassa.
  // Enélkül ezek a beállítások megjelennének, mentődnének, ÉS SEMMIT NEM CSINÁLNÁNAK.
  {
    key: 'MARVEEN_STT_ENGINE',
    type: 'string',
    default: 'auto',
    valueSet: ['auto', 'groq', 'local'],
    description: 'Melyik motor írja át a Telegram hangüzeneteket. "auto" = előbb a Groq felhő, ha az nem elérhető, a gépen futó helyi motor (ez az ajánlott). "groq" = csak felhő, helyi tartalék nélkül. "local" = a hang SOHA nem hagyja el a gépet (lassabb: a CPU-s átírás nagyjából a hanghossz 1,5-szerese).',
    module: 'hang',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'GROQ_STT_MODEL',
    type: 'string',
    default: 'whisper-large-v3',
    valueSet: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    description: 'A felhőben futó Whisper modell. A Groq saját adatai szerint a teljes "whisper-large-v3" hibaaránya 10,3%, a "turbo"-é 12% -- vagyis a turbo nagyjából 17%-kal többet téveszt, miközben a sebességkülönbség (189x vs 216x valós idő) egy hangüzenetnél észrevehetetlen. Ezért a pontos az alapértelmezés.',
    module: 'hang',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MARVEEN_STT_MODEL_SHORT',
    type: 'string',
    default: 'medium',
    valueSet: ['tiny', 'base', 'small', 'medium', 'large-v3'],
    description: 'A HELYI motor modellje RÖVID hangüzenetekhez (a küszöb alatt). Nagyobb modell = pontosabb, de lassabb: a processzoron az átírás nagyjából a hanghossz 1,5-szerese, és ez modellmérettel nő. Csak akkor számít, ha a helyi ág fut (nincs net, vagy a motor "local").',
    module: 'hang',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MARVEEN_STT_MODEL_LONG',
    type: 'string',
    default: 'medium',
    valueSet: ['tiny', 'base', 'small', 'medium', 'large-v3'],
    description: 'A HELYI motor modellje HOSSZÚ hangüzenetekhez (a küszöb felett). Itt érdemes kisebbet választani, különben egy hosszabb üzenetre percekig kellene várni.',
    module: 'hang',
    secret: false,
    requiresRestart: false,
  },
  {
    key: 'MARVEEN_STT_THRESHOLD',
    type: 'int',
    default: 10,
    min: 1,
    max: 600,
    description: 'Hány másodperctől számít "hosszúnak" egy hangüzenet a helyi motornál. Ez alatt a RÖVID, felette a HOSSZÚ modell fut.',
    module: 'hang',
    secret: false,
    requiresRestart: false,
  },
  // --- Kod-hid (VS Code Claude Code) module ---
  // These five were reachable ONLY by hand-editing .env, which means a fresh
  // install could not turn the bridge on from the surface at all. Registering
  // them here is what makes them editable from Beallitasok AND from the
  // Kod-hid page (which writes through setOverride, same validation).
  {
    key: 'CODE_BRIDGE_ENABLED',
    type: 'boolean',
    default: '1',
    description: 'A kod-hid fokapcsoloja. Kikapcsolva minden /api/code/* vegpont 503-at ad, a sor nem mozdul, es a Windows-oldali worker nem kap munkat. A mar felvett feladatok nem vesznek el, csak varnak.',
    module: 'kodhid',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'CODE_PERMISSION_MODE',
    type: 'string',
    default: 'acceptEdits',
    valueSet: ['acceptEdits', 'bypassPermissions', 'default', 'plan'],
    description: 'Milyen jogosultsaggal fut a claude.exe a feladat kozben. Az "acceptEdits" a bevalt alapertek: a fajlszerkesztest engedi (kulonben minden feladat elakadna egy meg nem valaszolhato kerdesen), de a veszelyes muveleteknel marad a kapu. A "bypassPermissions" teljes autonomiat ad -- tudatos, kezi dontes legyen.',
    module: 'kodhid',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'CODE_BOT_TOKEN',
    type: 'string',
    default: '',
    description: 'A DEDIKALT Telegram kod-bot tokenje (BotFather -> /newbot). Azert kell sajat bot, mert egy tokent egyszerre egy getUpdates fogyaszto olvashat, es a fo bot slotjat Marvin csatorna-pluginje birtokolja (masodik olvaso = 409 Conflict). Uresen hagyva minden mas mukodik, csak Telegramrol nem lehet kozvetlenul feladni.',
    module: 'kodhid',
    secret: true,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'CODE_BOT_ALLOWED_CHAT_IDS',
    type: 'string',
    default: '',
    description: 'Vesszovel elvalasztott chat-azonositok, amelyek hasznalhatjak a kod-botot. Uresen hagyva csak a tulajdonos chatje. Ismeretlen chat uzenetere nincs valasz -- meg hibauzenet sem, ami elarulna, hogy a bot letezik.',
    module: 'kodhid',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
  {
    key: 'CODE_BRIDGE_EXCLUDE',
    type: 'string',
    default: '',
    description: 'Vesszos alias-lista, amit a hid SOHA nem regisztral es nem fogad el. Ide az a workspace valo, amelyikben eppen beszelgetsz: kulonben a felderites ujra bejegyzi, es egy feladat a nyitott panel ala irna.',
    module: 'kodhid',
    secret: false,
    requiresRestart: true,
    restartTarget: 'dashboard',
  },
]

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_REGISTRY.find((s) => s.key === key)
}

export function listSettingModules(): string[] {
  return [...new Set(SETTINGS_REGISTRY.map((s) => s.module))]
}

export interface SettingValidationResult {
  ok: boolean
  error?: string
  /** Normalised value (e.g. parsed int) to persist when ok === true. */
  value?: string | number
}

// Pure validation against a single registry entry. No I/O, no DB -- callers
// (the /api/settings route, tests) decide what happens with the result.
export function validateSettingValue(def: SettingDefinition, raw: unknown): SettingValidationResult {
  if (def.valueSet && def.valueSet.length > 0) {
    const str = String(raw)
    if (!def.valueSet.includes(str)) {
      return { ok: false, error: `Érvénytelen érték. Megengedett: ${def.valueSet.join(', ')}` }
    }
    return { ok: true, value: str }
  }

  if (def.type === 'boolean') {
    // Normalise any of true/false, 1/0, "1"/"0", "true"/"false" to the
    // canonical "1"/"0" string so it round-trips through .env and the bash
    // launcher (which compares against "1") identically.
    const s = String(raw).trim().toLowerCase()
    if (raw === true || s === '1' || s === 'true') return { ok: true, value: '1' }
    if (raw === false || s === '0' || s === 'false' || s === '') return { ok: true, value: '0' }
    return { ok: false, error: 'Logikai érték szükséges (be/ki).' }
  }

  if (def.type === 'int') {
    const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
    if (!Number.isInteger(n)) return { ok: false, error: 'Egész szám szükséges.' }
    if (def.min !== undefined && n < def.min) return { ok: false, error: `Az érték legalább ${def.min} lehet.` }
    if (def.max !== undefined && n > def.max) return { ok: false, error: `Az érték legfeljebb ${def.max} lehet.` }
    return { ok: true, value: n }
  }

  if (def.type === 'color') {
    const str = String(raw)
    if (!HEX_COLOR_RE.test(str)) return { ok: false, error: 'Érvénytelen szín (várható formátum: #rrggbb).' }
    return { ok: true, value: str }
  }

  // 'string'
  return { ok: true, value: String(raw) }
}
