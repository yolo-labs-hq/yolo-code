# yolo-code

**Project** — YOLO Code: terminal coding agent for YOLO Studio. Forked from [kimiflare](https://github.com/sinameraji/kimiflare) at v0.20.2. Powered by Kimi-K2.6 on Cloudflare Workers AI. TypeScript / Node.js ≥20, React + Ink TUI.

**Build / test / run**
- `npm run build` — bundle with tsup (`dist/` + `bin/yolo-code.mjs`)
- `npm run dev` — run via tsx (`tsx src/index.tsx`)
- `npm run typecheck` — `tsc --noEmit`
- `npm start` — run compiled bin
- `npm link` — symlink CLI for local development

**Layout**
- `src/index.tsx` — CLI entry (Commander args, print mode, TUI bootstrap)
- `src/app.tsx` — Ink TUI root (chat, status bar, permission modals, input)
- `src/agent/` — LLM client (`client.ts`), agent loop (`loop.ts`), system prompt builder, message compaction
- `src/tools/` — Tool specs & executors: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `web_fetch`, `tasks`, `skill`
- `src/mcp/` — MCP server lifecycle (`manager.ts`) and tool adapter (`adapter.ts`)
- `src/skills/` — `agentskills`-spec SKILL.md loader, trust gate, discovery, registry installer
- `src/cli/` — Subcommand handlers (`yolo-code config`, `yolo-code mcp`, `yolo-code skills`)
- `src/ui/` — Ink components: chat, diff view, permission modal, task list, status bar, theme, text input
- `src/util/` — Helpers: SSE parser, paths, errors, update check
- `bin/` — Compiled CLI shim (`yolo.mjs`)
- `dist/` — tsup ESM output
- `docs/` — Documentation

**Conventions**
- ESM only (`"type": "module"`).
- Import paths **must** use `.js` extensions even for `.ts`/`.tsx` files (TypeScript `moduleResolution: Bundler`).
- Use `node:` prefix for all Node built-ins.
- TSX extension used throughout (even non-JSX files).
- Strict TS: `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`.
- React 19 + Ink 7 for terminal UI.
- tsup externalizes runtime deps (`ink`, `react`, `commander`, etc.); bundles source only.
- Env var prefix: `YOLO_CODE_*`. Kimi-model-specific: `KIMI_*`.
- Context files scanned in order: `YOLO.md`, `YOLO_CODE.md`, `AGENT.md`.
- Config stored at `~/.config/yolo-code/config.json`.

**Do / Don't**
- Do keep agent responses terse; don't re-summarize tool output the user already sees inline.
- Do call `tasks_set` at the start of multi-step work and update it as steps complete; skip for trivial one-offs.
- Do read files and explore with `glob`/`grep` before editing; don't guess structure.
- Do state what you're about to do before any mutating tool call (`write`, `edit`, `bash`).
- Do stop when a task is finished; don't add closing summaries.
- Don't paste code in chat that could be applied via `edit` or `write`.
- Don't retry the same failed tool call blindly; read errors and adjust.

**Relationship to upstream**
- Upstream: https://github.com/sinameraji/kimiflare (MIT)
- Fork baseline: commit `7dd4820` (v0.20.2)
- Divergence plan: see `/YOLO_CODE_KIMIFLARE_PLAN.md` in the main YOLO Studio monorepo.

**Skills (SKILL.md playbooks)**

yolo-code implements the [agentskills](https://github.com/agentskills/agentskills) spec for shipping playbook-style guidance alongside a project or installed by the user. Skills are discovered from three scopes:

- `<cwd>/.yolo/skills/`, `<cwd>/.agents/skills/`, `<cwd>/.claude/skills/` (project — gated by trust)
- `~/.yolo/skills/`, `~/.agents/skills/` (user)
- `~/.config/yolo-code/skills/` (registry installs)

Project-scoped skills only load when the cwd is in `~/.config/yolo-code/trusted-projects.json` — run `yolo-code skills trust` to add it. Each loaded skill's name + description goes into the session prefix as a catalog; the model loads bodies on demand via the `skill({name})` tool.

**Discovery (Phase 5d)**

When the loaded catalog has more than 5 entries, yolo-code runs a two-stage filter so the prefix stays small:

1. **Heuristic** — extracts project signals (config files, extensions, primary language) and recent user-message tokens, scores them against each skill's tags + description.
2. **LLM relevance** — single call through yolo-router-cf with `X-Yolo-Activity: skill-discovery` and the small `@cf/meta/llama-3.1-8b-instruct` model. Result is cached in `~/.config/yolo-code/skills-cache.json` keyed by catalog hash + signature hash.

The LLM step is skipped when the heuristic already trims to ≤ floor candidates (default 5, tunable), when no router credentials are available (direct-Cloudflare mode), or when the user disables discovery entirely.

**CLI**

```bash
yolo-code skills list                       # show every loaded skill + scope + pin status
yolo-code skills info <name>                # print full SKILL.md body
yolo-code skills search [query]             # browse the registry catalog (alias: browse, available)
yolo-code skills search [query] --refresh   # bypass the 10-min registry cache
yolo-code skills install <name>             # fetch from yolo-labs-hq/yolo-skills-registry
yolo-code skills install <tarball-url>      # fetch from arbitrary URL
yolo-code skills uninstall <name>           # remove a registry-installed skill
yolo-code skills validate [path]            # parse a SKILL.md or every loaded one
yolo-code skills enable <name>              # pin on (force-include even if discovery would drop)
yolo-code skills disable <name>             # pin off (exclude from active set)
yolo-code skills clear-pin <name>           # remove either pin
yolo-code skills trust [path]               # trust a directory for project-scoped skills
yolo-code skills untrust [path]             # revoke trust
yolo-code skills trust-list                 # list trusted directories
yolo-code skills discovery-clear            # invalidate the discovery cache
```

**Slash commands**

```
/skills                                  # list (or info|enable|disable|clear|trust|reload <name>)
/skills browse [query]                   # browse the registry catalog from inside the agent (alias: search)
/skills install <name> | <url>           # install from registry name or tarball URL
/skills uninstall <name>                 # remove a registry-installed skill
/skills discovery [on|off|refresh|status]
```

**Env overrides**

| Var | Purpose | Default |
|-----|---------|---------|
| `YOLO_CODE_SKILL_DISCOVERY` | `0`/`false` to skip discovery entirely | enabled |
| `YOLO_SKILL_DISCOVERY_MODEL` | discovery LLM model id | `@cf/meta/llama-3.1-8b-instruct` |
| `YOLO_SKILL_DISCOVERY_LLM_FLOOR` | ≤ this many heuristic candidates → skip LLM | `5` |
| `YOLO_SKILLS_REGISTRY_URL` | override registry index URL | `https://raw.githubusercontent.com/yolo-labs-hq/yolo-skills-registry/main/registry.json` |
| `YOLO_SKILLS_REGISTRY_TARBALL_URL` | override registry tarball URL | `https://github.com/yolo-labs-hq/yolo-skills-registry/archive/refs/heads/main.tar.gz` |
| `YOLO_TRUST_PROJECT_SKILLS` | `1` force-trusts every cwd (sandboxes) | unset |

**Registry**

Curated registry: https://github.com/yolo-labs-hq/yolo-skills-registry. Add a skill by opening a PR with a new `skills/<name>/SKILL.md` plus a corresponding entry in `registry.json`. See the registry README for the schema.

**Plan / status**

Top-level plan and phase history live at `docs/YOLO_CODE_SKILLS_PLAN.md` in the main YOLO Studio monorepo.
