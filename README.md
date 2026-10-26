# CLAW & CO — Press-On Nails Store

Full-stack store: storefront, cart, checkout, reviews, and an admin panel.
Backend: Node.js + Express + SQLite. Frontend: plain HTML/JS (no build step).

## Run it
1. Install Node.js 18+ (nodejs.org)
2. In this folder: `npm install`
3. Set your secrets, then start:
   - Mac/Linux: `ADMIN_PASSWORD=yourpass JWT_SECRET=somelongrandomtext npm start`
   - Windows (PowerShell): `$env:ADMIN_PASSWORD="yourpass"; $env:JWT_SECRET="somelongrandomtext"; npm start`
4. Shop: http://localhost:3000 — Admin: http://localhost:3000/#admin

Without ADMIN_PASSWORD the admin password is `claw123`. Change it before going live.

## Where things live
- `server.js` — the whole API (products, orders, reviews, admin, image uploads)
- `public/index.html` — storefront + admin UI
- `claw.db` — your data (created automatically). Back this file up.
- `uploads/` — product photos added in the admin panel

## Going live
- Deploy to Railway, Render, or a VPS (they run `npm start`). Keep `claw.db` and `uploads/` on a persistent disk.
- Put it behind HTTPS (these hosts do this for you).
- Not included yet: online payments (checkout is cash on delivery / bank transfer), order emails, and login attempt limits.
