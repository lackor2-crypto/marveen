import { spawn } from "node:child_process"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from "../config.js"
import { resolveOwnerChatId } from "../owner-chat.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun } from "../db.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// command-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive
// failures. This keeps infra heartbeats inside the one system that gets
// backed up (the Marveen store) instead of a separate crontab.

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number
  alerted: boolean
  lastStatus: "ok" | "fail" | "unknown"
  lastRun: number
}
type HealthMap = Record<string, CommandHealth>

let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}

export type CommandAction = "none" | "alert" | "recover"

// Pure decision function so the failure/recovery policy is unit-testable
// without spawning processes. success=true zeroes the streak; an alert
// fires exactly once when the streak first reaches failThreshold; a
// recover fires once when a previously-alerted task succeeds again.
export function evaluateCommandResult(
  prev: CommandHealth | undefined,
  success: boolean,
  failThreshold: number,
  now: number,
): { next: CommandHealth; action: CommandAction } {
  const wasAlerted = prev?.alerted ?? false
  const fails = success ? 0 : (prev?.fails ?? 0) + 1
  let action: CommandAction = "none"
  let alerted = wasAlerted
  if (success) {
    if (wasAlerted) { action = "recover"; alerted = false }
  } else if (fails >= failThreshold && !wasAlerted) {
    action = "alert"; alerted = true
  }
  return {
    next: { fails, alerted, lastStatus: success ? "ok" : "fail", lastRun: now },
    action,
  }
}

// A parancs NEM allithatja meg a vezerlopultot.
//
// 2026-08-22: ez `spawnSync` volt, ami a teljes esemenyhurkot blokkolja, amig
// a parancs fut. Egy parancs, ami VISSZAHIV a Marveenbe (a napi git-lehuzas
// pontosan ilyen: egy `curl` a sajat vegpontunkra), igy holtpontra futott --
// a szerver nem tudott valaszolni, mert eppen a parancsra vart. A curl
// idotullepett, a kartya pedig "hibas"-nak latszott, holott a parancs jo volt.
// Ugyanez igaz minden mas parancs-kartyara is: egy lassu ellenorzes addig
// befagyasztotta az egesz feluletet.
function runCommand(cmd: string, timeoutMs: number, done: (r: { ok: boolean; detail: string }) => void): void {
  let lezart = false
  const vege = (r: { ok: boolean; detail: string }): void => {
    if (lezart) return
    lezart = true
    done(r)
  }
  try {
    const ch = spawn("bash", ["-lc", cmd], { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    ch.stderr?.on("data", (d) => { if (err.length < 2000) err += String(d) })
    // Sajat ora: a `spawn`-nak nincs `timeout`-ja ugy, mint a sync valtozatnak.
    const ora = setTimeout(() => {
      try { ch.kill("SIGKILL") } catch { /* mar halott */ }
      vege({ ok: false, detail: `timeout ${timeoutMs}ms` })
    }, timeoutMs)
    ch.on("error", (e) => { clearTimeout(ora); vege({ ok: false, detail: e.message }) })
    ch.on("close", (code) => {
      clearTimeout(ora)
      if (code === 0) { vege({ ok: true, detail: "exit 0" }); return }
      const e = err.trim().slice(0, 200)
      vege({ ok: false, detail: `exit ${code}${e ? ": " + e : ""}` })
    })
  } catch (err) {
    vege({ ok: false, detail: (err as Error).message })
  }
}

export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  // A parancs a hatterben fut; az eredmenyt itt konyveljuk el, amikor kesz.
  // A hivo nem var ra -- se a cron-tick, se a "Futtatas most" gomb.
  runCommand(task.command, timeoutMs, ({ ok, detail }) => {
    const map = load()
    const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
    map[task.name] = next
    persist()
    try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
    logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")

    if (action === "none") return
    const ownerChat = resolveOwnerChatId()
    if (!TELEGRAM_BOT_TOKEN || !ownerChat) {
      logger.warn({ task: task.name }, "command task alert suppressed: missing token, or no owner chat (ALLOWED_CHAT_ID unset/placeholder and no paired channel)")
      return
    }
    const label = task.description || task.name
    const text = action === "alert"
      ? `\u{1F534} Hiba: ${label} nem v\u00e1laszol (${next.fails}. egym\u00e1s ut\u00e1ni hiba). R\u00e9szlet: ${detail}`
      : `\u{1F7E2} Helyre\u00e1llt: ${label} ism\u00e9t OK.`
    sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
      .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
      .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
  })
}
