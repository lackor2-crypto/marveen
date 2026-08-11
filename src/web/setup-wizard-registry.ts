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
    id: 'owner-name',
    group: 'identity',
    kind: 'env',
    envKey: 'OWNER_NAME',
    labelKey: 'wizard.item.owner_name',
    descKey: 'wizard.item.owner_name_desc',
    required: true,
    placeholder: 'Géza',
  },
  {
    id: 'bot-name',
    group: 'identity',
    kind: 'env',
    envKey: 'BOT_NAME',
    labelKey: 'wizard.item.bot_name',
    descKey: 'wizard.item.bot_name_desc',
    required: true,
    placeholder: 'Marveen',
  },
  {
    id: 'brand-name',
    group: 'identity',
    kind: 'env',
    envKey: 'BRAND_NAME',
    labelKey: 'wizard.item.brand_name',
    descKey: 'wizard.item.brand_name_desc',
    required: false,
    placeholder: 'Marveen',
  },
  {
    id: 'claude-auth',
    group: 'identity',
    kind: 'external',
    labelKey: 'wizard.item.claude_auth',
    descKey: 'wizard.item.claude_auth_desc',
    required: true,
  },
  {
    id: 'telegram-token',
    group: 'channel',
    kind: 'secret',
    envKey: 'TELEGRAM_BOT_TOKEN',
    labelKey: 'wizard.item.telegram_token',
    descKey: 'wizard.item.telegram_token_desc',
    required: false,
    placeholder: '123456:ABC-DEF...',
  },
  {
    id: 'telegram-pairing',
    group: 'channel',
    kind: 'external',
    labelKey: 'wizard.item.telegram_pairing',
    descKey: 'wizard.item.telegram_pairing_desc',
    required: false,
  },
  {
    id: 'google-oauth',
    group: 'google',
    kind: 'external',
    labelKey: 'wizard.item.google_oauth',
    descKey: 'wizard.item.google_oauth_desc',
    required: false,
  },
  {
    id: 'calendar-id',
    group: 'google',
    kind: 'env',
    envKey: 'HEARTBEAT_CALENDAR_ID',
    labelKey: 'wizard.item.calendar_id',
    descKey: 'wizard.item.calendar_id_desc',
    required: false,
    placeholder: 'primary',
  },
  {
    id: 'drive-folder',
    group: 'google',
    kind: 'env',
    envKey: 'OWNER_DRIVE_FOLDER',
    labelKey: 'wizard.item.drive_folder',
    descKey: 'wizard.item.drive_folder_desc',
    required: false,
  },
  {
    id: 'window-backup-repo',
    group: 'backup',
    kind: 'env',
    envKey: 'WINDOW_BACKUP_REPO_URL',
    labelKey: 'wizard.item.window_backup',
    descKey: 'wizard.item.window_backup_desc',
    required: false,
    placeholder: 'https://github.com/<account>/<repo>.git',
  },
  {
    id: 'github-push-account',
    group: 'backup',
    kind: 'env',
    envKey: 'GITHUB_PUSH_ACCOUNT',
    labelKey: 'wizard.item.github_account',
    descKey: 'wizard.item.github_account_desc',
    required: false,
  },
  {
    id: 'auto-update',
    group: 'maintenance',
    kind: 'env',
    envKey: 'AUTO_UPDATE_ENABLED',
    labelKey: 'wizard.item.auto_update',
    descKey: 'wizard.item.auto_update_desc',
    required: false,
    placeholder: '0',
  },
  {
    id: 'main-agent-model',
    group: 'models',
    kind: 'env',
    envKey: 'MAIN_AGENT_MODEL',
    labelKey: 'wizard.item.main_model',
    descKey: 'wizard.item.main_model_desc',
    required: false,
    placeholder: 'claude-opus-5',
  },
  {
    id: 'ollama-url',
    group: 'models',
    kind: 'env',
    envKey: 'OLLAMA_URL',
    labelKey: 'wizard.item.ollama',
    descKey: 'wizard.item.ollama_desc',
    required: false,
    placeholder: 'http://localhost:11434',
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

  return {
    items,
    missingRequired: items.filter(i => i.required && !i.configured).length,
    availableUnused: items.filter(i => !i.required && !i.configured).length,
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
