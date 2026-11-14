
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
  const locks = new Map()
  const qrCache = new Map()
  const pairingCache = new Map()
  const settingsCache = new Map()

  const log = async (level, message, extra = {}) => {
    logger[level]?.(extra, message)

    try {
      await logs.insertOne({
        message,
        ...extra,
        createdAt: new Date()
      })
    } catch {}
  }

  const normalizeSessionId = value => {
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
    if (!jid) return

    await sock.sendMessage(jid, { text })
  }

  const handleIncoming = createMessageHandler({
    sessions,
    getSettings,
    updateSettings,
    sendText,
    log
  })

  async function start(sessionId, { pairing = false } = {}) {
    if (sockets.has(sessionId)) {
      return sockets.get(sessionId)
    }

    if (locks.has(sessionId)) {
      return locks.get(sessionId)
    }

    const promise = (async () => {
      await getSettings(sessionId)

      const { state, saveCreds } =
        await useMongoAuthState({
          sessions,
          sessionKeys,
          sessionId,
          logger
        })

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
        logger: logger.child({
          sessionId,
          component: 'baileys'
        })
      })

      const item = {
        sock,
        sessionId,
        connectedAt: null,
        phone: null,
        pairingRequested: false
      }

      sockets.set(sessionId, item)

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

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async update => {
        const live = sockets.get(sessionId)

        if (!live) return

        const {
          connection,
          lastDisconnect,
          qr
        } = update

        if (qr) {
          qrCache.set(sessionId, {
            qr,
            expiresAt: Date.now() + 60000
          })

          await sessions.updateOne(
            { sessionId },
            {
              $set: {
                status: 'qr',
                updatedAt: new Date()
              }
            }
          )

          await log(
            'info',
            'WhatsApp QR generated',
            { sessionId }
          )
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

          if (
            pairing &&
            !live.pairingRequested &&
            live.phone
          ) {
            live.pairingRequested = true

            await delay(1200)

            try {
              const code =
                await sock.requestPairingCode(live.phone)

              pairingCache.set(sessionId, {
                code,
                expiresAt: Date.now() + 60000
              })

              await sessions.updateOne(
                { sessionId },
                {
                  $set: {
                    status: 'pairing',
                    updatedAt: new Date()
                  }
                }
              )

              await log(
                'info',
                'WhatsApp pairing code generated',
                { sessionId }
              )
            } catch (err) {
              live.pairingRequested = false

              await log(
                'error',
                'Pairing code generation failed',
                {
                  sessionId,
                  error: err.message
                }
              )
            }
          }
        }

        if (connection === 'open') {
          live.connectedAt =
            live.connectedAt || Date.now()

          const phone =
            sock.user?.id?.split(':')[0] ||
            live.phone ||
            null

          live.phone = phone

          qrCache.delete(sessionId)
          pairingCache.delete(sessionId)

          await sessions.updateOne(
            { sessionId },
            {
              $set: {
                status: 'open',
                phone,
                connectedAt: new Date(live.connectedAt),
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
                phone,
                role: 'user',
                updatedAt: new Date()
              },
              $setOnInsert: {
                createdAt: new Date()
              }
            },
            { upsert: true }
          )

          const cfg = await getSettings(sessionId)

          const existing = await sessions.findOne(
            { sessionId },
            {
              projection: {
                welcomeSentAt: 1
              }
            }
          )

          if (
            cfg.welcome &&
            !existing?.welcomeSentAt
          ) {
            const selfJid = sock.user?.id

            if (selfJid) {
              await sendText(
                sock,
                selfJid,
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
            }
          }

          await log(
            'info',
            'WhatsApp connection opened',
            { sessionId, phone }
          )
        }

        if (connection === 'close') {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode

          const loggedOut =
            statusCode === DisconnectReason.loggedOut

          await sessions.updateOne(
            { sessionId },
            {
              $set: {
                status: loggedOut ? 'logged_out' : 'closed',
                lastDisconnectCode: statusCode,
                updatedAt: new Date()
              }
            }
          )

          await log(
            'warn',
            'WhatsApp connection closed',
            {
              sessionId,
              statusCode,
              loggedOut
            }
          )

          sockets.delete(sessionId)
          qrCache.delete(sessionId)
          pairingCache.delete(sessionId)

          if (
            !loggedOut &&
            statusCode !== DisconnectReason.connectionReplaced
          ) {
            setTimeout(() => {
              start(sessionId).catch(err =>
                logger.error(
                  { err, sessionId },
                  'Reconnect failed'
                )
              )
            }, 3000)
          }
        }
      })

      sock.ev.on('messages.upsert', async event => {
        const messages = Array.isArray(event?.messages)
          ? event.messages
          : []

        await log('info', 'MESSAGE EVENT RECEIVED', {
          sessionId,
          eventType: event?.type || 'unknown',
          messageCount: messages.length
        })

        if (event?.type !== 'notify' || messages.length === 0) {
          return
        }

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
      })

      return item
    })()

    locks.set(sessionId, promise)

    try {
      return await promise
    } finally {
      locks.delete(sessionId)
    }
  }

  async function getQr(sessionId) {
    const cached = qrCache.get(sessionId)

    if (
      cached &&
      cached.expiresAt > Date.now()
    ) {
      return {
        ok: true,
        state: 'waiting',
        qr: cached.qr,
        expiresIn: Math.ceil(
          (cached.expiresAt - Date.now()) / 1000
        )
      }
    }

    if (cached) {
      qrCache.delete(sessionId)
    }

    if (!sockets.has(sessionId)) {
      await start(sessionId)
    }

    const fresh = qrCache.get(sessionId)

    if (fresh) {
      return {
        ok: true,
        state: 'waiting',
        qr: fresh.qr,
        expiresIn: Math.ceil(
          (fresh.expiresAt - Date.now()) / 1000
        )
      }
    }

    const info = await sessionInfo(sessionId)

    return {
      ok: true,
      state: info.status || 'starting',
      qr: null,
      expiresIn: 0
    }
  }

  async function requestPairingCode(sessionId, phone) {
    let item = sockets.get(sessionId)

    if (item?.sock?.user) {
      return {
        ok: false,
        message: 'This session is already connected. Use another session or unlink the device first.'
      }
    }

    if (!item) {
      item = await start(sessionId, { pairing: true })
    }

    item.phone = phone

    if (!item.pairingRequested) {
      item.pairingRequested = true

      await delay(1200)

      try {
        const code =
          await item.sock.requestPairingCode(phone)

        pairingCache.set(sessionId, {
          code,
          expiresAt: Date.now() + 60000
        })
      } catch (err) {
        item.pairingRequested = false

        throw new Error(
          err.message ||
          'WhatsApp rejected the pairing-code request'
        )
      }
    }

    for (let i = 0; i < 30; i++) {
      const value = pairingCache.get(sessionId)

      if (
        value &&
        value.expiresAt > Date.now()
      ) {
        return {
          ok: true,
          code: value.code,
          message: 'Pairing code ready',
          expiresIn: Math.ceil(
            (value.expiresAt - Date.now()) / 1000
          )
        }
      }

      if (sockets.get(sessionId)?.sock?.user) {
        break
      }

      await delay(200)
    }

    throw new Error(
      'Pairing code was not generated before the timeout. Please try again.'
    )
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
    await log(
      'info',
      'Saved WhatsApp session restoration started'
    )

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

    let restored = 0
    let failed = 0

    for (const session of savedSessions) {
      if (!session.sessionId) continue

      try {
        await start(session.sessionId)

        restored++

        await log(
          'info',
          'Saved WhatsApp session socket started',
          {
            sessionId: session.sessionId
          }
        )
      } catch (error) {
        failed++

        await log(
          'error',
          'Saved WhatsApp session restoration failed',
          {
            sessionId: session.sessionId,
            error: error.message
          }
        )
      }
    }

    const result = {
      found: savedSessions.length,
      started: restored,
      failed
    }

    await log(
      'info',
      'Saved WhatsApp session restoration finished',
      result
    )

    return result
  }

  async function status() {
    const totalAccounts =
      await sessions.countDocuments({
        status: {
          $in: [
            'open',
            'connecting',
            'qr',
            'pairing'
          ]
        }
      })

    const admins =
      await users.countDocuments({
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
    for (const [sessionId, item] of sockets) {
      try {
        item.sock.end(undefined)
      } catch {}

      sockets.delete(sessionId)
    }
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
