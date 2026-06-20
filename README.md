# EventMark

Open-source event discovery and registration platform.

This repository is **source code only**. There is no deploy config, no cloud account IDs, and no secrets. Clone it, read it, and run or host it however you like.

**License:** [MIT](LICENSE) — full licensing notes at `/license` when running the app.

**Third-party opensource:** Ticket QR generation and scanning use vendored libraries (Project Nayuki QR generator, jsQR). See `/third-party` for attributions.

---

## What’s included

```
src/                 Main app — HTML, CSS, JavaScript, TypeScript
  index.html         App shell
  app.js             Front-end UI
  app.css, voxui.css Styles
  worker.ts          Server / API layer (TypeScript)
  *.ts               Auth, database helpers, features
  assets/            Images, icons, static JS
  legal/             License text and third-party notices

admin-portal/        Platform admin UI (optional)
  src/worker.ts      Review org applications, users, settings
  src/admin.css      Admin styles
```

| Part | Who uses it |
|------|-------------|
| **`src/`** (main app) | Guests, participants, organizers, check-in staff |
| **`admin-portal/`** | Platform operators (approve orgs, manage users, site settings) |

Deploy config and secrets are not included — wire up your own host and protect the admin app (e.g. separate subdomain + access control).

---

## Tech stack (for orientation)

- **Front end:** HTML, CSS, vanilla JavaScript (`app.js`)
- **Back end:** TypeScript modules (`worker.ts` and friends)
- **Storage / email:** Implemented against a key–value store and mail APIs in code — wire up your own provider when you deploy

Nothing in this repo pins you to a specific host. Adapt the worker layer to Node, Workers, Docker, or any stack you prefer.

---

## Getting started (local)

1. Clone this repo.
2. Open `src/index.html` and the TypeScript files to explore structure.
3. To type-check TypeScript (optional):

   ```bash
   npm install
   npm run typecheck
   ```

   Requires Node.js 20+. This step is optional and only checks types — it does not deploy anything.

4. **Git hooks (recommended for maintainers):** keeps commit messages clean so only human authors appear on GitHub:

   ```bash
   bash scripts/install-git-hooks.sh
   ```

   Do not add bot or AI co-author lines to commits.

---

## Contributing

Pull requests and issues are welcome on GitHub:

**https://github.com/voxondotorg/eventmark.org**

Please do not commit API keys, passwords, or personal email addresses.

---

## Sponsorship & professional support

EventMark is maintained at [eventmark.org](https://eventmark.org).

We welcome **corporate grants and support contracts** for development, security work, hosting guidance, and feature integration — especially if you run EventMark in production.

- **GitHub Sponsors:** pending approval for `voxondotorg` — use [eventmark.org](https://eventmark.org) until the Sponsor button is live.
- **Bulk sponsorship (companies):** after Sponsors is approved, upload a CSV with **Maintainer Username** and **Amount in USD** (see [`.github/sponsorship-template.csv`](.github/sponsorship-template.csv)).
- **Corporate support:** contact us via [eventmark.org](https://eventmark.org) to discuss a simple maintenance or development agreement.

Typical support scope: bug fixes, security patches, release notes, and agreed feature work — billed as software services (not donations).

---

## Links

- [Voxon](https://voxon.org)
