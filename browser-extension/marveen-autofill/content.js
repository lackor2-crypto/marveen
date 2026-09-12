// Finds the login form on the page and fills it from the Marveen vault.
//
// Two rules shape everything here:
//   1. This script never holds a credential it was not asked to fill. It asks
//      for one, types it into the two inputs, and forgets it.
//   2. A page can change under it (single-page apps swap the login form in
//      long after load), so it watches instead of running once and giving up.

const FILLED = new WeakSet()
let cachedCandidates = null

function visible(el) {
  if (!el || el.disabled || el.readOnly) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 20 || rect.height < 8) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

/** The username input that belongs to a password input: the nearest preceding
 *  text/email input inside the same form, which is how login forms are built
 *  and how a person reads them. */
function usernameFor(passwordInput) {
  const scope = passwordInput.form || document
  const inputs = Array.from(scope.querySelectorAll('input'))
  const idx = inputs.indexOf(passwordInput)
  for (let i = idx - 1; i >= 0; i--) {
    const el = inputs[i]
    const type = (el.type || 'text').toLowerCase()
    if (['text', 'email', 'tel'].includes(type) && visible(el)) return el
  }
  return null
}

function setValue(input, value) {
  if (!input) return
  // React and friends listen to the events, not the property, so a plain
  // assignment leaves the framework's state on the old (empty) value and the
  // form submits blank. Setting through the native setter plus the two events
  // is what every password manager ends up doing.
  const proto = Object.getPrototypeOf(input)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function send(message) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(message, resolve) } catch { resolve(null) }
  })
}

async function fillWith(candidate, passwordInput) {
  // No address is sent: the service worker takes the page from what Chrome
  // reports about this frame, which nothing on the page can rewrite.
  const res = await send({ type: 'credential', entryId: candidate.entry_id, section: candidate.section })
  if (!res || !res.ok) return
  setValue(usernameFor(passwordInput), res.username)
  setValue(passwordInput, res.password)
}

function removePicker() {
  document.getElementById('marveen-autofill-picker')?.remove()
}

/** More than one stored login covers this site: the user picks, nobody
 *  guesses. The list shows the card name, the group inside it, and the
 *  username -- the three things that tell two accounts apart. */
function showPicker(candidates, passwordInput) {
  removePicker()
  const rect = passwordInput.getBoundingClientRect()
  const box = document.createElement('div')
  box.id = 'marveen-autofill-picker'
  box.style.cssText = [
    'position:absolute', `top:${window.scrollY + rect.bottom + 4}px`, `left:${window.scrollX + rect.left}px`,
    `min-width:${Math.max(220, rect.width)}px`, 'z-index:2147483647', 'background:#fff', 'color:#111',
    'border:1px solid #c7c7c7', 'border-radius:8px', 'box-shadow:0 6px 24px rgba(0,0,0,.18)',
    'font:13px system-ui,sans-serif', 'overflow:hidden',
  ].join(';')
  const title = document.createElement('div')
  title.textContent = chrome.i18n.getMessage('pick_title')
  title.style.cssText = 'padding:6px 10px;background:#f4f4f5;font-weight:600;font-size:12px'
  box.appendChild(title)
  for (const c of candidates) {
    const row = document.createElement('button')
    row.type = 'button'
    const who = c.username || c.username_label || ''
    row.textContent = [c.label, c.section, who].filter(Boolean).join(' · ')
    row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 10px;border:0;background:#fff;cursor:pointer'
    row.addEventListener('mouseenter', () => { row.style.background = '#eef2ff' })
    row.addEventListener('mouseleave', () => { row.style.background = '#fff' })
    row.addEventListener('click', async () => { removePicker(); await fillWith(c, passwordInput) })
    box.appendChild(row)
  }
  document.body.appendChild(box)
  setTimeout(() => document.addEventListener('click', removePicker, { once: true }), 0)
}

async function handlePasswordInput(passwordInput) {
  if (FILLED.has(passwordInput)) return
  FILLED.add(passwordInput)
  if (cachedCandidates === null) {
    const res = await send({ type: 'lookup' })
    cachedCandidates = res && res.candidates ? res.candidates : []
  }
  const usable = cachedCandidates.filter(c => !c.problem)
  if (usable.length === 0) return
  const auto = (await send({ type: 'status' }))?.autoFill !== false
  if (usable.length === 1 && auto) { await fillWith(usable[0], passwordInput); return }
  // Two or more: wait for the user to reach for the field before showing a
  // list over the page.
  passwordInput.addEventListener('focus', () => showPicker(usable, passwordInput))
  if (document.activeElement === passwordInput) showPicker(usable, passwordInput)
}

function scan() {
  for (const el of document.querySelectorAll('input[type="password"]')) {
    if (visible(el)) handlePasswordInput(el)
  }
}

if (location.protocol === 'http:' || location.protocol === 'https:') {
  scan()
  // A login form that appears later (modal, route change) must be caught too;
  // scanning once at load is exactly how autofill "randomly stops working".
  new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true })
}
