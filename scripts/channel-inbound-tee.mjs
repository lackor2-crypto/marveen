#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const childArgs = process.argv.slice(2)
if (childArgs.length === 0) {
  console.error('channel-inbound-tee: missing child command')
  process.exit(2)
}

const [command, ...args] = childArgs
const child = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stateDir = process.env.TELEGRAM_STATE_DIR || ''
const inboxPath = stateDir ? join(stateDir, 'inbox-pending.jsonl') : ''

// Arrival receipt (Boss, 2026-08-23: "A Telegram felhasznalo nem tudja, hogy
// most, amit irt neked, az te vetted az adast, vagy nem vetted az adast").
//
// A sub-agent's inbound message never reaches a UserPromptSubmit hook: Claude
// Code drops the plain-MCP channel notification, so the text arrives as hook
// STDOUT from channel-inbox-drain.py, not in `prompt`. telegram_progress.py --
// the hook that posts "Dolgozom rajta..." -- looks for a <channel> tag in the
// prompt, finds none, and returns silently. Measured on this install: the main
// agent's progress log was written the same day, the Szakerto's had not been
// touched since 2026-08-11, while its inbox archive was minutes old.
//
// This relay is the ONE place that sees the message at the moment it lands,
// independent of whether the session is idle, mid-turn or asleep -- so the
// receipt belongs here. Deliberately not "dolgozom rajta": at this instant the
// message is only queued, and claiming work that has not started would be a
// nicer-looking lie. channel-inbox-drain.py edits this same message to the
// working text when the turn actually picks it up, and the existing Stop /
// PostToolUse hooks delete it when the answer goes out -- one message, three
// states, no extra noise in the chat.
const RECEIPT_TEXT = '\u{1F4E5} Megkaptam, sorban \u00e1ll\u2026'
const RECEIPT_TIMEOUT_MS = 8000
// Overridable so the contract can be tested against a local stub instead of
// Telegram, and so a self-hosted Bot API server keeps working.
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')
const progressDir = stateDir ? join(stateDir, 'progress') : ''
const arrivalPath = progressDir ? join(progressDir, 'arrival.jsonl') : ''

let warnedInboxWrite = false
let warnedReceipt = false
let cachedToken
// Serialised: two messages arriving in the same burst must not interleave their
// appends to arrival.jsonl, and Telegram is happier with sequential sends.
let receiptChain = Promise.resolve()
let lineBuffer = ''
const decoder = new StringDecoder('utf8')

function warnInboxWrite(err) {
  if (warnedInboxWrite) return
  warnedInboxWrite = true
  const msg = err instanceof Error ? err.message : String(err)
  writeSync(2, `channel-inbound-tee: could not append inbound inbox: ${msg}\n`)
}

function warnReceipt(err) {
  if (warnedReceipt) return
  warnedReceipt = true
  const msg = err instanceof Error ? err.message : String(err)
  writeSync(2, `channel-inbound-tee: arrival receipt failed: ${msg}\n`)
}

/** The agent's OWN bot token, from its own state dir -- never the main agent's. */
function botToken() {
  if (cachedToken !== undefined) return cachedToken
  cachedToken = null
  try {
    const line = readFileSync(join(stateDir, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('TELEGRAM_BOT_TOKEN='))
    if (line) cachedToken = line.trim().slice('TELEGRAM_BOT_TOKEN='.length).trim() || null
  } catch {
    cachedToken = null
  }
  return cachedToken
}

/** O_EXCL marker per inbound message: a restarted relay that re-reads a frame,
 *  or a second notification for the same message, must not post twice.
 *  Named "seen-*" on purpose -- telegram_progress_watchdog.py already sweeps
 *  that glob in every agent's progress dir after an hour, so these do not
 *  become a directory nobody prunes. */
function claimArrival(chatId, srcMid) {
  if (srcMid === undefined || srcMid === null || srcMid === '') return true
  try {
    mkdirSync(progressDir, { recursive: true })
    writeFileSync(join(progressDir, `seen-arrival-${chatId}-${srcMid}.marker`), '', { flag: 'wx' })
    return true
  } catch (err) {
    if (err && err.code === 'EEXIST') return false
    return true // never let the guard swallow a receipt
  }
}

async function postReceipt(token, chatId, srcMid) {
  const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: RECEIPT_TEXT, disable_notification: true }),
    signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
  })
  const body = await res.json()
  const messageId = body && body.result && body.result.message_id
  if (!messageId) return
  // Handover record for channel-inbox-drain.py: which message to edit when the
  // turn starts, and which one the Stop hook must clear when the answer is out.
  mkdirSync(progressDir, { recursive: true })
  appendFileSync(
    arrivalPath,
    JSON.stringify({
      chat_id: String(chatId),
      message_id: messageId,
      src_message_id: srcMid === undefined ? null : srcMid,
      at: Math.floor(Date.now() / 1000),
    }) + '\n',
    'utf8',
  )
}

function ackArrival(params) {
  if (!stateDir) return
  const meta = params.meta && typeof params.meta === 'object' ? params.meta : {}
  const chatId = meta.chat_id
  if (chatId === undefined || chatId === null || chatId === '') return
  const token = botToken()
  if (!token) return // unconfigured install: stay silent, never guess a token
  if (!claimArrival(chatId, meta.message_id)) return
  receiptChain = receiptChain
    .then(() => postReceipt(token, chatId, meta.message_id))
    .catch((err) => warnReceipt(err))
}

function teeLine(line) {
  if (!inboxPath) return

  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }

  if (!frame || typeof frame !== 'object') return
  if (frame.method !== 'notifications/claude/channel') return
  if (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params)) return

  try {
    mkdirSync(dirname(inboxPath), { recursive: true })
    appendFileSync(
      inboxPath,
      JSON.stringify({
        receivedAt: Math.floor(Date.now() / 1000),
        params: frame.params,
      }) + '\n',
      'utf8',
    )
  } catch (err) {
    warnInboxWrite(err)
    return
  }

  ackArrival(frame.params)
}

function inspectChunk(chunk) {
  lineBuffer += decoder.write(chunk)
  for (;;) {
    const idx = lineBuffer.indexOf('\n')
    if (idx < 0) break
    const line = lineBuffer.slice(0, idx).replace(/\r$/, '')
    lineBuffer = lineBuffer.slice(idx + 1)
    teeLine(line)
  }
}

child.stdout.on('data', (chunk) => {
  writeSync(1, chunk)
  inspectChunk(chunk)
})

child.stderr.on('data', (chunk) => {
  writeSync(2, chunk)
})

// EPIPE guard: the child can die between our destroyed-check and the write
// (e.g. plugin crash); an unhandled 'error' on its stdin would crash the relay.
child.stdin.on('error', () => {})

process.stdin.on('data', (chunk) => {
  if (!child.stdin.destroyed) child.stdin.write(chunk)
})

process.stdin.on('end', () => {
  if (!child.stdin.destroyed) child.stdin.end()
})

process.stdin.on('close', () => {
  if (!child.stdin.destroyed) child.stdin.end()
})

child.on('error', (err) => {
  writeSync(2, `channel-inbound-tee: child spawn failed: ${err.message}\n`)
  process.exit(127)
})

// 'close' (not 'exit'): it fires only after the child's stdio streams are
// fully drained, so a final stdout burst right before death still passes
// through before we tear down.
child.on('close', (code, signal) => {
  const tail = decoder.end()
  if (tail) lineBuffer += tail
  // Exit EXPLICITLY: the open parent stdin would otherwise keep this relay
  // alive as a zombie after a plugin crash (exitCode alone never applies while
  // the loop is held). All passthrough writes are writeSync -> already flushed.
  //
  // But not before an in-flight arrival receipt: the message that lands in the
  // same instant the plugin dies is exactly the one whose sender gets nothing
  // else. Bounded, so a hanging Telegram call cannot keep the relay alive.
  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  }
  const guard = setTimeout(finish, RECEIPT_TIMEOUT_MS + 500)
  if (typeof guard.unref === 'function') guard.unref()
  receiptChain.then(finish, finish)
})
