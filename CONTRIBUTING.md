# Contributing

Thanks for looking. This is a small project, so keep changes small and focused.

## Setup

```sh
npm install
npm test
npm run dev
```

Node 20 or newer. Tests run offline and need no keys.

## Ground rules

- Run `npm test` before you open a pull request, and add a test with any behavior change.
- Never edit a migration that has already shipped. Add the next numbered file in `netlify/database/migrations/`.
- Don't add analytics, trackers, or third-party scripts.
- Don't commit keys, `.env` files, real résumés, or real people's data. Use made-up examples.
- Keep the core promise: generated text must stay tied to facts the user confirmed. If a change loosens a check in `src/truth.js`, `src/writing.js`, or `src/plain.js`, say so in the pull request.
- Plain language in the UI. Short sentences, no hype.
- `public/vendor` is third-party code. Rebuild bundles with `npm run build:documents` and `npm run build:imports` rather than editing them by hand.

## Pull requests

Describe what changed and why, and how you tested it. Small pull requests get reviewed faster. By contributing you agree your work is released under the MIT license.
