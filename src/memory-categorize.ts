// #796: one categoriser for an imported memory chunk (tier + keywords), on the shared AI road. The memory import
// (routes/memories.ts) and the migration (routes/migrate.ts) each had their own copy of the same Ollama call, prompt and
// JSON parsing; a fix to one did not reach the other.
import { ollamaGenerate } from './ai-call.js'

export const MEMORY_TIERS = ['hot', 'warm', 'cold', 'shared'] as const
export type MemoryTier = (typeof MEMORY_TIERS)[number]

export function categorizePrompt(chunk: string): string {
  return `Categorize this memory into exactly one tier and generate keywords.

Memory: "${chunk.slice(0, 500)}"

Tiers:
- hot: active tasks, pending decisions, things happening NOW
- warm: preferences, config, project context, stable knowledge
- cold: long-term lessons, historical decisions, archive
- shared: information relevant to multiple agents

Respond ONLY with JSON, nothing else. Replace every <...> placeholder:
{"tier": "<hot|warm|cold|shared>", "keywords": "<keyword1, keyword2, keyword3>"}`
}

/** The tier and keywords from the model's answer; warm with no keywords when the answer is unusable. */
export function parseCategory(answer: string | null | undefined): { tier: MemoryTier; keywords: string } {
  try {
    const m = String(answer ?? '').match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0]) as { tier?: unknown; keywords?: unknown }
      const tier = (MEMORY_TIERS as readonly string[]).includes(String(j.tier)) ? (j.tier as MemoryTier) : 'warm'
      return { tier, keywords: typeof j.keywords === 'string' ? j.keywords : '' }
    }
  } catch { /* an unusable answer: warm */ }
  return { tier: 'warm', keywords: '' }
}

/** Tier + keywords for one chunk with the local `model`; warm with no keywords when the model does not answer. */
export async function categorizeMemoryChunk(model: string, chunk: string): Promise<{ tier: MemoryTier; keywords: string }> {
  const r = await ollamaGenerate({ model, prompt: categorizePrompt(chunk), timeoutMs: 90_000 })
  return parseCategory(r ? r.text : null)
}
