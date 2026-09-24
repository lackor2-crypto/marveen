import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STORE_DIR, WEB_PORT } from '../config.js'
import { AGENTS_BASE_DIR } from './agent-config.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'

const KNOWN_PROVIDERS = new Set<string>(['telegram', 'slack', 'discord', 'googlechat', 'teams'])

// Resolve the directory where an agent's channel plugin stores its bot .env.
// Search order:
//   1. <AGENTS_BASE_DIR>/<agentId>/.claude/channels/<provider>   (sub-agent own channel)
//   2. ~/.claude/channels/<provider>-<agentId>                   (alternative naming)
//   3. channelStateDir(provider)                                 (main agent -- env override,
//      then legacy shared path while unmigrated, then install-scoped; #915)
export function resolveAgentChannelStateDir(agentId: string, provider: string): string {
  const mainDir = KNOWN_PROVIDERS.has(provider)
    ? channelStateDir(provider as ChannelProviderType)
    : join(homedir(), '.claude', 'channels', provider)
  const candidates = [
    join(AGENTS_BASE_DIR, agentId, '.claude', 'channels', provider),
    join(homedir(), '.claude', 'channels', `${provider}-${agentId}`),
    mainDir,
  ]
  return candidates.find((d) => existsSync(join(d, '.env'))) ?? candidates[candidates.length - 1]
}

// Which inbound attachment kinds are actually audio.
//
// The channel tag carries attachment_kind, and the Telegram plugin uses it for
// EVERY attachment type -- "document", "photo" and so on, not just audio. The
// directive endpoint used to decide "was this a voice message?" from the mere
// PRESENCE of an attachment_file_id, so sending a PDF to an agent in `auto`
// voice mode made it answer a document with a synthesized voice message (and
// pushed the PDF through speech-to-text). Observed 2026-07-29 with an 826 kB
// PDF attachment.
const AUDIO_KINDS = new Set(['voice', 'audio', 'video_note'])

// True only when the inbound attachment is known to be audio. An absent or
// unrecognised kind counts as NOT audio: the conservative direction is to stay
// in text, because a wrong "speak" is a wrong-format answer to the owner, while
// a wrong "stay quiet" only loses the audio nicety.
export function inboundIsAudio(kind: string | null | undefined, fileId: string | null | undefined): boolean {
  if (!fileId) return false
  return AUDIO_KINDS.has(String(kind ?? '').trim().toLowerCase())
}

// The shell prefix that prints the TTS request body; the reply text is its one
// argument. Built with `node`, not `jq`: jq is not on every install (it was
// missing on the reference machine, so every voice reply command failed with
// "jq: command not found" -- kanban d7acdd75), while node is guaranteed because
// Marveen itself runs on it. The fixed fields are baked in as JSON literals and
// the whole script is single-quoted for the shell, escaping any single quote.
export function ttsBodyCommand(chatId: string, stateDir: string, voiceModel: string): string {
  const fixed = JSON.stringify({ chat_id: chatId, state_dir: stateDir, voice_model: voiceModel })
  const script = `process.stdout.write(JSON.stringify(Object.assign({text:process.argv[1]},${fixed})))`
  return `node -e '${script.replace(/'/g, "'\\''")}'`
}

// Build a ready-to-run TTS directive block injected after the STT transcript.
// Returns null if the dashboard token cannot be read.
export function buildTtsDirective(opts: {
  chatId: string
  stateDir: string
  voiceModel: string
}): string | null {
  try {
    const tokenPath = join(STORE_DIR, '.dashboard-token')
    if (!existsSync(tokenPath)) return null
    const token = readFileSync(tokenPath, 'utf-8').trim()
    const { chatId, stateDir, voiceModel } = opts
    const bodyCmd = ttsBodyCommand(chatId, stateDir, voiceModel)
    return (
      `\n\n[Hang válasz direktíva]: A fenti hangüzenetre HANGBAN válaszolj. ` +
      `Amikor megvan a válaszod szövege, futtasd le ezt a parancsot (a szöveget idézőjelben add meg, a JSON-escape-et a node elvégzi):\n` +
      `\`\`\`bash\n` +
      `${bodyCmd} "A_VÁLASZOD_SZÖVEGE" | ` +
      `curl -s -X POST http://localhost:${WEB_PORT}/api/voice/tts -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" -d @-\n` +
      `\`\`\`\n` +
      `Szöveges választ NE küldj -- CSAK a fenti curl-t futtasd le a hangküldéshez.`
    )
  } catch {
    return null
  }
}
