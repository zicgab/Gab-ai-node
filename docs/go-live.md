# Go-live checklist

Nothing below is done for you: each step is yours to run. Order matters.

## 1. Backend (gasysteme)
1. Run the migrations **on staging first**, then production, in this order (each is one transaction, safe to re-run):
   `sql/migrations/029_agent_node.sql`, `030_agent_chat.sql`, `031_agent_roles_paths.sql`, `032_agent_schedules.sql` (schedules; the backend logs an error every 30 s without it).
2. Environment (Coolify): `NODE_API_KEY` (install key, 32+ chars), `GITHUB_TOKEN_NODE` (read access to
   `zicgab/Gab-ai-node`), `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (see `docs/github-setup.md`).
3. Deploy manually on Coolify. The agent API is only reachable over Tailscale.
4. MCP token: `node scripts/agent-node-token.js mcp "<label>"`, run the INSERT it prints, put the token in your MCP client.
5. Per repo: the `INSERT INTO agent_repos` examples in `docs/github-setup.md` (kinds per repo type), then
   `node scripts/agent-node-ruleset.js <owner/name>` (agents may only push `agent/**`).

## 2. The Gab-ai-node repo
Push it to GitHub as `zicgab/Gab-ai-node` (the backend serves the installer and updates from it).

## 3. A node
1. Install: the one-liner from the README (it asks for the node key, the backend URL if not filled in, and a name).
2. Docker must be running (needed for every kind except `ask`, `chat`, `contract_check`, `test_mobile`). Setup installs it when missing (after asking; the admin password once) and starts it without a window; the node restarts it by itself afterwards.
3. Models: `gab-node models setup` (the installer already offers it), or `gab-node models list` and
   `gab-node models pull --all`. The model for each job type is fixed (see ARCHITECTURE.md, "Model per task");
   `gab-node models test` checks that an installed model calls tools.
4. Allow it: the installer already did (the node registers as allowed). Change it later with `set_node_availability` from MCP; `--paused` / `--window` at install start it paused or nightly-only.
5. Per repo, write what the node needs in the repo's `AGENT.md` (lines like `setup: npm ci`):
   `test:` (all), `start:` + `url:` (test_web), `electron:` (test_electron).
6. Mobile (optional): `mobile` section of the node's `config.json` and Maestro on PATH, see `ARCHITECTURE.md` (test_mobile).

## 4. First real runs (none of these has run on real Docker/Chromium/Electron/a simulator yet)
Run one of each on a small repo and read the node log (`gab-node status`, `<data>/logs`) before trusting it:

| Kind | First run | Watch for |
|---|---|---|
| `ask` | `ask` a question about a repo | model loads, answer cites file:line |
| `chat` | `chat_start` on the node, `chat_send` twice | the second answer uses the first |
| `bug_hunt` | `submit_task kind=bug_hunt role=backend paths=[...] runs=3` | findings with evidence, `seen_count` rises across runs |
| `scan` | `submit_task kind=scan` | all three scanners ran (summary lists each), images pulled |
| `test_web` | after adding `start:`/`url:` to AGENT.md | the app starts in the container, Playwright installs, `problems` output |
| `test_electron` | after adding `electron:` | Xvfb + Electron start (first suspect: missing system libs in the image) |
| `contract_check` | on the backend repo with `extraRepos` = the apps | mismatches cite both sides |
| `test_mobile` | simulator booted, `mobile` config set | build, install, a launch-only flow, then `screen` |
| `custom` | a small change on a scratch repo | branch `agent/<node>/...` pushed, `main` untouched |

## 5. Triage loop (daily)
`list_findings` (look at `seen_count` and `evidence`) → fetch the `agent/**` branch with git to review a fix →
`set_finding_status` (open / fixed / dismissed + note). Dismissed findings stop showing up.

## Not built yet
Scheduled recurring jobs (e.g. a nightly security scan): queue them by hand or with `runs` for now.
Vision (screenshots) for the UI/UX role, `translate`, `eval`, streaming chat answers.
