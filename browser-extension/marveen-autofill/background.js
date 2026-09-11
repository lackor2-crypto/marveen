// The only part of the extension that talks to Marveen.
//
// Everything network-facing lives here on purpose. A content script runs
// inside the page, so anything it holds is one bug away from the page itself;
// the service worker is isolated, and it is the only place the pairing token
// is stored and read. The content script never sees the token, and never sees
// a password it did not ask for on a form it actually found.

const DEFAULT_URL = 'http://localhost:3420'

async function settings() {
  const s = await chrome.storage.local.get(['baseUrl', 'token', 'autoFill'])
  return {
    baseUrl: (s.baseUrl || DEFAULT_URL).replace(/\/+$/, ''),
    token: s.token || '',
    autoFill: s.autoFill !== false,
  }
}

async function call(path, body, overrides = {}) {
  const { baseUrl, token } = { ...(await settings()), ...overrides }
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  return { status: res.status, data }
}

// Pairing: trade the code the user read off the dashboard for this browser's
// own token. The token is scoped to /api/autofill/* on the server side -- it
// cannot be replayed anywhere else even if this extension is compromised.
async function pair({ baseUrl, code, name }) {
  const clean = (baseUrl || DEFAULT_URL).replace(/\/+$/, '')
  try {
    const { status, data } = await call('/api/autofill/pair', { code, name }, { baseUrl: clean, token: '' })
    if (status === 200 && data && data.token) {
      await chrome.storage.local.set({ baseUrl: clean, token: data.token, clientName: data.name || name || '' })
      return { ok: true }
    }
    return { ok: false, reason: (data && data.reason) || 'unknown_code' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

async function unpair() {
  await chrome.storage.local.remove(['token', 'clientName'])
  return { ok: true }
}

async function status() {
  const { baseUrl, token, autoFill } = await settings()
  const stored = await chrome.storage.local.get(['clientName'])
  return { baseUrl, paired: Boolean(token), autoFill, clientName: stored.clientName || '' }
}

// What the vault has for this page. Never returns a password: the content
// script gets labels and usernames so it can offer a choice, and asks for one
// credential only when the user (or the single-match rule) settled on one.
async function lookup(url) {
  const { token } = await settings()
  if (!token) return { paired: false, candidates: [] }
  try {
    const { status: code, data } = await call('/api/autofill/lookup', { url })
    if (code === 401) return { paired: false, candidates: [] }
    return { paired: true, candidates: (data && data.candidates) || [] }
  } catch {
    return { paired: true, unreachable: true, candidates: [] }
  }
}

async function credential({ url, entryId, section }) {
  const { token } = await settings()
  if (!token) return { ok: false }
  try {
    const { status: code, data } = await call('/api/autofill/credential', { url, entry_id: entryId, section })
    if (code !== 200 || !data) return { ok: false, reason: (data && data.reason) || 'refused' }
    return { ok: true, username: data.username || '', password: data.password || '' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

// WHICH page the browser is really on is decided here, from what Chrome says
// about the sender, never from what the message claims. A content script can
// only report the address it read a moment ago; `sender.url` is the frame the
// browser actually delivered the message from, and a page cannot forge it.
// This is the second half of the question the card asked: the server checks
// that the entry covers the host, and this checks that the host is real.
function senderPageUrl(sender) {
  if (!sender || !sender.tab) return ''
  return sender.url || sender.tab.url || ''
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const pageUrl = senderPageUrl(sender)
  const handlers = {
    status: () => status(),
    pair: () => pair(msg),
    unpair: () => unpair(),
    setAutoFill: async () => { await chrome.storage.local.set({ autoFill: Boolean(msg.autoFill) }); return { ok: true } },
    lookup: () => pageUrl ? lookup(pageUrl) : Promise.resolve({ paired: false, candidates: [] }),
    credential: () => pageUrl
      ? credential({ ...msg, url: pageUrl })
      : Promise.resolve({ ok: false, reason: 'no_page' }),
  }
  const handler = handlers[msg && msg.type]
  if (!handler) return false
  handler().then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }))
  // Keeps the message channel open for the async answer above.
  return true
})
