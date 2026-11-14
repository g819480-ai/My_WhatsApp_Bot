import {
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'

const encode = value => JSON.stringify(value, BufferJSON.replacer)
const decode = value => JSON.parse(value, BufferJSON.reviver)

export async function useMongoAuthState({ sessions, sessionKeys, sessionId, logger }) {
  const session = await sessions.findOne({ sessionId })

  let creds
  if (session?.creds) {
    try {
      creds = decode(session.creds)
    } catch (err) {
      logger.warn({ err, sessionId }, 'Stored credentials could not be decoded; creating fresh credentials')
      creds = initAuthCreds()
    }
  } else {
    creds = initAuthCreds()
  }

  const keys = {
    get: async (type, ids) => {
      const docs = await sessionKeys.find({
        sessionId,
        category: type,
        keyId: { $in: ids }
      }).toArray()

      const out = {}
      for (const id of ids) {
        const doc = docs.find(x => x.keyId === id)
        if (doc?.value) out[id] = decode(doc.value)
      }
      return out
    },
    set: async data => {
      const ops = []
      for (const category of Object.keys(data)) {
        const values = data[category] || {}
        for (const keyId of Object.keys(values)) {
          const value = values[keyId]
          if (value === null || value === undefined) {
            ops.push({
              deleteOne: { filter: { sessionId, category, keyId } }
            })
          } else {
            ops.push({
              updateOne: {
                filter: { sessionId, category, keyId },
                update: { $set: { sessionId, category, keyId, value: encode(value), updatedAt: new Date() } },
                upsert: true
              }
            })
          }
        }
      }
      if (ops.length) await sessionKeys.bulkWrite(ops, { ordered: false })
    }
  }

  const saveCreds = async () => {
    await sessions.updateOne(
      { sessionId },
      {
        $set: {
          sessionId,
          creds: encode(creds),
          hasCreds: true,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    )
  }

  const state = {
    creds,
    keys: makeCacheableSignalKeyStore(keys, logger)
  }

  return { state, saveCreds }
}
