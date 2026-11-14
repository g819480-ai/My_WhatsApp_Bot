# SCANTY MD BOT — Dashboard

This package recreates the supplied SCANTY MD BOT dashboard as a responsive, lightweight HTML/CSS/JS control panel.

## Included
- `index.html` — dashboard structure and all sections
- `styles.css` — futuristic blue/green/purple UI styling
- `app.js` — navigation, uptime, pairing-code UI, QR generation, settings and API integration
- `README.md` — setup notes

## Run
Open `index.html` directly for the front-end demo, or serve the folder with any static web server.

## Connect the real SCANTY backend
Open `app.js` and change:

```js
const API_BASE = "";
```

For example:

```js
const API_BASE = "https://scanty-md-bot.onrender.com";
```

The dashboard is prepared for these endpoints:

- `GET /api/status`
- `POST /api/pairing-code` body `{ "phone": "233XXXXXXXXX" }`
- `GET /api/qr`
- `GET /api/sessions`
- `POST /api/settings`

### Important for QR
Your Baileys backend should return the **current QR string** from `/api/qr`, not a screenshot/image of the QR. The browser converts the string into a QR image.

### Important for pairing
The pairing endpoint should create/maintain the actual Baileys pairing flow and return only after the code is generated successfully, e.g.:

```json
{
  "code": "ABCD-EFGH",
  "message": "Pairing code ready"
}
```

## Deployment
This is a static frontend, so it can be hosted on Cloudflare Pages, GitHub Pages, Netlify, Vercel, or from your own SCANTY Cloud server.

## Design
The layout follows the supplied reference: dark futuristic interface, neon green WhatsApp/active states, blue/cyan panels, purple settings accents, left navigation, top administrator profile, statistics cards, bot overview, and quick actions.
