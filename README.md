# SCANTY MD BOT — Full Working Dashboard + WhatsApp Backend

This repository is a complete starting point for the SCANTY MD BOT dashboard and a MongoDB-backed Baileys WhatsApp transport.

## Stack
- Node.js 20+
- Express
- MongoDB Atlas
- `@whiskeysockets/baileys` 6.7.24
- Responsive dashboard matching the supplied design

Baileys currently lists 6.7.24 as a stable release; 7.x introduces breaking changes, so this project deliberately uses the stable 6.7.24 line rather than the 7.x RC line. See the official Baileys release history and documentation.

## 1. Install

```bash
npm install
```

## 2. Environment

Copy `.env.example` to `.env` and set:

```env
MONGO_URI=your_mongodb_atlas_uri
MONGO_DB_NAME=scanty_md_bot
PORT=10000
SESSION_SECRET=use_a_long_random_value
```

Create/allow a MongoDB Atlas network-access rule for the server running this application.

## 3. Start

```bash
npm start
```

Open the dashboard at:

```text
http://localhost:10000
```

## 4. Render

Use:
- Build command: `npm install`
- Start command: `npm start`
- Node: 20+

Add the same environment variables to Render.

## 5. QR flow

The browser gets the current Baileys QR string from:

`GET /api/qr?sessionId=...`

The browser renders that string into a QR image. The server does not save QR images to disk.

The QR is temporary and is refreshed automatically by the dashboard.

## 6. Pairing flow

The dashboard sends:

`POST /api/pairing-code`

```json
{
  "sessionId": "web_...",
  "phone": "233XXXXXXXXX"
}
```

The backend calls Baileys' real pairing-code API and returns the generated code. There is no fake/demo pairing-code fallback.

## 7. MongoDB persistence

Credentials and Signal keys are stored in MongoDB collections:
- `whatsapp_sessions`
- `whatsapp_session_keys`

The session is therefore not dependent on Render's local filesystem.

## 8. Important

This project intentionally does not use `useMultiFileAuthState()` because local session files are not a good persistence layer for ephemeral hosting.

Do not commit `.env`.

Use the bot only in ways permitted by WhatsApp's terms and applicable law. The Baileys project itself warns against spam, stalking, and abusive automation.

## Existing dashboard

The visual dashboard is served from `public/` and includes:
Dashboard, Pairing Code, QR Code, Sessions, Settings, Features, Users, Bans, Logs and About.
