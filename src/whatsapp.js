import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { useMongoAuthState } from './mongo-auth.js'

const delay = ms => new Promise(r => setTimeout(r, ms))

export function createWhatsAppManager({ sessions, sessionKeys, users, logs, logger }) {
  const sockets = new Map()
  const locks = new Map()
  const qrCache = new Map()
  const pairingCache = new Map()

  const log = async (level, message, extra = {}) => {
    logger[level]?.(extra, message)
    try {
      await logs.insertOne({ message, ...extra, createdAt: new Date() })
    } catch {}
  }

  const normalizeSessionId = value => {
    const raw = String(value || '').trim()
    if (/^[a-zA-Z0-9_-]{12,80}$/.test(raw)) return raw
    return `web_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
  }

  async function start(sessionId, { pairing = false } = {}) {
    if (sockets.has(sessionId)) return sockets.get(sessionId)
    if (locks.has(sessionId)) return locks.get(sessionId)

    const promise = (async () => {
      const { state, saveCreds } = await useMongoAuthState({ sessions, sessionKeys, sessionId, logger })
      let version
      try {
        const latest = await fetchLatestBaileysVersion()
        version = latest.version
      } catch {
        version = [2, 3000, 1033898440]
      }

      const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        logger: logger.child({ sessionId, component: 'baileys' })
      })

      sockets.set(sessionId, { sock, sessionId, connectedAt: null, phone: null, pairingRequested: false })
      await sessions.updateOne(
        { sessionId },
        { $set: { sessionId, status: 'connecting', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      )

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async update => {
        const item = sockets.get(sessionId)
        if (!item) return
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          qrCache.set(sessionId, { qr, expiresAt: Date.now() + 60000 })
          await sessions.updateOne({ sessionId }, { $set: { status: 'qr', updatedAt: new Date() } })
          await log('info', 'WhatsApp QR generated', { sessionId })
        }

        if (connection === 'connecting') {
          await sessions.updateOne({ sessionId }, { $set: { status: 'connecting', updatedAt: new Date() } })
          if (pairing && !item.pairingRequested) {
            item.pairingRequested = true
            await delay(1200)
            try {
              const code = await sock.requestPairingCode(item.phone)
              pairingCache.set(sessionId, { code, expiresAt: Date.now() + 60000 })
              await sessions.updateOne({ sessionId }, { $set: { status: 'pairing', updatedAt: new Date() } })
              await log('info', 'WhatsApp pairing code generated', { sessionId })
            } catch (err) {
              item.pairingRequested = false
              await log('error', 'Pairing code generation failed', { sessionId, error: err.message })
            }
          }
        }

        if (connection === 'open') {
          item.connectedAt = item.connectedAt || Date.now()
          const phone = sock.user?.id?.split(':')[0] || item.phone || null
          item.phone = phone
          qrCache.delete(sessionId)
          pairingCache.delete(sessionId)
          await sessions.updateOne(
            { sessionId },
            { $set: { status: 'open', phone, connectedAt: new Date(item.connectedAt), updatedAt: new Date() } },
            { upsert: true }
          )
          await users.updateOne(
            { sessionId },
            { $set: { sessionId, phone, role: 'user', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
          )
          await log('info', 'WhatsApp connection opened', { sessionId, phone })
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode
          const loggedOut = statusCode === DisconnectReason.loggedOut
          await sessions.updateOne(
            { sessionId },
            { $set: { status: loggedOut ? 'logged_out' : 'closed', lastDisconnectCode: statusCode, updatedAt: new Date() } }
          )
          await log('warn', 'WhatsApp connection closed', { sessionId, statusCode, loggedOut })
          sockets.delete(sessionId)
          qrCache.delete(sessionId)
          pairingCache.delete(sessionId)

          if (!loggedOut && statusCode !== DisconnectReason.connectionReplaced) {
            setTimeout(() => start(sessionId).catch(err => logger.error({ err, sessionId }, 'Reconnect failed')), 3000)
          }
        }
      })

      sock.ev.on('messages.upsert', async event => {
        // Keep the base server efficient: command/feature handlers can be added here
        // without changing authentication or dashboard transport.
        if (event?.type === 'notify') {
          await sessions.updateOne({ sessionId }, { $set: { lastMessageAt: new Date() } }).catch(() => {})
        }
      })

      return sockets.get(sessionId)
    })().finally(() => locks.delete(sessionId))

    locks.set(sessionId, promise)
    return promise
  }

  async function getQr(sessionId) {
    const cached = qrCache.get(sessionId)
    if (cached && cached.expiresAt > Date.now()) {
      return { ok: true, state: 'waiting', qr: cached.qr, expiresIn: Math.ceil((cached.expiresAt - Date.now()) / 1000) }
    }
    if (cached) qrCache.delete(sessionId)

    const existing = sockets.get(sessionId)
    if (!existing) await start(sessionId)
    const fresh = qrCache.get(sessionId)
    if (fresh) {
      return { ok: true, state: 'waiting', qr: fresh.qr, expiresIn: Math.ceil((fresh.expiresAt - Date.now()) / 1000) }
    }
    const info = await sessionInfo(sessionId)
    return { ok: true, state: info.status || 'starting', qr: null, expiresIn: 0 }
  }

  async function requestPairingCode(sessionId, phone) {
    const existing = sockets.get(sessionId)
    if (existing?.sock?.user) {
      return { ok: false, message: 'This session is already connected. Use another session or unlink the device first.' }
    }
    const item = existing || await start(sessionId, { pairing: true })
    item.phone = phone
    if (!item.pairingRequested) {
      item.pairingRequested = true
      await delay(1000)
      try {
        const code = await item.sock.requestPairingCode(phone)
        pairingCache.set(sessionId, { code, expiresAt: Date.now() + 60000 })
      } catch (err) {
        item.pairingRequested = false
        throw new Error(err.message || 'WhatsApp rejected the pairing-code request')
      }
    }

    for (let i = 0; i < 25; i++) {
      const value = pairingCache.get(sessionId)
      if (value && value.expiresAt > Date.now()) {
        return { ok: true, code: value.code, message: 'Pairing code ready', expiresIn: Math.ceil((value.expiresAt - Date.now()) / 1000) }
      }
      if (sockets.get(sessionId)?.sock?.user) break
      await delay(200)
    }
    throw new Error('Pairing code was not generated before the timeout. Please try again.')
  }

  async function sessionInfo(sessionId) {
    const doc = await sessions.findOne({ sessionId }, { projection: { _id: 0, creds: 0 } })
    return { ok: true, ...doc, live: sockets.has(sessionId) }
  }

  async function listSessions() {
    return sessions.find({}, { projection: { _id: 0, creds: 0 } }).sort({ updatedAt: -1 }).limit(100).toArray()
  }

  async function status() {
    const totalAccounts = await sessions.countDocuments({ status: { $in: ['open', 'connecting', 'qr', 'pairing'] } })
    const admins = await users.countDocuments({ role: 'admin' })
    return {
      ok: true,
      status: sockets.size ? 'Online' : 'Idle',
      totalAccounts,
      normalUsers: await users.countDocuments({ role: { $ne: 'admin' } }),
      admins,
      database: 'Connected',
      whatsapp: sockets.size ? 'Active' : 'Waiting',
      uptime: process.uptime()
    }
  }

  async function stopAll() {
    for (const [sessionId, item] of sockets) {
      try { item.sock.end(undefined) } catch {}
      sockets.delete(sessionId)
    }
  }

  return { normalizeSessionId, start, getQr, requestPairingCode, sessionInfo, listSessions, status, stopAll }
}
