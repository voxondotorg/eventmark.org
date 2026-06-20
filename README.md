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
```

The main app includes participant flows (discover, register, tickets, dashboard) and organizer flows (apply, create events, invitations, check-in staff).

Platform operator admin tools live in the private deploy repo only — not in this open-source tree.

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

---

## Contributing

Pull requests and issues are welcome on GitHub:

**https://github.com/voxondotorg/eventmark.org**

Please do not commit API keys, passwords, or personal email addresses.

---

## Sponsorship & professional support

EventMark is maintained by [Voxon](https://voxon.org).

We welcome **corporate grants and support contracts** for development, security work, hosting guidance, and feature integration — especially if you run EventMark in production.

- **GitHub:** use the **Sponsor** button on this repo (when enabled on the organization profile).
- **Corporate support:** contact us via [voxon.org](https://voxon.org) to discuss a simple maintenance or development agreement.

Typical support scope: bug fixes, security patches, release notes, and agreed feature work — billed as software services (not donations).

---

## Links

- [Voxon](https://voxon.org)
