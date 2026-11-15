
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
  logger
}) {
  const session = await sessions.findOne({ sessionId })

  let creds

  if (session?.creds) {
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

  let saveQueue = Promise.resolve()

  const keys = {
    get: async (type, ids) => {
      if (!ids.length) return {}

      const docs = await sessionKeys.find({
        sessionId,
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
                filter: { sessionId, category, keyId }
              }
            })
          } else {
            operations.push({
              updateOne: {
                filter: { sessionId, category, keyId },
                update: {
                  $set: {
                    sessionId,
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
        await sessionKeys.bulkWrite(
          operations,
          { ordered: false }
        )
      }
    }
  }

  const saveCreds = () => {
    const snapshot = encode(creds)
    const registered = creds.registered === true

    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await sessions.updateOne(
        { sessionId },
        {
          $set: {
            sessionId,
            creds: snapshot,
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
        { sessionId, registered },
        'WhatsApp credentials saved to MongoDB'
      )
    })

    return saveQueue
  }

  const flushCreds = () => saveQueue

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(keys, logger)
  }

  return {
    state,
    saveCreds,
    flushCreds
  }
}
