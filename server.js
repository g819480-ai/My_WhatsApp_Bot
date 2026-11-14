
import { createAdminRouter } from './admin-routes.js'
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import pino from 'pino'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import QRCode from 'qrcode'
import { createWhatsAppManager } from './whatsapp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 10000)
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

if (!process.env.MONGO_URI) {
  logger.error('MONGO_URI is missing')
  process.exit(1)
}

const mongo = new MongoClient(process.env.MONGO_URI, {
  maxPoolSize: 10,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 10000
})

await mongo.connect()

const db = mongo.db(process.env.MONGO_DB_NAME || 'scanty_md_bot')
await db.command({ ping: 1 })

logger.info({ db: db.databaseName }, 'MongoDB connected')

const sessions = db.collection('whatsapp_sessions')
const sessionKeys = db.collection('whatsapp_session_keys')
const users = db.collection('bot_users')
const settings = db.collection('bot_settings')
const logs = db.collection('bot_logs')

// Remove obsolete legacy index without deleting any documents.
const settingsIndexes = await settings.indexes()

if (settingsIndexes.some(index => index.name === 'user_id_1')) {
  await settings.dropIndex('user_id_1')
  logger.warn('Removed obsolete bot_settings index: user_id_1')
}

await Promise.all([
  sessions.createIndex(
    { sessionId: 1 },
    {
      unique: true,
      name: 'sessionId_unique_string',
      partialFilterExpression: {
        sessionId: { $type: 'string' }
      }
    }
  ),

  sessionKeys.createIndex(
    { sessionId: 1, category: 1, keyId: 1 },
    {
      unique: true,
      name: 'session_keys_unique_valid',
      partialFilterExpression: {
        sessionId: { $type: 'string' },
        category: { $type: 'string' },
        keyId: { $type: 'string' }
      }
    }
  ),

  users.createIndex(
    { sessionId: 1 },
    {
      unique: true,
      name: 'users_sessionId_unique_string',
      partialFilterExpression: {
        sessionId: { $type: 'string' }
      }
    }
  ),

  settings.createIndex(
    { sessionId: 1 },
    {
      unique: true,
      name: 'settings_sessionId_unique_string',
      partialFilterExpression: {
        sessionId: { $type: 'string' }
      }
    }
  ),

  logs.createIndex({ createdAt: -1 })
])

const manager = createWhatsAppManager({
  sessions,
  sessionKeys,
  users,
  settings,
  logs,
  logger
})

try {
  const result = await manager.restoreSessions()

  logger.info(
    result,
    'WhatsApp saved sessions restoration completed'
  )
} catch (error) {
  logger.error(
    { err: error },
    'WhatsApp saved sessions restoration failed'
  )
}

const allowed = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean)

app.use(cors({
  origin(origin, cb) {
    if (
      !origin ||
      allowed.length === 0 ||
      allowed.includes(origin)
    ) {
      return cb(null, true)
    }

    return cb(new Error('CORS origin denied'))
  }
}))

app.use(compression())
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))
app.disable('x-powered-by')

app.use(
  '/api/admin',
  createAdminRouter({
    sessions,
    users,
    settings,
    logs,
    manager
  })
)

app.get('/health', async (_req, res) => {
  try {
    await db.command({ ping: 1 })

    res.json({
      ok: true,
      database: 'MongoDB',
      uptime: process.uptime()
    })
  } catch {
    res.status(503).json({ ok: false })
  }
})

app.get('/api/status', async (_req, res) => {
  res.json(await manager.status())
})

// Generate the QR image on the server.
// The dashboard no longer depends on an external QR library.
app.get('/api/qr', async (req, res) => {
  try {
    const sessionId = manager.normalizeSessionId(
      req.query.sessionId
    )

    const result = await manager.getQr(sessionId)

    if (result?.qr) {
      result.qrImage = await QRCode.toDataURL(
        result.qr,
        {
          width: 320,
          margin: 2,
          errorCorrectionLevel: 'M'
        }
      )
    }

    res.json(result)
  } catch (error) {
    logger.error(
      { err: error },
      'QR image generation failed'
    )

    res.status(500).json({
      ok: false,
      message: 'Could not generate QR image. Please refresh and try again.'
    })
  }
})

app.post('/api/pairing-code', async (req, res) => {
  try {
    const sessionId = manager.normalizeSessionId(
      req.body.sessionId || req.query.sessionId
    )

    const phone = String(
      req.body.phone || ''
    ).replace(/\D/g, '')

    if (
      phone.length < 8 ||
      phone.length > 15
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid international phone number.'
      })
    }

    res.json(
      await manager.requestPairingCode(
        sessionId,
        phone
      )
    )
  } catch (error) {
    logger.error(
      { err: error },
      'Pairing request failed'
    )

    res.status(503).json({
      ok: false,
      message: error.message || 'Pairing code request failed.'
    })
  }
})

app.get('/api/sessions', async (_req, res) => {
  res.json({
    ok: true,
    sessions: await manager.listSessions()
  })
})

app.get('/api/session/:sessionId', async (req, res) => {
  res.json(
    await manager.sessionInfo(
      manager.normalizeSessionId(req.params.sessionId)
    )
  )
})

app.post('/api/settings', async (req, res) => {
  const sessionId = manager.normalizeSessionId(
    req.body.sessionId || req.query.sessionId
  )

  const value = {
    alwaysOnline: req.body.alwaysOnline !== false,
    autoViewStatus: req.body.autoViewStatus !== false,
    statusReact: req.body.statusReact !== false,
    welcome: req.body.welcome !== false,
    goodbye: Boolean(req.body.goodbye),
    autoReact: req.body.autoReact !== false,
    statusReactEmoji: String(
      req.body.statusReactEmoji || '❤️'
    ).slice(0, 8),
    updatedAt: new Date()
  }

  await manager.updateSettings(sessionId, value)

  res.json({
    ok: true,
    settings: value
  })
})

app.get('/api/settings', async (req, res) => {
  const sessionId = manager.normalizeSessionId(
    req.query.sessionId
  )

  const defaults = {
    alwaysOnline: true,
    autoViewStatus: true,
    statusReact: true,
    welcome: true,
    goodbye: false,
    autoReact: true,
    statusReactEmoji: '❤️'
  }

  const doc = await settings.findOne(
    { sessionId },
    { projection: { _id: 0 } }
  )

  if (!doc) {
    await settings.updateOne(
      { sessionId },
      {
        $setOnInsert: {
          sessionId,
          ...defaults,
          createdAt: new Date()
        }
      },
      { upsert: true }
    )
  }

  res.json({
    ok: true,
    settings: {
      ...defaults,
      ...(doc || {})
    }
  })
})

app.get('/api/logs', async (_req, res) => {
  const rows = await logs.find(
    {},
    { projection: { _id: 0 } }
  )
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray()

  res.json({
    ok: true,
    logs: rows
  })
})

app.use(
  express.static(
    path.join(__dirname, 'public'),
    {
      extensions: ['html'],
      maxAge: process.env.NODE_ENV === 'production'
        ? '1h'
        : 0
    }
  )
)

app.get(/.*/, (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  )
})

const server = app.listen(PORT, () => {
  logger.info(
    { port: PORT },
    'SCANTY MD BOT server running'
  )
})

const shutdown = async signal => {
  logger.info({ signal }, 'Shutting down')

  await manager.stopAll()
  await mongo.close()

  server.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
