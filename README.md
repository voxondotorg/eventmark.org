# EventMark

Open-source event discovery and registration platform.

This repository is **source code only**. There is no deploy config, no cloud account IDs, and no secrets. Clone it, read it, and run or host it however you like.

**License:** [MIT](LICENSE)

---

## What’s included

```
src/                 Main app — HTML, CSS, JavaScript, TypeScript
  index.html         App shell
  app.js             Front-end UI
  styles.css         Styles
  worker.ts          Server / API layer (TypeScript)
  *.ts               Auth, database helpers, features
  assets/            Images, icons, static JS
  legal/             License text

admin-portal/        Optional admin UI (TypeScript)
  src/worker.ts      Admin server + UI
```

| Part | Required? |
|------|-----------|
| **`src/`** (main app) | **Yes** — the product people use |
| **`admin-portal/`** | **Optional** — extra dashboard for operators; skip it if you only need the public site |

The main app already includes organizer flows. The admin portal is a separate module you can use or ignore.

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

Pull requests and issues are welcome. Please do not commit API keys, passwords, or personal email addresses.

---

## Links

- [Voxon](https://voxon.org)
