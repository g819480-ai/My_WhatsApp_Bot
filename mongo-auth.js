
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
      logger?.warn?.(
        { err, sessionId },
        'Stored credentials could not be decoded; creating fresh credentials'
      )

      creds = initAuthCreds()
    }
  } else {
    creds = initAuthCreds()
  }

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

        if (value !== undefined && value !== null) {
          try {
            result[id] = decode(value)
          } catch (err) {
            logger?.warn?.(
              { err, sessionId, category: type, keyId: id },
              'Could not decode stored WhatsApp session key'
            )
          }
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
                  sessionId,
                  category,
                  keyId
                }
              }
            })
          } else {
            operations.push({
              updateOne: {
                filter: {
                  sessionId,
                  category,
                  keyId
                },
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

  const saveCreds = async () => {
    // Only a registered WhatsApp account is a restorable session.
    // Freshly initialized credentials must not be treated as linked.
    const registered = creds.registered === true

    await sessions.updateOne(
      { sessionId },
      {
        $set: {
          sessionId,
          creds: encode(creds),
          hasCreds: registered,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true }
    )
  }

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(keys, logger)
  }

  return {
    state,
    saveCreds
  }
}
