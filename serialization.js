import { BufferJSON } from '@whiskeysockets/baileys'

export const encode = value => JSON.stringify(value, BufferJSON.replacer)
export const decode = value => JSON.parse(value, BufferJSON.reviver)
