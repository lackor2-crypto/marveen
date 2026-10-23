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

import { EMBED_MODEL } from '../embedding-model.js'

/** How a capability gets configured, which decides what the wizard renders. */
export type SetupItemKind =
  /** A plain .env key the wizard can write directly. */
  | 'env'
  /** A secret .env key: writable, but never sent back to the browser. */
  | 'secret'
  /** Configured outside .env (a login, a file drop). The wizard explains, and links. */
  | 'external'
  /**
   * A secret that lives in the Vault, not in .env (an API key the code reads through getSecret()).
   * Writable from the wizard, never sent back to the browser; `vaultIds[0]` is the entry it writes.
   */
  | 'vault'

export interface SetupItem {
  id: string
  /** Settings group this belongs to, used to order the wizard's steps. */
  group: 'identity' | 'channel' | 'google' | 'backup' | 'maintenance' | 'models' | 'integrations'
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
   * Values substituted into the step sentences ({name} placeholders).
   *
   * A step that names a CONSTANT of this install -- the embedding model, a
   * port, a directory -- must take it from the code, not from the translation:
   * the sentence would otherwise keep advising the old value in every language
   * after a fork changed it, with every test still green (kanban 5d0dfdc7).
   */
  stepParams?: Record<string, string>
  /**
   * Real, clickable destinations. "See the description" with nothing to click
   * is what this replaces -- if we send someone to a website, we link it.
   */
  links?: Array<{ url: string; labelKey: string }>
  /** A concrete example of the value, shown as "looks like this". */
  exampleKey?: string
  /** Example value shown as the input placeholder, never a real one. */
  placeholder?: string
  /**
   * An interactive flow the wizard renders IN PLACE, instead of sending the
   * operator somewhere with instructions.
   *
   * Boss, 2026-08-21: the Claude login step linked to claude.ai, which on an
   * already-signed-in browser just opens the chat -- "semmi folyamat hogy a
   * gepemen be tudjam jelentkeztetni [...] itt a bongeszoben nem ennek kelene
   * megjelennie hanem az autorizacios panelnak". A link plus a terminal command
   * is not a walkthrough; a step that CAN be done on the page must be.
   */
  flowId?: 'claude-login' | 'system-deps' | 'google-oauth-client' | 'voice-install'
  /**
   * A live "try it now" the wizard offers under the field (POST /api/setup-wizard/check): it asks the
   * service itself whether the saved key works, so the answer is a measurement, not "a value is there".
   */
  checkId?: 'openrouter' | 'cloudinary' | 'buffer'
  /** Shape a 'vault' value must have before it is saved (the wizard refuses the rest with a plain reason). */
  vaultFormat?: 'cloudinary-url'
  /** Label of the Vault card the wizard creates for a 'vault' item. */
  vaultLabel?: string
  /**
   * i18n key of the self-check sentence for a MISSING item: what stops working without it. The generic
   * integration sentence says "extra feature"; a recommended one (video) must not claim that.
   */
  selfcheckKey?: string
  /**
   * Where the value lives. Default: the .env file. 'override' means the key is
   * a settings-registry key another screen already writes as an override
   * (store/config-overrides.json); an override wins over .env, so writing .env
   * here would be silently shadowed. Such an item is read and written through
   * the override store, and takes effect without a restart.
   */
  store?: 'override'
  /**
   * Vault entries (ids) this capability reads through getSecret(). The #766 gate fails CI when the
   * code names a Vault id that no row lists here and that is not in governance/external-deps-exceptions.json.
   */
  vaultIds?: string[]
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
    id: 'claude-auth', group: 'identity', kind: 'external', flowId: 'claude-login',
    labelKey: 'wizard.item.claude_auth', descKey: 'wizard.item.claude_auth_desc',
    helpKey: 'wizard.item.claude_auth_help',
    stepKeys: ['wizard.item.claude_auth_step1', 'wizard.item.claude_auth_step2', 'wizard.item.claude_auth_step3'],
    // The registration link stays -- somebody with no Claude account at all
    // still needs it -- but it is no longer the whole step.
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
    // Uploaded IN PLACE (kanban f97acc32): step 5 used to say "copy the file
    // into store/google-oauth-client.json", which a fresh install cannot do
    // without a terminal. The consent-screen and API steps were missing too --
    // without them Google refuses the client, or every Drive/Gmail/Calendar
    // call comes back 403 SERVICE_DISABLED.
    id: 'google-oauth', group: 'google', kind: 'external', flowId: 'google-oauth-client',
    labelKey: 'wizard.item.google_oauth', descKey: 'wizard.item.google_oauth_desc',
    helpKey: 'wizard.item.google_oauth_help',
    stepKeys: [
      'wizard.item.google_oauth_step1', 'wizard.item.google_oauth_step_consent',
      'wizard.item.google_oauth_step_apis',
      'wizard.item.google_oauth_step2', 'wizard.item.google_oauth_step3',
      'wizard.item.google_oauth_step4', 'wizard.item.google_oauth_step5',
    ],
    links: [
      { url: 'https://console.cloud.google.com/apis/credentials', labelKey: 'wizard.link.google_console' },
      { url: 'https://console.cloud.google.com/auth/overview', labelKey: 'wizard.link.google_consent' },
      { url: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com', labelKey: 'wizard.link.api_gmail' },
      { url: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', labelKey: 'wizard.link.api_drive' },
      { url: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', labelKey: 'wizard.link.api_calendar' },
      { url: 'https://console.cloud.google.com/apis/library/photospicker.googleapis.com', labelKey: 'wizard.link.api_photos' },
    ],
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
    // A gepre telepitendo kulso programok (LibreOffice, FFmpeg, ...), kanban
    // d7acdd75. A lepes HELYBEN mutatja, mi van meg es mi hianyzik, egy
    // bemasolhato telepito-sorral -- a lista a src/system-deps.ts-ben van.
    id: 'system-programs', group: 'maintenance', kind: 'external', flowId: 'system-deps',
    labelKey: 'wizard.item.system_programs', descKey: 'wizard.item.system_programs_desc',
    helpKey: 'wizard.item.system_programs_help',
    required: false, tier: 'recommended',
  },
  {
    // Card #683: a 10 GB WSL VM without a sensible memory/swap limit froze on
    // 2026-10-17 and took the fleet down for minutes. Shown ONLY on WSL (the
    // route hides it elsewhere); "set" means .wslconfig really holds a swap
    // size -- an unreadable Windows profile is NOT reported as fine.
    id: 'wsl-memory', group: 'maintenance', kind: 'external',
    labelKey: 'wizard.item.wsl_memory', descKey: 'wizard.item.wsl_memory_desc',
    helpKey: 'wizard.item.wsl_memory_help',
    stepKeys: ['wizard.item.wsl_memory_step1', 'wizard.item.wsl_memory_step2', 'wizard.item.wsl_memory_step3', 'wizard.item.wsl_memory_step4'],
    links: [{ url: 'https://learn.microsoft.com/windows/wsl/wsl-config#configuration-setting-for-wslconfig', labelKey: 'wizard.link.wsl_config' }],
    exampleKey: 'wizard.item.wsl_memory_example',
    required: false, tier: 'recommended',
  },
  {
    id: 'ollama-url', group: 'models', kind: 'env', envKey: 'OLLAMA_URL',
    labelKey: 'wizard.item.ollama', descKey: 'wizard.item.ollama_desc',
    helpKey: 'wizard.item.ollama_help',
    stepKeys: ['wizard.item.ollama_step1', 'wizard.item.ollama_step2'],
    // Az `ollama pull <modell>` parancs a KODBOL kapja a modell nevet.
    stepParams: { model: EMBED_MODEL },
    links: [{ url: 'https://ollama.com/download', labelKey: 'wizard.link.ollama_download' }],
    exampleKey: 'wizard.item.ollama_example',
    required: false, tier: 'extra', placeholder: 'http://localhost:11434',
  },
  // --- Video making (#765): the minimum a video needs, one row each. -------------------------------------
  // Boss (TG 10228): the wizard must offer these on a fresh install and the Overview self-check must
  // watch them. Recommended (orange), never essential (red): Marveen works without video.
  // Free plans only (Boss): Cloudinary free (25 shared credits a month, 100 MB per video) and Buffer free
  // (3 channels: Facebook, Instagram, TikTok). The one paid part is the OpenRouter balance for generating.
  {
    id: 'video-openrouter', group: 'integrations', kind: 'vault', vaultIds: ['openrouter-fleet-key'],
    vaultLabel: 'OpenRouter', checkId: 'openrouter',
    labelKey: 'wizard.item.video_openrouter', descKey: 'wizard.item.video_openrouter_desc',
    helpKey: 'wizard.item.video_openrouter_help', selfcheckKey: 'wizard.item.video_openrouter_selfcheck',
    stepKeys: [
      'wizard.item.video_openrouter_step1', 'wizard.item.video_openrouter_step2',
      'wizard.item.video_openrouter_step3', 'wizard.item.video_openrouter_step4',
      'wizard.item.video_openrouter_step5',
    ],
    links: [
      { url: 'https://openrouter.ai/sign-up', labelKey: 'wizard.link.openrouter_signup' },
      { url: 'https://openrouter.ai/settings/credits', labelKey: 'wizard.link.openrouter_credits' },
      { url: 'https://openrouter.ai/settings/keys', labelKey: 'wizard.link.openrouter_keys' },
    ],
    exampleKey: 'wizard.item.video_openrouter_example',
    required: false, tier: 'recommended', placeholder: 'sk-or-v1-...',
  },
  {
    id: 'video-cloudinary', group: 'integrations', kind: 'vault', vaultIds: ['cloudinary-url'],
    vaultLabel: 'Cloudinary', vaultFormat: 'cloudinary-url', checkId: 'cloudinary',
    labelKey: 'wizard.item.video_cloudinary', descKey: 'wizard.item.video_cloudinary_desc',
    helpKey: 'wizard.item.video_cloudinary_help', selfcheckKey: 'wizard.item.video_cloudinary_selfcheck',
    stepKeys: [
      'wizard.item.video_cloudinary_step1', 'wizard.item.video_cloudinary_step2',
      'wizard.item.video_cloudinary_step3', 'wizard.item.video_cloudinary_step4',
      'wizard.item.video_cloudinary_step5',
    ],
    links: [
      { url: 'https://cloudinary.com/users/register_free', labelKey: 'wizard.link.cloudinary_signup' },
      { url: 'https://console.cloudinary.com/settings/api-keys', labelKey: 'wizard.link.cloudinary_keys' },
    ],
    exampleKey: 'wizard.item.video_cloudinary_example',
    required: false, tier: 'recommended', placeholder: 'cloudinary://123456789012345:abcDEF_secret@my-cloud',
  },
  {
    id: 'video-buffer', group: 'integrations', kind: 'vault', vaultIds: ['buffer-api-key'],
    vaultLabel: 'Buffer', checkId: 'buffer',
    labelKey: 'wizard.item.video_buffer', descKey: 'wizard.item.video_buffer_desc',
    helpKey: 'wizard.item.video_buffer_help', selfcheckKey: 'wizard.item.video_buffer_selfcheck',
    stepKeys: [
      'wizard.item.video_buffer_step1', 'wizard.item.video_buffer_step2',
      'wizard.item.video_buffer_step3', 'wizard.item.video_buffer_step4',
      'wizard.item.video_buffer_step5',
    ],
    links: [
      { url: 'https://login.buffer.com/signup', labelKey: 'wizard.link.buffer_signup' },
      { url: 'https://publish.buffer.com/settings/api', labelKey: 'wizard.link.buffer_api' },
      { url: 'https://support.buffer.com/article/984-how-to-create-your-buffer-api-key', labelKey: 'wizard.link.buffer_help' },
    ],
    exampleKey: 'wizard.item.video_buffer_example',
    required: false, tier: 'recommended', placeholder: 'paste-the-copied-key-here',
  },
  {
    // Optional: the OpenRouter balance widget on the Overview. A second, read-only key.
    id: 'openrouter-balance', group: 'integrations', kind: 'vault', vaultIds: ['openrouter-management-key'],
    vaultLabel: 'OpenRouter (management)',
    labelKey: 'wizard.item.openrouter_balance', descKey: 'wizard.item.openrouter_balance_desc',
    helpKey: 'wizard.item.openrouter_balance_help',
    stepKeys: [
      'wizard.item.openrouter_balance_step1', 'wizard.item.openrouter_balance_step2',
      'wizard.item.openrouter_balance_step3',
    ],
    links: [{ url: 'https://openrouter.ai/settings/management-keys', labelKey: 'wizard.link.openrouter_mgmt' }],
    exampleKey: 'wizard.item.openrouter_balance_example',
    required: false, tier: 'extra', placeholder: 'sk-or-v1-...',
  },
  {
    // The voice toolkit: speech recognition (automatic subtitles) and the local voice (voiceover).
    // The Overview already has its own row (voice_stt_*); this is the wizard step it never had.
    id: 'voice-toolkit', group: 'maintenance', kind: 'external', flowId: 'voice-install',
    labelKey: 'wizard.item.voice_toolkit', descKey: 'wizard.item.voice_toolkit_desc',
    helpKey: 'wizard.item.voice_toolkit_help',
    stepKeys: ['wizard.item.voice_toolkit_step1', 'wizard.item.voice_toolkit_step2', 'wizard.item.voice_toolkit_step3'],
    required: false, tier: 'recommended',
  },
  // Optional keyed third-party services go here with group 'integrations'
  // (image, video, voice generation, ...): the Overview self-check then gets
  // a row for each on its own (integrationRows). See the
  // bake-in-wizard-selfcheck skill. The Workbench web search needs no entry:
  // it runs on the signed-in Claude subscription, with no key (#404).
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
  /** Items that do not apply to this machine (e.g. the WSL limit on a non-WSL install): left out entirely. */
  hiddenIds: ReadonlySet<string> = new Set(),
): SetupSummary {
  const items: SetupItemState[] = SETUP_ITEMS.filter((item) => !hiddenIds.has(item.id)).map((item) => {
    if (item.kind === 'external' || item.kind === 'vault') {
      // A Vault secret, like an external login, reports only whether it is set: the value never leaves the server.
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
/** Keys the wizard reads and writes through the settings override store. */
export function overrideStoredKeys(): Set<string> {
  return new Set(SETUP_ITEMS.filter(i => i.store === 'override' && i.envKey).map(i => i.envKey!))
}

/** The 'vault' items the wizard may write, by the Vault id. Anything else is refused. */
export function writableVaultItems(): Map<string, SetupItem> {
  const out = new Map<string, SetupItem>()
  for (const i of SETUP_ITEMS) if (i.kind === 'vault' && i.vaultIds?.[0]) out.set(i.vaultIds[0], i)
  return out
}

export function writableEnvKeys(): Set<string> {
  return new Set(
    SETUP_ITEMS.filter(i => i.kind === 'env' || i.kind === 'secret')
      .map(i => i.envKey!)
      .filter(Boolean),
  )
}
