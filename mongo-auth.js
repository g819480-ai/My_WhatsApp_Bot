
import { randomUUID } from 'node:crypto'

import {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'

const encode = value =>
  JSON.stringify(value, BufferJSON.replacer)

const decode = value =>
  JSON.parse(value, BufferJSON.reviver)

export async function useMongoAuthState({
  sessions,
  sessionKeys,
  sessionId,
  logger,
  freshAuth = false
}) {
  const session = await sessions.findOne({ sessionId })

  // Only create a fresh generation when the caller explicitly
  // requests it for a session confirmed as logged out.
  const startFresh =
    freshAuth === true &&
    session?.status === 'logged_out'

  const authGeneration = startFresh
    ? randomUUID()
    : session?.authGeneration || null

  let creds

  if (startFresh) {
    creds = initAuthCreds()

    const archive = session.creds
      ? {
          savedAt: new Date(),
          authGeneration: session.authGeneration || null,
          creds: session.creds
        }
      : null

    const update = {
      $set: {
        authGeneration,
        hasCreds: false,
        status: 'connecting',
        updatedAt: new Date()
      }
    }

    if (archive) {
      update.$push = { previousAuth: archive }
    }

    await sessions.updateOne(
      { sessionId, status: 'logged_out' },
      update
    )

    logger?.info?.(
      { sessionId, authGeneration },
      'Starting fresh WhatsApp authentication generation'
    )
  } else if (session?.creds) {
    try {
      creds = decode(session.creds)
    } catch (err) {
      logger?.error?.(
        { err, sessionId },
        'Saved WhatsApp credentials could not be decoded'
      )

      throw new Error(
        'Saved WhatsApp credentials are unreadable. Existing session data was preserved.'
      )
    }
  } else {
    creds = initAuthCreds()
  }

  const keyScope = authGeneration
    ? { sessionId, authGeneration }
    : {
        sessionId,
        authGeneration: { $exists: false }
      }

  let saveQueue = Promise.resolve()
  let keyQueue = Promise.resolve()

  const keys = {
    get: async (type, ids) => {
      if (!ids.length) return {}

      const docs = await sessionKeys.find({
        ...keyScope,
        category: type,
        keyId: { $in: ids }
      }).toArray()

      const values = new Map(
        docs.map(doc => [doc.keyId, doc.value])
      )

      const result = {}

      for (const id of ids) {
        const value = values.get(id)

        if (value === undefined || value === null) continue

        try {
          result[id] = decode(value)
        } catch (err) {
          logger?.error?.(
            { err, sessionId, category: type, keyId: id },
            'Saved WhatsApp session key could not be decoded'
          )
          throw err
        }
      }

      return result
    },

    set: async data => {
      const operations = []

      for (const category of Object.keys(data || {})) {
        const values = data[category] || {}

        for (const keyId of Object.keys(values)) {
          const value = values[keyId]

          if (value === null || value === undefined) {
            operations.push({
              deleteOne: {
                filter: {
                  ...keyScope,
                  category,
                  keyId
                }
              }
            })
          } else {
            operations.push({
              updateOne: {
                filter: {
                  ...keyScope,
                  category,
                  keyId
                },
                update: {
                  $set: {
                    sessionId,
                    authGeneration,
                    category,
                    keyId,
                    value: encode(value),
                    updatedAt: new Date()
                  }
                },
                upsert: true
              }
            })
          }
        }
      }

      if (operations.length) {
        keyQueue = keyQueue
          .catch(() => {})
          .then(() =>
            sessionKeys.bulkWrite(
              operations,
              { ordered: false }
            )
          )

        await keyQueue
      }
    }
  }

  const saveCreds = () => {
    const snapshot = encode(creds)
    const registered = creds.registered === true

    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        await sessions.updateOne(
          { sessionId },
          {
            $set: {
              sessionId,
              creds: snapshot,
              authGeneration,
              hasCreds: registered,
              updatedAt: new Date()
            },
            $setOnInsert: {
              createdAt: new Date()
            }
          },
          { upsert: true }
        )

        logger?.info?.(
          { sessionId, registered, authGeneration },
          'WhatsApp credentials saved to MongoDB'
        )
      })

    return saveQueue
  }

  const flushCreds = async () => {
    await Promise.all([
      saveQueue,
      keyQueue
    ])
  }

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(keys, logger)
  }

  return {
    state,
    saveCreds,
    flushCreds,
    authGeneration
  }
}
