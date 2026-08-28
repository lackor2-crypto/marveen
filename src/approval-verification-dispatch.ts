// What a dispatched approval task actually SAYS, and who it can be sent to.
//
// Two things live here that used to be inline in the route handler:
//
//  1. The MODE (Boss, 2026-08-24: "Ha hibat talal akkor viszont a jovahagyas
//     menupontban tudjam kiosztani a javitast majd valamelyik agensre!!! ...
//     ha kivalasztok egy agenst akkor tudjam meg pluszban kijelolni azt is
//     hogy vizsgalat, vagy javitas."). 'verify' is the old, read-only review.
//     'fix' asks the agent to actually repair what a review found -- a
//     fundamentally different permission set, so it gets its own prompt rather
//     than a sentence bolted onto the read-only one.
//
//  2. The code-bridge (VS Code) executor as a dispatch TARGET (Boss, same
//     message: "es ott abban a listaban remelem lathato a vscode ugynok is!
//     Mert javitasra az a legjobb!"). A VS Code executor is not an agent
//     directory and has no tmux session, so it cannot be addressed by a bare
//     name without colliding with the sub-agent lifecycle. It is addressed as
//     `code:<projectAlias>` -- and because normalizeAlias() in
//     code-bridge-store strips everything outside [a-z0-9_-], a project alias
//     can never contain a colon, so the prefix is unambiguous.
//
// Kept as a plain module with no database and no I/O so the prompt text and
// the addressing rules are unit-testable without a live dashboard.

/** 'verify' = read-only review. 'fix' = repair what a review found. */
export type VerificationMode = 'verify' | 'fix'

export const VERIFICATION_MODES: readonly VerificationMode[] = ['verify', 'fix'] as const

/**
 * Missing or unrecognised input becomes 'verify' -- NEVER an error.
 *
 * Every caller that predates the mode (an older dashboard tab still open, a
 * script, an agent copying an older curl line) sends `{agents:[...]}` with no
 * mode at all. Rejecting those would break dispatches that used to work, and
 * guessing 'fix' would hand write permission to an agent nobody asked to
 * write. The safe reading of silence is the read-only one.
 */
export function parseVerificationMode(raw: unknown): VerificationMode {
  return raw === 'fix' ? 'fix' : 'verify'
}

// --- Addressing a VS Code (code-bridge) executor -------------------------

export const CODE_AGENT_PREFIX = 'code:'

export function codeBridgeAgentId(projectAlias: string): string {
  return `${CODE_AGENT_PREFIX}${projectAlias}`
}

export function isCodeBridgeAgent(agent: string): boolean {
  return agent.startsWith(CODE_AGENT_PREFIX) && agent.length > CODE_AGENT_PREFIX.length
}

/** The project alias inside a `code:<alias>` id, or null if this is a plain agent. */
export function codeBridgeProjectOf(agent: string): string | null {
  return isCodeBridgeAgent(agent) ? agent.slice(CODE_AGENT_PREFIX.length) : null
}

// --- Landing policy for a fix ---------------------------------------------

/**
 * ⚠ LANDING POLICY -- THE ONE PLACE TO CHANGE IT.
 *
 * Whether an agent that fixed something may merge it into the main branch by
 * itself is the owner's call, and it HAS been made -- do not read this block
 * as still open. Source: Boss, Telegram message 4404, 2026-08-28, answering
 * the choice with a single letter, "A" = free rein. The fixer commits and
 * lands on its own and does not wait for a review, consistent with the rule
 * that a single reviewer must never become the fleet's bottleneck (CLAUDE.md,
 * 2026-08-25).
 *
 * The green suite is what replaces the review here, so the two halves are NOT
 * separable: "land it yourself" only holds together with the full-suite +
 * tsc gate stated in the fix prompt above this block.
 *
 * Changing the policy again is a REPLACEMENT of this array, nothing else --
 * no route and no test encodes it anywhere but here. The ONE thing that must
 * be changed WITH it is the sentence the picker shows the user
 * ('approvals.verify.mode_fix_hint' in web/lang/hu.js and en.js): a promise on
 * screen that no longer matches what the agent does is worse than no promise.
 */
export const FIX_LANDING_POLICY: readonly string[] = [
  `LANDOLAS: szabad kezed van. Ha a javitas kesz es a TELJES teszt-suite + a tsc ZOLD, akkor COMMITOLD`,
  `es LANDOLD a fo agba (main) onalloan -- nem kell review-ra varnod, es nem kell megvarnod, hogy a`,
  `tulajdonos ra boljinstson. Ha barmelyik nem zold, NE landolj: az mar nem kesz munka.`,
  `Dolgozz izolalt worktree-ben (flotta-szabaly, ez tovabbra is all), es ha van a jovahagyashoz kotheto`,
  `kanban kartya, ird vissza ra, MIT javitottal es mi a commit azonositoja.`,
]

// --- Prompts ---------------------------------------------------------------

export interface VerificationPromptInput {
  mode: VerificationMode
  approvalId: string
  category: string
  actionDescription: string
  /** The id the agent must report back under -- a plain agent name or `code:<alias>`. */
  agent: string
  ownerName: string
  /** Absolute path to store/.dashboard-token AS THE EXECUTOR SEES IT. */
  tokenPath: string
  /** Dashboard base URL (port comes from config, never hardcoded). */
  baseUrl: string
}

function reportBlock(i: VerificationPromptInput, passMeaning: string, failMeaning: string): string[] {
  return [
    `Amikor kesz vagy, jelentsd vissza az eredmenyt EZZEL a hivassal (KOTELEZO, ne csak inter-agent uzenettel):`,
    `curl -s -X POST ${i.baseUrl}/api/approvals/${i.approvalId}/verify-result \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer $(cat ${i.tokenPath})" \\`,
    `  -d '{"agent":"${i.agent}","status":"pass","report":"rovid osszefoglalo"}'`,
    ``,
    `status "pass" = ${passMeaning}; status "fail" = ${failMeaning}. A report mezoben RÖVIDEN (max nehany`,
    `mondat) indokold.`,
  ]
}

export function buildVerificationPrompt(input: VerificationPromptInput): string {
  const head = [
    input.mode === 'fix'
      ? `Javitasi feladat (${input.ownerName} osztotta ki a Jovahagyasok oldalrol): egy ellenorzes hibat talalt ebben a fuggo jovahagyasban -- javitsd ki.`
      : `Ellenorzesi feladat (${input.ownerName} kerte, jovahagyas elott): nezd at ezt a fuggo jovahagyast alaposan.`,
    `Kategoria: ${input.category}`,
    `Leiras: ${input.actionDescription}`,
    ``,
  ]

  if (input.mode === 'fix') {
    return [
      ...head,
      `EZ EGY JAVITASI FELADAT, nem ellenorzes: kodot IRHATSZ. Amit viszont most sem szabad: az ELO rendszer`,
      `allapotat modositani -- nincs jelszo-, felhasznalo-, agens- vagy beallitas-valtoztatas, nincs elo`,
      `levelkuldes, nincs szolgaltatas-ujrainditas, nincs torles, es semmi ami a repon kivul ir fajlt.`,
      `Egy "csak kiprobalom" hivas itt valodi kart okoz: 2026-08-24-en egy ilyen proba atallitotta a dashboard`,
      `jelszavat es kileptette a tulajdonost.`,
      ``,
      `IZOLALT MUNKAKONYVTAR: ne az elo checkoutban dolgozz, hanem sajat git worktree-ben/agon -- masik agens`,
      `commitolatlan munkaja allhat ott, es a felulirasa nema adatvesztes.`,
      ``,
      `A VEGEN KOTELEZO a TELJES teszt-suite (npx vitest run) es a tipusellenorzes (npx tsc --noEmit).`,
      `Ha barmelyik nem zold, az NEM kesz munka: akkor "fail"-t jelents, es ird meg, mi bukik.`,
      ``,
      ...FIX_LANDING_POLICY,
      ``,
      ...reportBlock(
        input,
        'megjavitottad, a teljes teszt-suite zold',
        'nem tudtad megjavitani -- a report mezoben KONKRETAN miert (mi bukik, hol akadtal el)',
      ),
    ].join('\n')
  }

  return [
    ...head,
    `EZ EGY CSAK-OLVASO ELLENORZES. Amit szabad: git log/git show/git diff a relevans commitra, a forrasfajlok`,
    `olvasasa es keresese, a tesztek futtatasa IZOLALT checkoutban, es olvaso (GET) API-hivas a dashboardon.`,
    `TILOS barmilyen allapotvaltoztato hivas az ELO rendszeren: nincs POST/PUT/PATCH/DELETE (az egyetlen kivetel a`,
    `lentebbi verify-result jelentes), nincs jelszo-, felhasznalo-, agens-, beallitas- vagy kartya-modositas, nincs`,
    `elo levelkuldes, nincs szolgaltatas-ujrainditas es nincs semmi, ami fajlt ir a repon kivul. Egy "csak kiprobalom"`,
    `hivas itt valodi kart okoz: 2026-08-24-en egy ilyen proba atallitotta a dashboard jelszavat es kileptette a Bosst.`,
    `Ha a valtoztatas UI-t erint, a fajlokban keresve igazold, hogy az elem tenyleg megvan -- ne kattintsd vegig elesben.`,
    `Ha az ellenorzeshez elkerulhetetlen lenne egy iro hivas, NE tedd meg: ird le a jelentesben, hogy mit nem tudtal`,
    `igy ellenorizni.`,
    ``,
    ...reportBlock(
      input,
      'minden rendben',
      'problemat talaltal -- konkretan mit talaltal hibasnak',
    ),
  ].join('\n')
}
