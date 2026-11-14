import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import pino from 'pino'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { createWhatsAppManager } from './src/whatsapp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT || 10000)
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

await Promise.all([
  sessions.createIndex(
    { sessionId: 1 },
    {
      unique: true,
      name: 'sessionId_unique_string',
      partialFilterExpression: { sessionId: { $type: 'string' } }
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
      partialFilterExpression: { sessionId: { $type: 'string' } }
    }
  ),
  logs.createIndex({ createdAt: -1 })
]) 

const manager = createWhatsAppManager({ sessions, sessionKeys, users, logs, logger })

const allowed = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true)
    return cb(new Error('CORS origin denied'))
  }
}))
app.use(compression())
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false }))
app.disable('x-powered-by')

app.get('/health', async (_req, res) => {
  try {
    await db.command({ ping: 1 })
    res.json({ ok: true, database: 'MongoDB', uptime: process.uptime() })
  } catch {
    res.status(503).json({ ok: false })
  }
})

app.get('/api/status', async (_req, res) => {
  res.json(await manager.status())
})

app.get('/api/qr', async (req, res) => {
  const sessionId = manager.normalizeSessionId(req.query.sessionId)
  res.json(await manager.getQr(sessionId))
})

app.post('/api/pairing-code', async (req, res) => {
  try {
    const sessionId = manager.normalizeSessionId(req.body.sessionId)
    const phone = String(req.body.phone || '').replace(/\D/g, '')
    if (phone.length < 8 || phone.length > 15) {
      return res.status(400).json({ ok: false, message: 'Invalid international phone number.' })
    }
    const result = await manager.requestPairingCode(sessionId, phone)
    res.json(result)
  } catch (error) {
    logger.error({ err: error }, 'Pairing request failed')
    res.status(503).json({ ok: false, message: error.message || 'Pairing code request failed.' })
  }
})

app.get('/api/sessions', async (_req, res) => {
  res.json({ ok: true, sessions: await manager.listSessions() })
})

app.get('/api/session/:sessionId', async (req, res) => {
  const sessionId = manager.normalizeSessionId(req.params.sessionId)
  res.json(await manager.sessionInfo(sessionId))
})

app.post('/api/settings', async (req, res) => {
  const sessionId = manager.normalizeSessionId(req.body.sessionId)
  const value = {
    alwaysOnline: Boolean(req.body.alwaysOnline),
    autoViewStatus: Boolean(req.body.autoViewStatus),
    statusReact: Boolean(req.body.statusReact),
    welcome: Boolean(req.body.welcome),
    goodbye: Boolean(req.body.goodbye),
    autoReact: Boolean(req.body.autoReact),
    updatedAt: new Date()
  }
  await settings.updateOne({ sessionId }, { $set: value }, { upsert: true })
  res.json({ ok: true, settings: value })
})

app.get('/api/settings', async (req, res) => {
  const sessionId = manager.normalizeSessionId(req.query.sessionId)
  const doc = await settings.findOne({ sessionId }, { projection: { _id: 0 } })
  res.json({ ok: true, settings: doc || {
    alwaysOnline: true, autoViewStatus: true, statusReact: false,
    welcome: true, goodbye: false, autoReact: true
  } })
})

app.get('/api/logs', async (_req, res) => {
  const rows = await logs.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()
  res.json({ ok: true, logs: rows })
})

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}))
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'SCANTY MD BOT server running')
})

const shutdown = async signal => {
  logger.info({ signal }, 'Shutting down')
  await manager.stopAll()
  await mongo.close()
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
