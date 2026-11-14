
import express from 'express'
import crypto from 'node:crypto'

const GLOBAL_SESSION_ID = '__global__'
const COOKIE_NAME = 'scanty_admin'
const SESSION_DURATION = 8 * 60 * 60 * 1000

const DEFAULT_SETTINGS = {
  alwaysOnline: true,
  autoViewStatus: true,
  statusReact: true,
  welcome: true,
  goodbye: false,
  autoReact: true,
  statusReactEmoji: '❤️'
}

function sign(value, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(value)
    .digest('base64url')
}

function createToken(secret) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + SESSION_DURATION
  })).toString('base64url')

  return `${payload}.${sign(payload, secret)}`
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return false

  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [payload, signature] = parts
  const expected = sign(payload, secret)

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)

  if (a.length !== b.length) return false
  if (!crypto.timingSafeEqual(a, b)) return false

  try {
    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString()
    )

    return Number(data.exp) > Date.now()
  } catch {
    return false
  }
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '')
    .split(';')

  for (const cookie of cookies) {
    const index = cookie.indexOf('=')
    if (index < 0) continue

    const key = cookie.slice(0, index).trim()

    if (key === name) {
      return decodeURIComponent(
        cookie.slice(index + 1).trim()
      )
    }
  }

  return null
}

function setAdminCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production'
    ? '; Secure'
    : ''

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION / 1000}${secure}`
  )
}

function clearAdminCookie(res) {
  const secure = process.env.NODE_ENV === 'production'
    ? '; Secure'
    : ''

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  )
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))

  return left.length === right.length &&
    crypto.timingSafeEqual(left, right)
}

export function createAdminRouter({
  sessions,
  users,
  settings,
  logs,
  manager
}) {
  const router = express.Router()

  const password = process.env.ADMIN_PASSWORD
  const secret = process.env.ADMIN_SESSION_SECRET

  const loginAttempts = new Map()

  function requireAdmin(req, res, next) {
    if (!password || !secret || secret.length < 32) {
      return res.status(503).json({
        ok: false,
        message: 'Admin access is not configured.'
      })
    }

    const token = getCookie(req, COOKIE_NAME)

    if (!verifyToken(token, secret)) {
      return res.status(401).json({
        ok: false,
        message: 'Administrator login required.'
      })
    }

    next()
  }

  router.post('/login', (req, res) => {
    if (!password || !secret || secret.length < 32) {
      return res.status(503).json({
        ok: false,
        message: 'Set ADMIN_PASSWORD and an ADMIN_SESSION_SECRET of at least 32 characters.'
      })
    }

    const ip = req.ip || 'unknown'
    const now = Date.now()
    const attempt = loginAttempts.get(ip)

    if (attempt && now < attempt.resetAt && attempt.count >= 8) {
      return res.status(429).json({
        ok: false,
        message: 'Too many login attempts. Try again later.'
      })
    }

    const supplied = String(req.body?.password || '')

    if (!safeEqual(supplied, password)) {
      const current = attempt && now < attempt.resetAt
        ? attempt
        : { count: 0, resetAt: now + 15 * 60 * 1000 }

      current.count++
      loginAttempts.set(ip, current)

      return res.status(401).json({
        ok: false,
        message: 'Incorrect administrator password.'
      })
    }

    loginAttempts.delete(ip)

    setAdminCookie(res, createToken(secret))

    res.json({ ok: true })
  })

  router.get('/me', requireAdmin, (_req, res) => {
    res.json({ ok: true })
  })

  router.post('/logout', (_req, res) => {
    clearAdminCookie(res)
    res.json({ ok: true })
  })

  router.use(requireAdmin)

  router.get('/overview', async (_req, res, next) => {
    try {
      const [
        totalUsers,
        totalSessions,
        connected,
        offline
      ] = await Promise.all([
        users.countDocuments({ role: { $ne: 'admin' } }),
        sessions.countDocuments({}),
        sessions.countDocuments({ status: 'open' }),
        sessions.countDocuments({
          status: { $nin: ['open', 'connecting', 'qr', 'pairing'] }
        })
      ])

      res.json({
        ok: true,
        totalUsers,
        totalSessions,
        connected,
        offline
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/users', async (_req, res, next) => {
    try {
      const userRows = await users.find(
        { role: { $ne: 'admin' } },
        { projection: { _id: 0 } }
      ).sort({ updatedAt: -1 }).limit(500).toArray()

      const sessionIds = userRows
        .map(user => user.sessionId)
        .filter(Boolean)

      const sessionRows = await sessions.find(
        { sessionId: { $in: sessionIds } },
        {
          projection: {
            _id: 0,
            sessionId: 1,
            status: 1,
            phone: 1,
            updatedAt: 1
          }
        }
      ).toArray()

      const byId = new Map(
        sessionRows.map(session => [session.sessionId, session])
      )

      const result = userRows.map(user => {
        const session = byId.get(user.sessionId)

        return {
          sessionId: user.sessionId,
          phone: session?.phone || user.phone || null,
          status: session?.status || 'no_session',
          sessionRemoved: !session,
          updatedAt: session?.updatedAt || user.updatedAt || user.createdAt
        }
      })

      res.json({ ok: true, users: result })
    } catch (error) {
      next(error)
    }
  })

  router.get('/sessions', async (_req, res, next) => {
    try {
      const rows = await manager.listSessions()
      res.json({ ok: true, sessions: rows })
    } catch (error) {
      next(error)
    }
  })

  router.get('/logs', async (_req, res, next) => {
    try {
      const rows = await logs.find(
        {},
        { projection: { _id: 0 } }
      ).sort({ createdAt: -1 }).limit(200).toArray()

      res.json({ ok: true, logs: rows })
    } catch (error) {
      next(error)
    }
  })

  router.get('/settings', async (_req, res, next) => {
    try {
      const doc = await settings.findOne(
        { sessionId: GLOBAL_SESSION_ID },
        { projection: { _id: 0 } }
      )

      res.json({
        ok: true,
        settings: {
          ...DEFAULT_SETTINGS,
          ...(doc || {})
        }
      })
    } catch (error) {
      next(error)
    }
  })

  router.put('/settings', async (req, res, next) => {
    try {
      const allowed = [
        'alwaysOnline',
        'autoViewStatus',
        'statusReact',
        'welcome',
        'goodbye',
        'autoReact'
      ]

      const patch = {}

      for (const key of allowed) {
        if (typeof req.body?.[key] === 'boolean') {
          patch[key] = req.body[key]
        }
      }

      if (typeof req.body?.statusReactEmoji === 'string') {
        patch.statusReactEmoji =
          req.body.statusReactEmoji.trim().slice(0, 8) || '❤️'
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({
          ok: false,
          message: 'No valid settings were supplied.'
        })
      }

      const updated = await manager.updateGlobalSettings(patch)

      res.json({
        ok: true,
        settings: updated
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/sessions/:sessionId/disconnect', async (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '')

      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(sessionId)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid session ID.'
        })
      }

      await manager.disconnectSession(sessionId)

      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/sessions/:sessionId', async (req, res, next) => {
    try {
      const sessionId = String(req.params.sessionId || '')

      if (!/^[a-zA-Z0-9_-]{12,80}$/.test(sessionId)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid session ID.'
        })
      }

      await manager.removeSession(sessionId)

      res.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  return router
}
