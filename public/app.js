
const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]

const sessionKey = 'scanty_session_id'

let sessionId = localStorage.getItem(sessionKey)

if (!sessionId) {
  sessionId =
    'web_' +
    crypto.randomUUID().replaceAll('-', '')

  localStorage.setItem(sessionKey, sessionId)
}

const state = {
  startedAt: Date.now(),
  qrTimer: null,
  qrPoll: null,
  qrBusy: false
}

function toast(message) {
  const element = $('#toast')

  if (!element) return

  element.textContent = message
  element.classList.add('show')

  clearTimeout(toast.timer)

  toast.timer = setTimeout(() => {
    element.classList.remove('show')
  }, 3000)
}

async function api(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?'

  const url =
    path +
    separator +
    'sessionId=' +
    encodeURIComponent(sessionId)

  let body = options.body

  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)

      body = JSON.stringify({
        ...parsed,
        sessionId
      })
    } catch {}
  }

  const response = await fetch(url, {
    ...options,
    body,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  })

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      data.message || `Request failed (${response.status})`
    )
  }

  return data
}

function showSection(name) {
  $$('.nav-item').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.section === name
    )
  })

  $$('[data-panel]').forEach(panel => {
    panel.classList.toggle(
      'hidden',
      panel.dataset.panel !== name
    )
  })

  $('#sidebar')?.classList.remove('open')

  if (name === 'qr') {
    startQrPolling()
  }

  if (name === 'sessions') {
    loadSessions()
  }

  if (name === 'logs') {
    loadLogs()
  }
}

$$('.nav-item').forEach(button => {
  button.onclick = () => {
    showSection(button.dataset.section)
  }
})

$$('[data-go]').forEach(button => {
  button.onclick = () => {
    showSection(button.dataset.go)
  }
})

$('#menuBtn').onclick = () => {
  $('#sidebar')?.classList.toggle('open')
}

$('#logoutBtn').onclick = () => {
  toast('This dashboard has no login session to log out.')
}

function uptime() {
  const seconds = Math.floor(
    (Date.now() - state.startedAt) / 1000
  )

  const hours = String(
    Math.floor(seconds / 3600)
  ).padStart(2, '0')

  const minutes = String(
    Math.floor((seconds % 3600) / 60)
  ).padStart(2, '0')

  const secs = String(
    seconds % 60
  ).padStart(2, '0')

  $('#uptime').textContent =
    `${hours}:${minutes}:${secs}`
}

setInterval(uptime, 1000)

async function loadStatus() {
  try {
    const data = await api('/api/status')

    $('#totalAccounts').textContent = data.totalAccounts
    $('#normalUsers').textContent = data.normalUsers
    $('#admins').textContent = data.admins
    $('#botStatus').textContent = data.status
    $('#waStatus').textContent = data.whatsapp
    $('#runStatus').textContent = data.status
    $('#usersCount').textContent = data.normalUsers
  } catch {}
}

async function pairing() {
  const input = $('#phoneInput')

  const phone = input.value.replace(/\D/g, '')

  if (phone.length < 8) {
    toast('Enter a valid international number.')
    return
  }

  const button = $('#pairBtn')

  button.disabled = true

  $('#pairStatus').textContent = 'Connecting to WhatsApp…'
  $('#pairCode').textContent = '--------'

  try {
    const data = await api('/api/pairing-code', {
      method: 'POST',
      body: JSON.stringify({ phone })
    })

    if (data.code) {
      $('#pairCode').textContent = data.code

      $('#pairStatus').textContent =
        data.message || 'Pairing code ready'

      toast('Pairing code generated.')
    } else {
      throw new Error(
        data.message || 'No pairing code was returned.'
      )
    }
  } catch (error) {
    $('#pairStatus').textContent = error.message
    toast(error.message)
  } finally {
    button.disabled = false
  }
}

$('#pairBtn').onclick = pairing

function clearQr() {
  clearInterval(state.qrTimer)

  const box = $('#qrBox')

  if (!box) return

  box.innerHTML =
    '<div class="qr-placeholder">QR</div>'
}

function showQrPlaceholder(text) {
  const box = $('#qrBox')

  if (!box) return

  const placeholder = document.createElement('div')

  placeholder.className = 'qr-placeholder'
  placeholder.textContent = text

  box.replaceChildren(placeholder)
}

function startCountdown(seconds) {
  clearInterval(state.qrTimer)

  let remaining = Math.max(
    1,
    Number(seconds) || 60
  )

  $('#qrCountdown').textContent =
    `Expires in ${remaining}s`

  state.qrTimer = setInterval(() => {
    remaining--

    if (remaining > 0) {
      $('#qrCountdown').textContent =
        `Expires in ${remaining}s`

      return
    }

    clearInterval(state.qrTimer)

    $('#qrCountdown').textContent =
      'Waiting for a new QR…'
  }, 1000)
}

// Display the QR image generated by our server.
// No external browser QR library is needed.
function renderQr(qrImage) {
  const box = $('#qrBox')

  if (!box) return

  if (
    typeof qrImage !== 'string' ||
    !qrImage.startsWith('data:image/')
  ) {
    throw new Error(
      'Invalid QR image received from server.'
    )
  }

  const image = document.createElement('img')

  image.src = qrImage
  image.alt = 'WhatsApp QR Code'
  image.width = 280
  image.height = 280

  image.style.width = '280px'
  image.style.height = '280px'
  image.style.maxWidth = '100%'
  image.style.objectFit = 'contain'

  image.onerror = () => {
    showQrPlaceholder('QR image failed to display')
  }

  box.replaceChildren(image)
}

async function pollQr() {
  if (state.qrBusy) return

  state.qrBusy = true

  try {
    $('#qrState').textContent = 'Generating QR…'
    $('#qrCountdown').textContent = 'Please wait…'

    const data = await api('/api/qr')

    // WhatsApp QR image successfully generated.
    if (data.qrImage) {
      renderQr(data.qrImage)

      $('#qrState').textContent = 'Waiting for scan'

      startCountdown(data.expiresIn || 60)

      return
    }

    // QR string exists but image is missing.
    if (data.qr) {
      throw new Error(
        'WhatsApp QR received, but the image could not be generated.'
      )
    }

    // WhatsApp is already connected.
    if (data.state === 'open') {
      clearQr()

      $('#qrState').textContent =
        'WhatsApp already connected'

      $('#qrCountdown').textContent = ''

      showQrPlaceholder('Connected')

      return
    }

    // Backend is still connecting.
    $('#qrState').textContent =
      data.message || 'Waiting for WhatsApp QR…'

    $('#qrCountdown').textContent = 'Generating…'
  } catch (error) {
    $('#qrState').textContent =
      error.message || 'QR generation failed'

    $('#qrCountdown').textContent =
      'Press Refresh QR'

    showQrPlaceholder('Refresh QR')
  } finally {
    state.qrBusy = false
  }
}

function startQrPolling() {
  clearInterval(state.qrPoll)

  pollQr()

  state.qrPoll = setInterval(() => {
    pollQr()
  }, 3000)
}

$('#qrBtn').onclick = () => {
  pollQr()
}

async function loadSessions() {
  try {
    const response = await fetch('/api/sessions')

    const data = await response.json()

    $('#sessionsBody').innerHTML =
      data.sessions.map(session => `
        <tr>
          <td>
            ${escapeHtml(session.sessionId)}
          </td>

          <td>
            <span class="dot ${
              session.status === 'open'
                ? 'online'
                : ''
            }"></span>

            ${escapeHtml(session.status || 'unknown')}
          </td>

          <td>
            ${escapeHtml(session.phone || '—')}
          </td>

          <td>
            ${
              session.updatedAt
                ? new Date(session.updatedAt).toLocaleString()
                : '—'
            }
          </td>
        </tr>
      `).join('') ||
      '<tr><td colspan="4">No sessions yet.</td></tr>'
  } catch {}
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function loadSettings() {
  try {
    const data = await api('/api/settings')

    const settings = data.settings || {}

    const values = $$('.setting input')

    if (values[0]) {
      values[0].checked = settings.alwaysOnline !== false
    }

    if (values[1]) {
      values[1].checked = settings.autoViewStatus !== false
    }

    if (values[2]) {
      values[2].checked = settings.statusReact !== false
    }

    if (values[3]) {
      values[3].checked = settings.welcome !== false
    }

    if (values[4]) {
      values[4].checked = Boolean(settings.goodbye)
    }

    if (values[5]) {
      values[5].checked = settings.autoReact !== false
    }
  } catch (error) {
    toast('Could not load settings: ' + error.message)
  }
}

$('#saveSettings').onclick = async () => {
  const values = $$('.setting input')

  try {
    await api('/api/settings', {
      method: 'POST',

      body: JSON.stringify({
        alwaysOnline: values[0]?.checked,
        autoViewStatus: values[1]?.checked,
        statusReact: values[2]?.checked,
        welcome: values[3]?.checked,
        goodbye: values[4]?.checked,
        autoReact: values[5]?.checked
      })
    })

    toast('Settings saved.')
  } catch (error) {
    toast(error.message)
  }
}

async function loadLogs() {
  try {
    const response = await fetch('/api/logs')

    const data = await response.json()

    $('#logs').textContent =
      data.logs.map(entry =>
        `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.message}`
      ).join('\n') ||
      'No logs yet.'
  } catch {}
}

loadStatus()
loadSettings()
uptime()

setInterval(loadStatus, 5000)
