# yolo-code

> ## ⚠️ Experimental — deprecated (2026-05-14)
>
> `yolo-code` was an **experiment**: a terminal coding agent for YOLO Studio built on Kimi-K2.6 via Cloudflare Workers AI. It is **deprecated and unmaintained** — YOLO Studio now ships `opencode-yolo` as its builtin coding agent. The code is kept (and mirrored publicly at [yolo-labs-hq/yolo-code](https://github.com/yolo-labs-hq/yolo-code), archived) for reference only; do not build new features on it. Internal deprecation notes: `docs/YOLO_CODE_DEPRECATION_PLAN.md` in the monorepo.

**YOLO Code** — terminal coding agent for YOLO Studio, powered by Kimi-K2.6 on Cloudflare Workers AI.

This is a fork of [kimiflare](https://github.com/sinameraji/kimiflare) (MIT). Baseline: upstream commit `7dd4820` (v0.20.2).

## Install

Not published to npm. Install from source:

```sh
git clone https://github.com/yolo-labs-hq/yolo-code.git
cd yolo-code
npm install
npm run build
npm link         # symlinks `yolo-code` into your global npm bin
yolo-code --help
```

`npm link` creates a symlink from your global npm bin (usually `/usr/local/bin/yolo-code` or `~/.nvm/.../bin/yolo-code`) to `bin/yolo-code.mjs`. To remove it later: `npm unlink -g yolo-code`.

For one-off use without linking:

```sh
node bin/yolo-code.mjs --help
```

## Configure

`yolo-code` looks for credentials in this order:

1. **Router mode** (for YOLO Studio sandboxes):
   - `YOLO_ROUTER_BASE_URL` + `YOLO_ROUTER_API_KEY` → POSTs to `${base}/v1/chat/completions`.
   - Auto-detected; no onboarding prompt.
2. **Standalone mode** (direct Cloudflare Workers AI):
   - `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, or
   - `~/.config/yolo-code/config.json` (chmod 600), written by the first-run onboarding wizard.

## Environment variables

- `YOLO_ROUTER_BASE_URL` / `YOLO_ROUTER_API_KEY` — route through yolo-router-cf.
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — direct-to-CF fallback.
- `YOLO_CODE_*` — agent-level settings (see `src/config.ts`, `src/agent/token-limits.ts`).
- `KIMI_MODEL`, `KIMI_REASONING_EFFORT`, `KIMI_THEME` — kimi-specific overrides.

## Project context

The agent reads `YOLO.md` / `YOLO_CODE.md` / `AGENT.md` from the working directory. See `YOLO.md` in this dir for build/layout/conventions.

## Development

- `npm run dev` — run via tsx
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run tests
- `npm run build` — tsup → `dist/index.js`

## License

MIT (inherited from kimiflare). See `LICENSE`.
