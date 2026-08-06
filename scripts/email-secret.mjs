#!/usr/bin/env node
// AES-256-GCM encrypt/decrypt for himalaya IMAP/SMTP account passwords.
// Single source of truth for the cipher -- both the backend (encrypt, on
// save from the Iroda "Beallitasok" form) and himalaya itself (decrypt, via
// each account's `password.command` in config.toml) invoke THIS script, so
// there is exactly one place the AES layout can drift.
//
// Key/data live in the same per-install, gitignored, 0700 directory as the
// rest of the himalaya config -- not a KMS-grade defense against full
// machine compromise, but it does mean a leaked config.toml or a stray
// backup of just the secrets dir isn't readable on its own, matching what
// self-hosted mail clients (Roundcube, Thunderbird) do for the same
// same-machine-key constraint.
//
// Usage:
//   email-secret.mjs decrypt <account>          -> prints plaintext to stdout
//   email-secret.mjs encrypt <account>            reads plaintext from stdin, writes the encrypted file

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE_DIR = join(homedir(), '.local/share/marveen-himalaya')
const KEY_PATH = join(BASE_DIR, '.secret-key.bin')
const SECRETS_DIR = join(BASE_DIR, 'secrets-enc')

function getOrCreateKey() {
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH)
  mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  writeFileSync(KEY_PATH, key, { mode: 0o600 })
  return key
}

function secretPath(account) {
  return join(SECRETS_DIR, `${account}.enc`)
}

function encrypt(account, plaintext) {
  const key = getOrCreateKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(secretPath(account), Buffer.concat([iv, authTag, ciphertext]), { mode: 0o600 })
}

function decrypt(account) {
  const key = getOrCreateKey()
  const buf = readFileSync(secretPath(account))
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
    process.stdin.on('error', reject)
  })
}

const [, , mode, account] = process.argv
if (mode === 'decrypt' && account) {
  process.stdout.write(decrypt(account))
} else if (mode === 'encrypt' && account) {
  const plaintext = await readStdin()
  encrypt(account, plaintext)
} else {
  process.stderr.write('usage: email-secret.mjs decrypt|encrypt <account>\n')
  process.exit(1)
}
