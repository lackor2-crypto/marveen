// Pairing and the two switches that belong to this browser. Every string comes
// from _locales, so the popup speaks whatever the browser speaks.

const $ = id => document.getElementById(id)
const msg = key => chrome.i18n.getMessage(key)

function paint(text) {
  $('title').textContent = msg('popup_title')
  $('labelUrl').textContent = msg('label_url')
  $('labelCode').textContent = msg('label_code')
  $('labelName').textContent = msg('label_name')
  $('pairBtn').textContent = msg('btn_pair')
  $('hintCode').textContent = msg('hint_code')
  $('unpairBtn').textContent = msg('btn_unpair')
  $('autoLabel').textContent = msg('auto_label')
  $('state').textContent = text
}

function send(message) {
  return new Promise(resolve => chrome.runtime.sendMessage(message, resolve))
}

async function refresh() {
  const st = await send({ type: 'status' })
  paint(st.paired ? msg('state_paired') : msg('state_unpaired'))
  $('url').value = st.baseUrl
  $('auto').checked = st.autoFill !== false
  $('pairForm').hidden = st.paired
  $('pairedBox').hidden = !st.paired
  if (!$('name').value) $('name').value = st.clientName || guessBrowserName()
}

/** A name the user will recognise in the dashboard's list. Not a fingerprint:
 *  just enough to tell "the laptop's Chrome" from "the desktop's Edge". */
function guessBrowserName() {
  const ua = navigator.userAgent
  const brand = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Brave/.test(ua) ? 'Brave' : 'Chrome'
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${brand} (${os})` : brand
}

/** A dashboard on something other than localhost is not covered by the
 *  manifest's host_permissions, so the browser has to be asked first --
 *  and if it says no, that is what the user is told, not a network error. */
async function ensurePermission(baseUrl) {
  let origin
  try { origin = new URL(baseUrl).origin + '/*' } catch { return false }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(new URL(baseUrl).origin)) return true
  try { return await chrome.permissions.request({ origins: [origin] }) } catch { return false }
}

$('pairBtn').addEventListener('click', async () => {
  $('err').hidden = true
  const baseUrl = $('url').value.trim()
  if (!(await ensurePermission(baseUrl))) {
    $('err').textContent = msg('err_permission')
    $('err').hidden = false
    return
  }
  const res = await send({ type: 'pair', baseUrl, code: $('code').value.trim(), name: $('name').value.trim() })
  if (res && res.ok) { $('code').value = ''; await refresh(); return }
  const reason = (res && res.reason) || 'unknown_code'
  const key = { unknown_code: 'err_unknown_code', expired: 'err_expired', already_used: 'err_already_used', unreachable: 'err_unreachable' }[reason] || 'err_unknown_code'
  $('err').textContent = msg(key)
  $('err').hidden = false
})

$('unpairBtn').addEventListener('click', async () => { await send({ type: 'unpair' }); await refresh() })
$('auto').addEventListener('change', () => send({ type: 'setAutoFill', autoFill: $('auto').checked }))

refresh()
