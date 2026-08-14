// What Marveen can do, and whether THIS install has been told how.
//
// Boss, 2026-08-11, right after the hardcoded-identity sweep: "vajon a marveen
// rendszer szolni fog hogy ez nincs beallitva es hogy itt alitsd be? vagy a
// beallitasokban ott van hogy ezeket kezzel lehessen allitani? [...] mi lenne
// ha egy telepitesvarazslot tennenk a beallitasok ala es ott azt futtatva a
// user mindent beallithatna? mindent amit tud a marveen de meg nincs
// beallitva!"
//
// The question follows directly from that sweep. Making a value configurable
// per install fixes the portability bug, but it also creates a NEW way to fail:
// the feature now sits there doing nothing, and nothing tells the operator why.
// A fresh install has no idea the Windows backup exists, let alone that it
// needs a repo URL. This registry is the answer -- one declarative list of
// every capability, what configures it, and how to tell whether it is
// configured, so the dashboard can show the whole picture and walk the operator
// through the gaps.
//
// Deliberately DATA, not UI: the wizard route reads it, the tests read it, and
// adding a capability later means adding one entry rather than touching a
// screen. Keeping it a pure module (no fs, no env access) is what lets the
// tests exercise the classification without a live install.

/** How a capability gets configured, which decides what the wizard renders. */
export type SetupItemKind =
  /** A plain .env key the wizard can write directly. */
  | 'env'
  /** A secret .env key: writable, but never sent back to the browser. */
  | 'secret'
  /** Configured outside .env (a login, a file drop). The wizard explains, and links. */
  | 'external'

export interface SetupItem {
  id: string
  /** Settings group this belongs to, used to order the wizard's steps. */
  group: 'identity' | 'channel' | 'google' | 'backup' | 'maintenance' | 'models'
  kind: SetupItemKind
  /** .env key this writes, when kind is 'env' or 'secret'. */
  envKey?: string
  /** i18n key for the human label. */
  labelKey: string
  /** i18n key for the one-line explanation of what the capability gives you. */
  descKey: string
  /**
   * Whether the install is broken without it. `required` items are what a
   * first-run wizard must not let you skip; the rest are genuinely optional
   * capabilities, and the wizard says so rather than nagging.
   */
  required: boolean
  /**
   * How loudly a missing item may shout.
   *
   * Boss, 2026-08-11, after three missing EXTRAS painted the Overview
   * blood-red with a black button: it read as "the system is broken" when
   * nothing was wrong. Colour is information, and spending alarm-red on a
   * convenience feature teaches the operator to ignore red.
   */
  tier: 'essential' | 'recommended' | 'extra'
  /**
   * Plain-language answer to "what is this and why would I want it?" -- no
   * jargon, and it must say what happens if the operator skips it. The user
   * is not a programmer; see the user-is-not-a-programmer skill.
   */
  helpKey: string
  /** Numbered, do-this-then-that instructions for obtaining the value. */
  stepKeys?: string[]
  /**
   * Real, clickable destinations. "See the description" with nothing to click
   * is what this replaces -- if we send someone to a website, we link it.
   */
  links?: Array<{ url: string; labelKey: string }>
  /** A concrete example of the value, shown as "looks like this". */
  exampleKey?: string
  /** Example value shown as the input placeholder, never a real one. */
  placeholder?: string
}

/**
 * The capability list.
 *
 * Ordered the way a new operator meets them: who you are, how you reach the
 * assistant, then the optional powers. A capability that cannot be configured
 * from a form (a Claude login, an OAuth client file) is still listed as
 * 'external' -- leaving it out would tell the operator the install is complete
 * when the biggest piece is missing.
 */
export const SETUP_ITEMS: SetupItem[] = [
  {
    id: 'owner-name', group: 'identity', kind: 'env', envKey: 'OWNER_NAME',
    labelKey: 'wizard.item.owner_name', descKey: 'wizard.item.owner_name_desc',
    helpKey: 'wizard.item.owner_name_help', exampleKey: 'wizard.item.owner_name_example',
    required: true, tier: 'essential', placeholder: 'Géza',
  },
  {
    id: 'bot-name', group: 'identity', kind: 'env', envKey: 'BOT_NAME',
    labelKey: 'wizard.item.bot_name', descKey: 'wizard.item.bot_name_desc',
    helpKey: 'wizard.item.bot_name_help', exampleKey: 'wizard.item.bot_name_example',
    required: true, tier: 'essential', placeholder: 'Marveen',
  },
  {
    id: 'claude-auth', group: 'identity', kind: 'external',
    labelKey: 'wizard.item.claude_auth', descKey: 'wizard.item.claude_auth_desc',
    helpKey: 'wizard.item.claude_auth_help',
    stepKeys: ['wizard.item.claude_auth_step1', 'wizard.item.claude_auth_step2', 'wizard.item.claude_auth_step3'],
    links: [{ url: 'https://claude.ai/login', labelKey: 'wizard.link.claude_login' }],
    required: true, tier: 'essential',
  },
  {
    id: 'brand-name', group: 'identity', kind: 'env', envKey: 'BRAND_NAME',
    labelKey: 'wizard.item.brand_name', descKey: 'wizard.item.brand_name_desc',
    helpKey: 'wizard.item.brand_name_help', exampleKey: 'wizard.item.brand_name_example',
    required: false, tier: 'extra', placeholder: 'Marveen',
  },
  {
    id: 'telegram-token', group: 'channel', kind: 'secret', envKey: 'TELEGRAM_BOT_TOKEN',
    labelKey: 'wizard.item.telegram_token', descKey: 'wizard.item.telegram_token_desc',
    helpKey: 'wizard.item.telegram_token_help',
    stepKeys: [
      'wizard.item.telegram_token_step1', 'wizard.item.telegram_token_step2',
      'wizard.item.telegram_token_step3', 'wizard.item.telegram_token_step4',
    ],
    links: [{ url: 'https://t.me/BotFather', labelKey: 'wizard.link.botfather' }],
    exampleKey: 'wizard.item.telegram_token_example',
    required: false, tier: 'recommended', placeholder: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
  },
  {
    id: 'telegram-pairing', group: 'channel', kind: 'external',
    labelKey: 'wizard.item.telegram_pairing', descKey: 'wizard.item.telegram_pairing_desc',
    helpKey: 'wizard.item.telegram_pairing_help',
    stepKeys: ['wizard.item.telegram_pairing_step1', 'wizard.item.telegram_pairing_step2', 'wizard.item.telegram_pairing_step3'],
    required: false, tier: 'recommended',
  },
  {
    id: 'google-oauth', group: 'google', kind: 'external',
    labelKey: 'wizard.item.google_oauth', descKey: 'wizard.item.google_oauth_desc',
    helpKey: 'wizard.item.google_oauth_help',
    stepKeys: [
      'wizard.item.google_oauth_step1', 'wizard.item.google_oauth_step2',
      'wizard.item.google_oauth_step3', 'wizard.item.google_oauth_step4',
      'wizard.item.google_oauth_step5',
    ],
    links: [{ url: 'https://console.cloud.google.com/apis/credentials', labelKey: 'wizard.link.google_console' }],
    required: false, tier: 'recommended',
  },
  {
    // The step AFTER the OAuth client file, and the one that was invisible until
    // now: the client file only makes authorization POSSIBLE -- until an address
    // is actually connected, there is no mail, no Drive and no calendar. A fresh
    // install had no way to learn that, because the connect flow lived in a
    // terminal (Boss, 2026-08-14). It is not an env key and not a form, so it is
    // 'external' and points at the page that runs the flow.
    id: 'google-accounts', group: 'google', kind: 'external',
    labelKey: 'wizard.item.google_accounts', descKey: 'wizard.item.google_accounts_desc',
    helpKey: 'wizard.item.google_accounts_help',
    stepKeys: [
      'wizard.item.google_accounts_step1', 'wizard.item.google_accounts_step2',
      'wizard.item.google_accounts_step3', 'wizard.item.google_accounts_step4',
    ],
    // Step 4 is here because of what happened on the very first attempt (Boss,
    // 2026-08-14): Google refused the address with 403 access_denied, since the
    // OAuth app is in "Testing" status and admits only listed test users. It is
    // not an error anyone can debug from this page, and it happens at INSTALL
    // time, to the second address at the latest -- so the wizard says it before
    // it bites, and the Accounts page walks through the fix when it does.
    required: false, tier: 'recommended',
  },
  {
    id: 'calendar-id', group: 'google', kind: 'env', envKey: 'HEARTBEAT_CALENDAR_ID',
    labelKey: 'wizard.item.calendar_id', descKey: 'wizard.item.calendar_id_desc',
    helpKey: 'wizard.item.calendar_id_help',
    stepKeys: ['wizard.item.calendar_id_step1', 'wizard.item.calendar_id_step2'],
    links: [{ url: 'https://calendar.google.com/calendar/r/settings', labelKey: 'wizard.link.google_calendar' }],
    exampleKey: 'wizard.item.calendar_id_example',
    required: false, tier: 'recommended', placeholder: 'primary',
  },
  {
    id: 'drive-folder', group: 'google', kind: 'env', envKey: 'OWNER_DRIVE_FOLDER',
    labelKey: 'wizard.item.drive_folder', descKey: 'wizard.item.drive_folder_desc',
    helpKey: 'wizard.item.drive_folder_help',
    stepKeys: ['wizard.item.drive_folder_step1', 'wizard.item.drive_folder_step2', 'wizard.item.drive_folder_step3'],
    links: [{ url: 'https://drive.google.com', labelKey: 'wizard.link.google_drive' }],
    exampleKey: 'wizard.item.drive_folder_example',
    required: false, tier: 'extra',
  },
  {
    id: 'window-backup-repo', group: 'backup', kind: 'env', envKey: 'WINDOW_BACKUP_REPO_URL',
    labelKey: 'wizard.item.window_backup', descKey: 'wizard.item.window_backup_desc',
    helpKey: 'wizard.item.window_backup_help',
    stepKeys: ['wizard.item.window_backup_step1', 'wizard.item.window_backup_step2', 'wizard.item.window_backup_step3'],
    links: [{ url: 'https://github.com/new', labelKey: 'wizard.link.github_new_repo' }],
    exampleKey: 'wizard.item.window_backup_example',
    required: false, tier: 'extra', placeholder: 'https://github.com/<fiok>/<repo>.git',
  },
  {
    id: 'github-push-account', group: 'backup', kind: 'env', envKey: 'GITHUB_PUSH_ACCOUNT',
    labelKey: 'wizard.item.github_account', descKey: 'wizard.item.github_account_desc',
    helpKey: 'wizard.item.github_account_help',
    stepKeys: ['wizard.item.github_account_step1', 'wizard.item.github_account_step2'],
    links: [{ url: 'https://github.com/settings/profile', labelKey: 'wizard.link.github_profile' }],
    exampleKey: 'wizard.item.github_account_example',
    required: false, tier: 'extra',
  },
  {
    id: 'auto-update', group: 'maintenance', kind: 'env', envKey: 'AUTO_UPDATE_ENABLED',
    labelKey: 'wizard.item.auto_update', descKey: 'wizard.item.auto_update_desc',
    helpKey: 'wizard.item.auto_update_help', exampleKey: 'wizard.item.auto_update_example',
    required: false, tier: 'extra', placeholder: '0',
  },
  {
    id: 'main-agent-model', group: 'models', kind: 'env', envKey: 'MAIN_AGENT_MODEL',
    labelKey: 'wizard.item.main_model', descKey: 'wizard.item.main_model_desc',
    helpKey: 'wizard.item.main_model_help', exampleKey: 'wizard.item.main_model_example',
    required: false, tier: 'extra', placeholder: 'claude-opus-5',
  },
  {
    id: 'ollama-url', group: 'models', kind: 'env', envKey: 'OLLAMA_URL',
    labelKey: 'wizard.item.ollama', descKey: 'wizard.item.ollama_desc',
    helpKey: 'wizard.item.ollama_help',
    stepKeys: ['wizard.item.ollama_step1', 'wizard.item.ollama_step2'],
    links: [{ url: 'https://ollama.com/download', labelKey: 'wizard.link.ollama_download' }],
    exampleKey: 'wizard.item.ollama_example',
    required: false, tier: 'extra', placeholder: 'http://localhost:11434',
  },
]

/** The wizard's view of one capability, with this install's state filled in. */
export interface SetupItemState extends SetupItem {
  configured: boolean
  /**
   * Current value, for non-secret env items only. A secret's value never
   * leaves the server -- `configured` already answers the only question the
   * browser needs to ask about it.
   */
  value?: string
}

export interface SetupSummary {
  items: SetupItemState[]
  /** Required capabilities still missing. Non-empty means the install is incomplete. */
  missingRequired: number
  /** Optional capabilities not yet set up -- things Marveen could do but is not doing. */
  availableUnused: number
  /** Missing count per tier, so the UI can colour by the worst one rather than by any gap at all. */
  missingByTier: { essential: number; recommended: number; extra: number }
  /**
   * The loudest colour this install has earned. 'none' means nothing is
   * missing; 'extra' must never be shown in an alarm colour.
   */
  worstTier: 'none' | 'extra' | 'recommended' | 'essential'
}

/**
 * Classify every capability against this install.
 *
 * @param envValues    current .env contents (caller reads the file)
 * @param externalState  configured-ness of the items that live outside .env
 */
export function buildSetupSummary(
  envValues: Record<string, string>,
  externalState: Record<string, boolean>,
): SetupSummary {
  const items: SetupItemState[] = SETUP_ITEMS.map((item) => {
    if (item.kind === 'external') {
      return { ...item, configured: externalState[item.id] === true }
    }
    const raw = (item.envKey ? envValues[item.envKey] : undefined) ?? ''
    const configured = raw.trim().length > 0
    // A secret reports only whether it is set. Echoing a bot token back into
    // the page would put it in the DOM, in the browser cache, and in any
    // screenshot of this screen.
    if (item.kind === 'secret') return { ...item, configured }
    return { ...item, configured, value: raw }
  })

  const missing = items.filter(i => !i.configured)
  const missingByTier = {
    essential: missing.filter(i => i.tier === 'essential').length,
    recommended: missing.filter(i => i.tier === 'recommended').length,
    extra: missing.filter(i => i.tier === 'extra').length,
  }
  const worstTier: SetupSummary['worstTier'] =
    missingByTier.essential > 0 ? 'essential'
      : missingByTier.recommended > 0 ? 'recommended'
        : missingByTier.extra > 0 ? 'extra'
          : 'none'

  return {
    items,
    missingRequired: items.filter(i => i.required && !i.configured).length,
    availableUnused: items.filter(i => !i.required && !i.configured).length,
    missingByTier,
    worstTier,
  }
}

/** Env keys the wizard is allowed to write. Anything else is rejected. */
export function writableEnvKeys(): Set<string> {
  return new Set(
    SETUP_ITEMS.filter(i => i.kind === 'env' || i.kind === 'secret')
      .map(i => i.envKey!)
      .filter(Boolean),
  )
}
