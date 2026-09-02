// GLM (Z.ai) provider constants.
//
// Z.ai's GLM Coding Plan is a SUBSCRIPTION (Lite/Pro/Max), not per-token
// billing -- which is the whole reason it is wired directly here instead of
// through the OpenRouter path: OpenRouter can serve GLM, but only token-billed,
// so routing a Coding Plan through it would pay twice.
//
// The endpoint is Anthropic-compatible, so Claude Code talks to it natively --
// no proxy, no translation layer. Three things separate a working setup from a
// silently broken one, and all three are encoded here rather than left to
// whoever wires the next call site:
//
//  1. The base URL must be the CODING endpoint (`/api/anthropic`), not the
//     general one (`/api/paas/v4`). Z.ai's own docs: "The Coding endpoint is
//     for coding scenarios only; it and the general endpoint are not
//     interchangeable." A Coding Plan key on the general endpoint is rejected.
//  2. The key goes in ANTHROPIC_AUTH_TOKEN, NOT ANTHROPIC_API_KEY. This is the
//     single most reported mistake in every write-up of this integration; the
//     failure is a 401 that reads like a bad key.
//  3. The HAIKU alias must be set. Claude Code makes background calls on its
//     haiku-class model (conversation titles, small classifications). With only
//     ANTHROPIC_MODEL set, those go out as `claude-haiku-...` against the Z.ai
//     endpoint and come back "model does not exist" -- while the main
//     conversation works fine, so it reads as a random intermittent glitch.
//
// Source: https://docs.z.ai/devpack/tool/claude and
// https://zcode.z.ai/en/docs/configuration (read 2026-09-02).

/** Vault id the fleet reads the Z.ai Coding Plan key by. */
export const GLM_VAULT_KEY = 'zai-coding-key'

/** Anthropic-compatible Coding-Plan endpoint (the SDK appends /v1/messages). */
export const GLM_BASE_URL = 'https://api.z.ai/api/anthropic'

/**
 * Model used for Claude Code's background haiku-class calls. Kept separate
 * from the agent's chosen model on purpose: the cheap model should stay cheap
 * even when the agent runs on the big one.
 */
export const GLM_FAST_MODEL = 'glm-5.3-flash'

/**
 * GLM streams noticeably slower than Claude on long tool-heavy turns and the
 * default client timeout cuts those off mid-answer; Z.ai's own Claude Code
 * instructions set this value.
 */
export const GLM_TIMEOUT_MS = '3000000'

export interface GlmModelInfo {
  id: string
  label: string
}

/**
 * The models the GLM Coding Plan serves. Deliberately a short, documented list
 * rather than a live catalog fetch: the plan exposes two coding models, and a
 * dropdown that silently empties itself when a fetch fails would be worse than
 * a list that is occasionally a version behind.
 */
export const GLM_MODELS: GlmModelInfo[] = [
  { id: 'glm-5.3', label: 'GLM-5.3' },
  { id: GLM_FAST_MODEL, label: 'GLM-5.3-Flash' },
]

/**
 * Provider discriminator. Must be checked BEFORE the Ollama fallback in
 * agent-process.ts: `glm-5.3` carries no '/' and no `claude-`/`deepseek-`
 * prefix, so the old chain classified it as a local Ollama tag and pointed the
 * agent at localhost:11434 -- which does not error, it just quietly answers
 * from the wrong model (or hangs when Ollama is not running).
 */
export function isGlmModel(model: string): boolean {
  return model.startsWith('glm-')
}
