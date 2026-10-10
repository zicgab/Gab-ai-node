# Gab-ai-node — Architecture

Local AI agents that work on my private GitHub repos, on my own machines.
Driven from any MCP client (Claude Code, other devices) through the gasysteme
backend. Agents only ever commit to their own branches.

**This repo is the node**: the code installed on each machine that runs agents
(like `gab-ai-retouching` for the Photoshop nodes). The backend (queue, MCP
endpoint, GitHub tokens) lives in gasysteme, `ai-worker/agent/`.

## Decisions

| Topic | Decision |
|---|---|
| First node | MacBook Pro M3, 128 GB unified memory (no Linux GPU yet) |
| Node OS | macOS, Linux, Windows (installers below; iOS simulator tasks need macOS) |
| Backend | gasysteme (`ai-worker/agent/`), Coolify; the worker API and MCP answer **Tailscale connections only** (port 3083), no public route |
| Control | MCP over HTTPS-less Tailscale (`POST /agent/mcp`), Bearer token from `scripts/agent-node-token.js` |
| Node install | `curl …/node/agent \| bash` (macOS, Linux) or `irm …/node/agent \| iex` (Windows), same mechanism as the retouch and video nodes |
| Repos | Private, my GitHub account |
| Write access | Agents push only `agent/**` branches, enforced by GitHub, not by trust |
| Storage | None needed (results are text, diffs, branches); R2 later if needed |
| First milestone | `ask` (quick code lookup), then overnight bug hunt |

## Components

```
 MCP clients (Claude Code, phone, other Mac)  — on Tailscale
        │  MCP (Streamable HTTP), Bearer mcp token
        ▼
 gasysteme backend  (/agent/mcp, /worker/agent/*, /node/agent/*)  ─► Postgres (agent_* tables)
        ▲
        │  HTTP over Tailscale, node pulls (no inbound ports on nodes), Bearer node token
 node agent (this repo; launchd / systemd / Task Scheduler)
   ├─ model server on host (llama.cpp, Metal/CUDA, OpenAI-compatible, localhost only)
   ├─ per-task workspace: git worktree on branch agent/<node>/<task-id>
   ├─ agent loop: model ⇄ tools (read, grep, list, run cmd, test, browser, git commit)
   └─ backends (per task): local | anthropic-api | claude-code (headless `claude -p`)
```

### 1. Backend (gasysteme `ai-worker/agent/`, migration `029_agent_node.sql`)
- Nodes are `ai_workers` rows of project `agent`. Registration and code downloads reuse `ai-worker/nodes.js`:
  `POST /node/agent/register` (install key `NODE_API_KEY`, returns the node's own token once),
  `GET /node/agent/version` and `/code` (node token or install key), installers `install.sh` / `install.ps1`.
- Node protocol on `/worker/agent`, same lease model as the retouch workers:
  `POST /claim` (long-poll) → `POST /heartbeat` → `POST /tasks/:id/events` → `POST /tasks/:id/complete|fail`,
  plus `POST /tasks/:id/github-token`. Claim uses `FOR UPDATE SKIP LOCKED`; expired leases return tasks to the queue (max 3 attempts).
- Mints a **short-lived GitHub App installation token per task**, scoped to that repo. Nodes hold no long-lived GitHub credentials.
- Tailscale only: requests with proxy headers or from a public address get 403 (`rules.directPeerRefusal`).
  Behind Docker the peer address is often the gateway's, so the brute-force limits (30 rejected tokens/min,
  10 registrations/min) apply to all agent nodes together.

### 2. MCP tools (what I / Claude call)
| Tool | Purpose |
|---|---|
| `list_nodes` / `set_node_availability` / `pause_all` | nodes, allow/stop them (window, time zone), kill switch |
| `list_repos` | repos on the allowlist (`agent_repos`) |
| `ask(repo, question, ref?)` | synchronous code lookup; waits up to ~60 s, returns an answer with file:line refs |
| `submit_task(repo, kind, instructions, role?, paths?, runs?, node?, ...)` | background task(s); returns the task ids. `role` = frontend / backend / security / uxui (checklist in `apps/node/src/agent/roles.ts`); `paths` = folders the file tools are limited to; `runs` = 1-20 copies (findings seen in many runs have a high `seen_count`) |
| `set_finding_status(finding, status, note?)` | your review: open (confirmed), fixed, dismissed (false positive, hidden from `list_findings`) |
| `fix_finding` / `list_findings` | fix a bug-hunt finding on its own branch / list deduplicated findings |
| `chat_start` / `chat_send` / `chat_history` / `chat_end` | chat with the model of ONE node you pick (no repo, no tools). The chat stays on that node; the backend keeps the history and sends it with every message (migration 030). With a streaming model, `chat_send` / `chat_history` show `partial` (the answer so far) while the node writes |
| `create_schedule` / `list_schedules` / `set_schedule_enabled` / `delete_schedule` | recurring tasks: hourly, daily or weekly at a local time in an IANA time zone (stays put across daylight saving); missed runs are not caught up; runs once even with several backends (migration 032) |
| `node_health` | per node: online, running, completed/failed in 24 h, last failure; queue per kind. The backend also logs a node that is available but stops heartbeating |
| `task_status` / `task_log` / `get_result` / `cancel_task` / `keep_branch` | follow and manage tasks |

Task kinds a node runs today:

| Kind | What it does | Changes the repo? | Needs on the repo (`agent_repos`) |
|---|---|---|---|
| `ask` | read the code, answer with file:line | no | `ask` |
| `chat` | chat with one node's model (no repo) | no | (not a repo task) |
| `bug_hunt` | look for bugs (role, folders, repeat runs), fix what it proves | yes, `agent/**` branch | `can_run`, `can_push` |
| `fix_finding` | fix one finding, run the tests | yes, `agent/**` branch | `can_run`, `can_push` |
| `custom` | any change you describe, run the tests | yes, `agent/**` branch | `can_run`, `can_push` |
| `scan` | npm audit + Semgrep + gitleaks, model confirms each hit | no | `can_run` |
| `contract_check` | backend vs the apps that call it (`extraRepos`) | no | `contract_check` |
| `test_web` | drive the app in Chromium | no | `can_run` |
| `test_electron` | drive the Electron app (Playwright, Xvfb) | no | `can_run` |
| `test_mobile` | drive the app on a simulator with Maestro (host, opt-in) | no | `can_run` |
| `docs_check` | product code vs its marketing / how-to pages, 5 angles over `runs` | no | `docs_check` |
| `translate` | fill in / fix i18n message files for the languages named; JSON must parse and keep placeholders | yes, `agent/**` branch | `can_push` (runs no commands) |

`eval` is not a queue task: `gab-node eval` on the node reviews the bundled canary repo
(`apps/node/canary`, problems planted on purpose) and scores the model (found / missed / false alarms).
Every report-producing kind ends in findings (with evidence, `seen_count` across runs): review them with
`list_findings` and `set_finding_status`.

### scan
Scanners find candidates, the model judges them (a layered pipeline: reliable-but-noisy tools first, the
model only confirms or rejects). `npm audit` (only with a `package-lock.json`), Semgrep (`p/default`) and
gitleaks each run in their own throwaway container with network (rule and advisory databases); images are
`config.sandbox.scannerImages` (official, **pin them to a digest for production**). The model then reads the
code of each candidate (read-only tools, no commands) and confirms with a code path or rejects. File and line
come from the scanner. Secrets: the parser never copies the value, the scanners' raw files are deleted before the
model starts, and a confirmed secret's finding never contains the value. A failing scanner is reported in the
summary, the others still count. Roles and `paths` apply (candidates outside the folders are not shown).

### contract_check
Main repo = the backend, `extraRepos` = the apps that call it (mobile, web, desktop; read-only, paths
`@owner/name/...`). The model lists the calls each client makes and compares them with the backend's routes,
bodies, responses, status codes and auth, and reports disagreements with both sides in the evidence. It
runs no commands.

### test_electron
Same machinery as `test_web` (container without network, fixed browser actions, findings). AGENT.md needs
`electron: <main entry>` (e.g. `dist/main.js`), built by `setup:`. The driver launches the app with Playwright's
`_electron.launch` under `xvfb-run`; tools are `windows`, `window`, `elements`, `text`, `click`, `fill`,
`press`, `wait`, `problems` (no `goto`; the main process is not exposed). Linux container only: native
menus, tray, OS dialogs and Windows/macOS-only behaviour cannot be observed.

### test_mobile (React Native, native)
Maestro on the iOS simulator or Android emulator. Simulators cannot run in Docker, so this runs **on the
node's own machine** and is **off by default**. To enable it, edit the node's `config.json`:

```json
"mobile": {
  "enabled": true,
  "platform": "ios",
  "apps": { "zicgab/my-app": { "build": "npx expo run:ios --no-bundler", "app": "ios/build/MyApp.app", "appId": "com.example.myapp" } }
}
```

Boot a simulator/emulator first. What runs on the host is limited: the build command and app path come from
this config (never from the repo: a model-written branch could change AGENT.md), `xcrun simctl install booted` /
`adb install -r`, and `maestro`. The model never writes YAML: it gives a list of steps (`launchApp`, `tapOn`,
`inputText`, `assertVisible`, `assertNotVisible`, `scroll`, `swipe`, `back`, `pressKey`, `waitForAnimationToEnd`,
`takeScreenshot`, strict schema) and the node writes the flow; there is no script, link or sub-flow command.
The build still runs the repo's own code on your machine: enable it only for repos you trust and do not run it on
a ref you did not review. Maestro itself must be installed (`maestro` on PATH). React Native logic tests
(Jest) need no simulator: run them with `bug_hunt` / `custom` and `test:` in AGENT.md.

### test_web
The agent opens the repo's own app in Chromium and tries it like a user, then reports problems with
evidence (they become findings, with `seen_count`). It never changes the repo and never pushes.
- The repo's `AGENT.md` must say how to run the app: `start: <command>` and `url: http://localhost:<port>`
  (plus the usual `setup:`). Optional `image:` overrides the browser image.
- Everything happens in the task's Docker container, which has **no network except loopback**: the app
  must run without outside services (static, or a dev server with mocks). The browser refuses any
  address that is not `http://localhost`. Network is used only for `setup:` and `npm install playwright`.
- The model drives the page only through fixed actions (`goto`, `elements`, `text`, `click`, `fill`,
  `press`, `wait`, `problems`) implemented by `apps/node/assets/web-driver.mjs`; it never writes browser code.
- Image `config.sandbox.webImage` (default `mcr.microsoft.com/playwright:v1.48.2-jammy`, pinned by digest in `IMAGES`, apps/node/src/config.ts) must match
  `PLAYWRIGHT_VERSION` in `agent/web-runner.ts`.
- It runs on the vision model (`qwen3-vl-30b`) when the node has it, which also gets `screenshot`: the image goes
  to the model, only the newest one stays in the conversation. Useful for `uxui`. Without it, the fast model
  drives the page from the page text only.

### Model per task
The node knows exactly three models (`apps/node/src/models/catalog.ts`) and nothing else; no per-node choice, no
external model servers (Ollama, LM Studio, vLLM are not used). Which one serves what is fixed in the catalog
(`useFor`) and resolved by `models/pick.ts`:

| Model | Serves | Download | Memory |
|---|---|---|---|
| `qwen3-coder-30b` | `ask`, `chat`, `translate`, `custom`, `contract_check`, `test_mobile`, roles frontend / backend | 17 GB | 24 GB |
| `gpt-oss-120b` | `bug_hunt`, `fix_finding`, `scan`, `docs_check`, roles security / uxui | 59 GB | 70 GB |
| `qwen3-vl-30b` | `test_web`, `test_electron` (reads screenshots; model + `mmproj` file) | 18 GB | 26 GB |

Order: the model the task names (only one of these three), then the vision model for screenshot tasks, then the
model for the task's role, then for its kind, then the first installed model. A node installs only the models that
fit its memory budget (`memoryBudgetMb`, default 75% of RAM): on a 64 GB machine `gpt-oss-120b` does not fit, so
deep tasks run on `qwen3-coder-30b` (lower quality, accepted). A node with no model installed claims no local task.

### Agent loop guards (`apps/node/src/agent/loop.ts`)
A local model fails in two ways, so the loop guards against both:
- **Repeating itself.** The same read (`read_file`, `list_dir`, `grep`, `search_code`) with the same arguments is not run again: the model is told it already has the result. Three steps in a row of only repeats add a nudge, six force the final report (`stoppedBy: repeating`). A write or a command lets earlier reads be repeated again. (The first real scan ran one `grep` 43 times and used its whole token budget without a report.)
- **Concluding after a quick look.** A bug hunt that answers after opening fewer than 12 files with `read_file` is sent back (twice at most). Its summary says how many files it read (`0 finding(s), 31 file(s) read`) and the report lists the files it reviewed: "0 findings" only means something next to that.

A bug hunt accepts code-reading evidence (the quoted line at file:line and the path to the bad result), not only a failing test, and changes files only when the task asks for fixes.

`scan` reviews its candidates 10 at a time, most severe first, each batch in a fresh conversation with a share of the task budget (each step re-sends the whole conversation, so one long conversation cannot fit 200 candidates). The summary lists the candidates the budget did not reach.

### 3. Node agent (`apps/node`, `packages/protocol`)
- Node.js + TypeScript (npm workspaces), runs as a launchd service (macOS), systemd user service (Linux)
  or a scheduled task at logon (Windows), installed by `install.sh` / `install.ps1`.
- Install: `install.sh` downloads the code, `setup.sh` builds it, registers the machine (`gab-node register`),
  installs the service and the `gab-node` command. `update.sh` / `update.ps1` swap in new code (rollback on a failed build),
  `uninstall.sh` / `uninstall.ps1` hand the tasks back (`gab-node retire`) and remove the service.
- Reports capabilities on heartbeat: OS, chip, memory, models available, tools present, free disk.
- Secrets in the OS store: macOS Keychain, Windows DPAPI, Linux a 0600 file; never in `config.json`.
- Repos: bare mirror cache per repo (`<data folder>/repos/<repo>.git`), fetched per task;
  each task gets its own worktree on `agent/<node>/<task-id>`, deleted after push.
- Agent loop: tool-calling over an OpenAI-compatible API; step and token budgets per task;
  every tool call logged as a task event.
- Health before every claim (`health.ts`): only the kinds that can run now are claimed (Docker down: no
  command kinds, and the node starts Docker itself, in the background and at most every 5 minutes: macOS `open -g -j -a Docker`,
  Windows Docker Desktop, Linux `systemctl --user start docker` only; off with `gab-node settings docker-autostart off`; llama-server missing or disk under `minFreeDiskMb`: nothing). macOS: `caffeinate` while a task runs. Hourly: log rotation, mirrors unused for
  `mirrorMaxAgeDays` deleted. Files made by `setup:` are hidden from git in the task's worktree (never committed).
- Model server: the node starts the pinned llama.cpp `llama-server` itself, one process per model, on demand,
  bound to `127.0.0.1`, and stops it after `idleMinutes` idle; idle models are unloaded to make room. The binary is
  installed by `setup` / `update` from `llama-server.pin` (release tag + SHA-256 per platform, no sudo) into
  `<data folder>/llama.cpp/bin`; Linux and Windows use the Vulkan build when a Vulkan driver is present, else CPU.
  Bump the pin by editing that file. Models: `gab-node models setup` (the installer asks before downloading),
  `list`, `pull <id|--all>`, `verify`, `remove`, `test [id]`, `manage`. Files are pinned by Hugging Face commit and
  SHA-256, resumable, checked before use.
- Sandboxing: Docker on macOS cannot use the Metal GPU, so the **model runs on the host**
  and **command execution** (tests, scripts) runs in a Docker container with the
  worktree mounted and no secrets. Read/grep run directly on the worktree (read-only ops).

### 4. Models on the M3 / 128 GB
- All three models fit the disk (about 94 GB) but not the memory budget at once (96 GB): the node loads the one a
  task needs and unloads idle ones first. Served by llama-server, OpenAI-compatible, `127.0.0.1` only.
- The backend hands out a task, the node picks the model (see "Model per task").
- `anthropic-api` / `claude-code` backends are not implemented yet (the node answers "not available on this node yet").

## Branch safety (enforced, not trusted)
1. GitHub App "gab-ai-node" installed only on allowlisted repos (contents: write, metadata: read).
2. **Nodes never hold a write token.** At claim a node gets a read-only token (clone/fetch). To push, it
   commits locally and uploads the changed files (`POST /worker/agent/tasks/:id/push`); the backend
   creates the commit on GitHub (blobs, tree, commit) on top of the task's starting commit.
3. **The backend never writes to `main`.** One function moves a branch (`writeAgentRef`, gasysteme
   `ai-worker/agent/github.js`): it only accepts `agent/<node>/<rest>`, takes the branch from the task
   row held by the lease (never from the node), creates it or fast-forwards it (`force: false`). Tests
   check every GitHub request of the push flow. The write token is minted per push and stays in the backend.
4. A push is refused when it touches `.github/workflows/**` or `.github/actions/**` (a workflow would run
   on push with the repo's secrets), `.git/`, a path with `..`, a symlink or submodule, or is too big
   (500 files, 2 MB per file, 10 MB per push).
5. Limit: on GitHub Free, private repos cannot have rulesets, so GitHub itself does not enforce
   "agent/** only"; the backend code does. With GitHub Pro, `node scripts/agent-node-ruleset.js <owner/repo>`
   adds a ruleset that blocks every branch except `agent/**`, on top of the above.
6. One branch per task: `agent/<node>/<task-id>-<slug>`; the node checks the prefix too (defence in depth).

## Security
- Node tokens: random 32 bytes, SHA-256 hash in `ai_workers`, one per node, a worker's token only works for its own project.
  MCP tokens: `agent_api_tokens`, revocable. Install key `NODE_API_KEY`: used once on a new machine, never saved there.
- Repo allowlist in `agent_repos`; per repo: allowed task kinds, may-run-commands, may-push.
- No production secrets on nodes; per-repo test env files only.
- Audit log (`agent_audit`): who submitted what, from which address; node events per task.

## Repo layout
```
apps/node/          node agent: claim loop, workspace, agent loop, tools, backends, CLI (gab-node)
packages/protocol/  shared types + zod schemas for the node API and task results
install.sh, install.ps1            served by the backend; download the code and run setup
setup.sh, setup.ps1, node-lib.*    build, register, service, gab-node command
run-node.sh, run-node.ps1          what the service runs (log files, restart after a crash)
update.sh, update.ps1, uninstall.* update (with rollback) and removal
```
The backend half (queue, MCP, GitHub tokens, migration) is in gasysteme: `ai-worker/agent/`,
`sql/migrations/029_agent_node.sql`, `scripts/agent-node-*.js`.

## Build order
1. ✅ Protocol + backend queue: claim/heartbeat/complete, migration, tests.
2. ✅ Node agent: register, claim loop, heartbeat, repo cache + worktree.
3. Local model server + agent loop with read-only tools → **`ask` end to end** (needs a deployed backend).
4. MCP endpoint (`ask`, `list_*`, `task_*`) → call it from Claude Code.
5. GitHub App + rulesets + per-task tokens → commits and push to `agent/**`.
6. `bug_hunt` with command sandbox (Docker) → overnight run.
7. `test_web` (Playwright), `translate`, then `test_mobile`; Claude backends.

### Scope is focus, not a sandbox (on purpose)
`paths` limits `read_file`, `list_dir`, `grep`, `search_code`, `write_file` and `replace_in_file`. `run_cmd` runs in the Docker container with the whole repo mounted, so a command can still **read** other folders of the same repo (never the host, never the network). That is deliberate: builds and tests need the whole repo. What is enforced: a task never **commits** a change outside its folders (`changedOutsideScope`; the task fails instead). Do not use `paths` to hide secrets from a model: keep secrets out of the repo. Migrations 030 (chat) and 031 (roles, paths, finding notes) go with this.
