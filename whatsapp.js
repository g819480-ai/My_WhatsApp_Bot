
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'

import { useMongoAuthState } from './mongo-auth.js'
import { createMessageHandler } from './message-handler.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const DEFAULT_SETTINGS = {
  alwaysOnline: true,
  autoViewStatus: true,
  statusReact: true,
  welcome: true,
  goodbye: false,
  autoReact: true,
  statusReactEmoji: '❤️'
}

export function createWhatsAppManager({
  sessions,
  sessionKeys,
  users,
  settings,
  logs,
  logger
}) {
  const sockets = new Map()
  const startLocks = new Map()
  const qrCache = new Map()
  const qrWaiters = new Map()
  const pairingCache = new Map()
  const settingsCache = new Map()
  const reconnectTimers = new Map()

  let shuttingDown = false

  async function log(level, message, extra = {}) {
    try {
      logger[level]?.(extra, message)
    } catch {}

    try {
      await logs.insertOne({
        message,
        ...extra,
        createdAt: new Date()
      })
    } catch {}
  }

  function normalizeSessionId(value) {
    const raw = String(value || '').trim()

    if (/^[a-zA-Z0-9_-]{12,80}$/.test(raw)) {
      return raw
    }

    return `web_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
  }

  async function getSettings(sessionId) {
    if (settingsCache.has(sessionId)) {
      return settingsCache.get(sessionId)
    }

    let doc = await settings.findOne(
      { sessionId },
      { projection: { _id: 0 } }
    )

    if (!doc) {
      await settings.updateOne(
        { sessionId },
        {
          $setOnInsert: {
            sessionId,
            ...DEFAULT_SETTINGS,
            createdAt: new Date()
          }
        },
        { upsert: true }
      )

      doc = await settings.findOne(
        { sessionId },
        { projection: { _id: 0 } }
      )
    }

    const value = {
      ...DEFAULT_SETTINGS,
      ...(doc || {})
    }

    settingsCache.set(sessionId, value)

    return value
  }

  async function updateSettings(sessionId, patch) {
    const current = await getSettings(sessionId)

    const next = {
      ...current,
      ...patch,
      updatedAt: new Date()
    }

    await settings.updateOne(
      { sessionId },
      {
        $set: next,
        $setOnInsert: { sessionId }
      },
      { upsert: true }
    )

    settingsCache.set(sessionId, next)

    return next
  }

  
  async function sendText(sock, jid, text) {
    if (typeof text !== 'string' || !text.trim()) {
      return
    }

    if (!jid || jid === 'status@broadcast') {
      return
    }

    await sock.sendMessage(jid, {
      text: text.trim()
    })
  }

}
  if (typeof text !== 'string' || !text.trim()) return

  await sock.sendMessage(jid, { text: text.trim() })
}

  const handleIncoming = createMessageHandler({
    sessions,
    getSettings,
    updateSettings,
    sendText,
    log
  })

  function clearReconnectTimer(sessionId) {
    const timer = reconnectTimers.get(sessionId)

    if (timer) clearTimeout(timer)

    reconnectTimers.delete(sessionId)
  }

  function resolveQrWaiters(sessionId, value) {
    const waiters = qrWaiters.get(sessionId) || []

    qrWaiters.delete(sessionId)

    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
  }

  function rejectQrWaiters(sessionId, error) {
    const waiters = qrWaiters.get(sessionId) || []

    qrWaiters.delete(sessionId)

    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  function waitForQr(sessionId, timeout = 25000) {
    const cached = qrCache.get(sessionId)

    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null
      }

      waiter.timer = setTimeout(() => {
        const list = qrWaiters.get(sessionId) || []
        const remaining = list.filter(item => item !== waiter)

        if (remaining.length) {
          qrWaiters.set(sessionId, remaining)
        } else {
          qrWaiters.delete(sessionId)
        }

        reject(new Error(
          'WhatsApp did not generate a QR code in time. Please refresh and try again.'
        ))
      }, timeout)

      const list = qrWaiters.get(sessionId) || []

      list.push(waiter)
      qrWaiters.set(sessionId, list)
    })
  }

  function clearPairing(sessionId) {
    pairingCache.delete(sessionId)
  }

  async function start(sessionId, options = {}) {
    if (shuttingDown) {
      throw new Error('WhatsApp service is shutting down.')
    }

    const existing = sockets.get(sessionId)

    if (existing && !existing.closed) {
      if (options.phone && !existing.phone) {
        existing.phone = options.phone
      }

      return existing
    }

    const pending = startLocks.get(sessionId)

    if (pending) {
      const item = await pending

      if (options.phone && !item.phone) {
        item.phone = options.phone
      }

      return item
    }

    const startPromise = (async () => {
      await getSettings(sessionId)

      const { state, saveCreds } = await useMongoAuthState({
        sessions,
        sessionKeys,
        sessionId,
        logger
      })

      let version

      try {
        const latest = await fetchLatestBaileysVersion()
        version = latest.version
      } catch (error) {
        logger.warn(
          { err: error, sessionId },
          'Could not fetch latest WhatsApp version; using fallback'
        )

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
        logger: logger.child({
          sessionId,
          component: 'baileys'
        })
      })

      const item = {
        sock,
        sessionId,
        phone: options.phone || null,
        connectedAt: null,
        pairingPromise: null,
        closed: false,
        registered: state.creds.registered === true
      }

      sockets.set(sessionId, item)
      clearReconnectTimer(sessionId)

      await sessions.updateOne(
        { sessionId },
        {
          $set: {
            sessionId,
            status: 'connecting',
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      )

      sock.ev.on('creds.update', () => {
        item.registered = state.creds.registered === true

        saveCreds().catch(error => {
          log('error', 'WhatsApp credentials save failed', {
            sessionId,
            error: error?.message || String(error)
          })
        })
      })

      sock.ev.on('connection.update', update => {
        ;(async () => {
          if (sockets.get(sessionId) !== item || item.closed) {
            return
          }

          const { connection, lastDisconnect, qr } = update

          if (qr) {
            const qrData = {
              qr,
              expiresAt: Date.now() + 60000
            }

            qrCache.set(sessionId, qrData)

            await sessions.updateOne(
              { sessionId },
              {
                $set: {
                  status: 'qr',
                  updatedAt: new Date()
                }
              }
            )

            resolveQrWaiters(sessionId, qrData)

            await log('info', 'WhatsApp QR generated', {
              sessionId
            })
          }

          if (connection === 'connecting') {
            await sessions.updateOne(
              { sessionId },
              {
                $set: {
                  status: 'connecting',
                  updatedAt: new Date()
                }
              }
            )
          }

          if (connection === 'open') {
            item.connectedAt = item.connectedAt || Date.now()
            item.registered = true

            item.phone =
              sock.user?.id?.split(':')[0] ||
              item.phone ||
              null

            qrCache.delete(sessionId)
            clearPairing(sessionId)

            await sessions.updateOne(
              { sessionId },
              {
                $set: {
                  status: 'open',
                  phone: item.phone,
                  hasCreds: true,
                  connectedAt: new Date(item.connectedAt),
                  updatedAt: new Date()
                }
              },
              { upsert: true }
            )

            await users.updateOne(
              { sessionId },
              {
                $set: {
                  sessionId,
                  phone: item.phone,
                  role: 'user',
                  updatedAt: new Date()
                },
                $setOnInsert: {
                  createdAt: new Date()
                }
              },
              { upsert: true }
            )

            resolveQrWaiters(sessionId, { connected: true })

            const cfg = await getSettings(sessionId)

            const existingSession = await sessions.findOne(
              { sessionId },
              { projection: { welcomeSentAt: 1 } }
            )

            if (
              cfg.welcome &&
              !existingSession?.welcomeSentAt &&
              sock.user?.id
            ) {
              try {
                await sendText(
                  sock,
                  sock.user.id,
                  '✅ SCANTY MD BOT is now connected and ready!\n\nSend .menu to view available commands.'
                )

                await sessions.updateOne(
                  { sessionId },
                  {
                    $set: {
                      welcomeSentAt: new Date()
                    }
                  }
                )
              } catch (error) {
                await log('warn', 'Welcome message failed', {
                  sessionId,
                  error: error?.message || String(error)
                })
              }
            }

            await log('info', 'WhatsApp connection opened', {
              sessionId,
              phone: item.phone
            })
          }

          if (connection === 'close') {
            item.closed = true

            const statusCode =
              lastDisconnect?.error?.output?.statusCode

            const loggedOut =
              statusCode === DisconnectReason.loggedOut

            const replaced =
              statusCode === DisconnectReason.connectionReplaced

            const wasRegistered =
              item.registered ||
              state.creds.registered === true

            await sessions.updateOne(
              { sessionId },
              {
                $set: {
                  status: loggedOut ? 'logged_out' : 'closed',
                  lastDisconnectCode: statusCode ?? null,
                  updatedAt: new Date()
                }
              }
            )

            await log('warn', 'WhatsApp connection closed', {
              sessionId,
              statusCode: statusCode ?? null,
              loggedOut,
              registered: wasRegistered,
              connectionReplaced: replaced,
              error: lastDisconnect?.error?.message || null
            })

            rejectQrWaiters(
              sessionId,
              new Error(
                'WhatsApp disconnected before a QR code was received. Refresh QR and try again.'
              )
            )

            if (sockets.get(sessionId) === item) {
              sockets.delete(sessionId)
            }

            qrCache.delete(sessionId)
            clearPairing(sessionId)

            // Never create an automatic reconnect loop for an
            // unlinked visitor session.
            if (
              !shuttingDown &&
              wasRegistered &&
              !loggedOut &&
              !replaced
            ) {
              clearReconnectTimer(sessionId)

              const timer = setTimeout(() => {
                reconnectTimers.delete(sessionId)

                if (shuttingDown || sockets.has(sessionId)) {
                  return
                }

                start(sessionId).catch(error => {
                  log('error', 'WhatsApp reconnect failed', {
                    sessionId,
                    error: error?.message || String(error)
                  })
                })
              }, 4000)

              reconnectTimers.set(sessionId, timer)
            }
          }
        })().catch(error => {
          log('error', 'WhatsApp connection event handler failed', {
            sessionId,
            error: error?.message || String(error),
            stack: error?.stack
          })
        })
      })

      sock.ev.on('messages.upsert', event => {
        ;(async () => {
          if (sockets.get(sessionId) !== item || item.closed) {
            return
          }

          const messages = Array.isArray(event?.messages)
            ? event.messages
            : []

          if (!messages.length) return

          await log('info', 'MESSAGE EVENT RECEIVED', {
            sessionId,
            eventType: event?.type || 'unknown',
            messageCount: messages.length
          })

          if (event?.type !== 'notify') return

          await sessions.updateOne(
            { sessionId },
            {
              $set: {
                lastMessageAt: new Date()
              }
            }
          ).catch(() => {})

          for (const message of messages) {
            try {
              const jid = message?.key?.remoteJid

              if (jid === 'status@broadcast') {
                const config = await getSettings(sessionId)
                const key = message.key

                try {
                  if (config.autoViewStatus && key) {
                    await sock.readMessages([key])
                  }

                  if (config.statusReact && key) {
                    await sock.sendMessage(
                      jid,
                      {
                        react: {
                          text: config.statusReactEmoji || '❤️',
                          key
                        }
                      },
                      {
                        statusJidList: [key.participant].filter(Boolean)
                      }
                    )
                  }
                } catch (error) {
                  await log('warn', 'Status automation failed', {
                    sessionId,
                    error: error?.message || String(error)
                  })
                }

                continue
              }

              await handleIncoming(sessionId, sock, message)
            } catch (error) {
              await log('error', 'Message handler failed', {
                sessionId,
                messageId: message?.key?.id || null,
                error: error?.message || String(error),
                stack: error?.stack
              })
            }
          }
        })().catch(error => {
          log('error', 'WhatsApp messages event failed', {
            sessionId,
            error: error?.message || String(error)
          })
        })
      })

      return item
    })()

    startLocks.set(sessionId, startPromise)

    try {
      return await startPromise
    } finally {
      if (startLocks.get(sessionId) === startPromise) {
        startLocks.delete(sessionId)
      }
    }
  }

  async function getQr(sessionId) {
    let item = sockets.get(sessionId)

    if (item?.sock?.user) {
      return {
        ok: true,
        state: 'open',
        qr: null,
        expiresIn: 0,
        message: 'This WhatsApp session is already connected.'
      }
    }

    let cached = qrCache.get(sessionId)

    if (cached && cached.expiresAt > Date.now()) {
      return {
        ok: true,
        state: 'waiting',
        qr: cached.qr,
        expiresIn: Math.ceil((cached.expiresAt - Date.now()) / 1000)
      }
    }

    if (cached) qrCache.delete(sessionId)

    if (!item || item.closed) {
      item = await start(sessionId)
    }

    cached = qrCache.get(sessionId)

    if (cached && cached.expiresAt > Date.now()) {
      return {
        ok: true,
        state: 'waiting',
        qr: cached.qr,
        expiresIn: Math.ceil((cached.expiresAt - Date.now()) / 1000)
      }
    }

    if (item?.sock?.user) {
      return {
        ok: true,
        state: 'open',
        qr: null,
        expiresIn: 0
      }
    }

    try {
      const result = await waitForQr(sessionId, 25000)

      if (result.connected) {
        return {
          ok: true,
          state: 'open',
          qr: null,
          expiresIn: 0
        }
      }

      return {
        ok: true,
        state: 'waiting',
        qr: result.qr,
        expiresIn: Math.max(
          1,
          Math.ceil((result.expiresAt - Date.now()) / 1000)
        )
      }
    } catch (error) {
      const info = await sessionInfo(sessionId)

      if (info.status === 'open') {
        return {
          ok: true,
          state: 'open',
          qr: null,
          expiresIn: 0
        }
      }

      return {
        ok: false,
        state: info.status || 'connecting',
        qr: null,
        expiresIn: 0,
        message: error?.message || 'QR generation failed. Please refresh QR.'
      }
    }
  }

  async function waitForSocketOpen(item, timeout = 15000) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeout) {
      if (item.closed || sockets.get(item.sessionId) !== item) {
        throw new Error('WhatsApp connection closed. Please try again.')
      }

      if (item.sock?.user) {
        throw new Error('This WhatsApp session is already connected.')
      }

      // ws readyState 1 means the WebSocket is open.
      if (item.sock?.ws?.readyState === 1) {
        return
      }

      await delay(250)
    }

    throw new Error(
      'WhatsApp WebSocket did not become ready. Please refresh and try again.'
    )
  }

  async function requestPairingCode(sessionId, phone) {
    const normalizedPhone = String(phone || '').replace(/\D/g, '')

    if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
      throw new Error(
        'Enter a valid international phone number including country code.'
      )
    }

    let item = sockets.get(sessionId)

    if (item?.sock?.user) {
      return {
        ok: false,
        message: 'This WhatsApp session is already connected. Use a new session to link another number.'
      }
    }

    if (!item || item.closed) {
      item = await start(sessionId, {
        phone: normalizedPhone
      })
    }

    item.phone = normalizedPhone

    const cached = pairingCache.get(sessionId)

    if (cached && cached.expiresAt > Date.now()) {
      return {
        ok: true,
        code: cached.code,
        message: 'Pairing code ready',
        expiresIn: Math.ceil((cached.expiresAt - Date.now()) / 1000)
      }
    }

    if (!item.pairingPromise) {
      item.pairingPromise = (async () => {
        await waitForSocketOpen(item)

        if (item.sock?.user) {
          throw new Error('This WhatsApp session is already connected.')
        }

        const code = await item.sock.requestPairingCode(normalizedPhone)

        const result = {
          code,
          expiresAt: Date.now() + 60000
        }

        pairingCache.set(sessionId, result)

        await sessions.updateOne(
          { sessionId },
          {
            $set: {
              status: 'pairing',
              updatedAt: new Date()
            }
          }
        )

        await log('info', 'WhatsApp pairing code generated', {
          sessionId
        })

        return code
      })().finally(() => {
        item.pairingPromise = null
      })
    }

    const code = await item.pairingPromise
    const result = pairingCache.get(sessionId)

    return {
      ok: true,
      code,
      message: 'Pairing code ready',
      expiresIn: result
        ? Math.ceil((result.expiresAt - Date.now()) / 1000)
        : 60
    }
  }

  async function sessionInfo(sessionId) {
    const doc = await sessions.findOne(
      { sessionId },
      {
        projection: {
          _id: 0,
          creds: 0
        }
      }
    )

    return {
      ok: true,
      ...doc,
      live: sockets.has(sessionId)
    }
  }

  async function listSessions() {
    return sessions.find(
      {},
      {
        projection: {
          _id: 0,
          creds: 0
        }
      }
    )
      .sort({ updatedAt: -1 })
      .limit(100)
      .toArray()
  }

  async function restoreSessions() {
    await log('info', 'Saved WhatsApp session restoration started')

    const savedSessions = await sessions.find({
      hasCreds: true,
      creds: {
        $exists: true,
        $ne: null
      },
      status: {
        $ne: 'logged_out'
      }
    })
      .project({ sessionId: 1 })
      .toArray()

    let started = 0
    let failed = 0

    for (const saved of savedSessions) {
      if (!saved.sessionId) continue

      try {
        await start(saved.sessionId)
        started++

        await log('info', 'Saved WhatsApp session socket started', {
          sessionId: saved.sessionId
        })
      } catch (error) {
        failed++

        await log('error', 'Saved WhatsApp session restoration failed', {
          sessionId: saved.sessionId,
          error: error?.message || String(error)
        })
      }
    }

    const result = {
      found: savedSessions.length,
      started,
      failed
    }

    await log('info', 'Saved WhatsApp session restoration finished', result)

    return result
  }

  async function status() {
    const totalAccounts = await sessions.countDocuments({
      status: {
        $in: ['open', 'connecting', 'qr', 'pairing']
      }
    })

    const admins = await users.countDocuments({
      role: 'admin'
    })

    return {
      ok: true,
      status: sockets.size ? 'Online' : 'Idle',
      totalAccounts,
      normalUsers: await users.countDocuments({
        role: { $ne: 'admin' }
      }),
      admins,
      database: 'Connected',
      whatsapp: sockets.size ? 'Active' : 'Waiting',
      uptime: process.uptime()
    }
  }

  async function stopAll() {
    shuttingDown = true

    for (const timer of reconnectTimers.values()) {
      clearTimeout(timer)
    }

    reconnectTimers.clear()

    for (const [sessionId, item] of sockets) {
      item.closed = true

      try {
        item.sock.end(undefined)
      } catch {}

      sockets.delete(sessionId)
    }

    for (const sessionId of qrWaiters.keys()) {
      rejectQrWaiters(
        sessionId,
        new Error('WhatsApp service is shutting down.')
      )
    }

    qrCache.clear()
    pairingCache.clear()
  }

  return {
    normalizeSessionId,
    start,
    getQr,
    requestPairingCode,
    sessionInfo,
    listSessions,
    restoreSessions,
    status,
    updateSettings,
    stopAll
  }
}
