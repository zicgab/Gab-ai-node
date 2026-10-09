# Gab-ai-node

The code installed on each machine that runs AI agents on my private GitHub
repos. The backend (task queue, MCP endpoint, GitHub tokens) is gasysteme's
`ai-worker/agent/`. Design: [ARCHITECTURE.md](ARCHITECTURE.md). GitHub App:
[docs/github-setup.md](docs/github-setup.md).

## Install a node

Needs Node.js 20+, npm and git (Docker for bug hunts and tests), and Tailscale
connected to the backend. As the user that will run the node, not as root:

| OS | Command |
|---|---|
| macOS, Linux | `curl -fsSL http://<backend Tailscale IP>:3083/node/agent \| bash` |
| Windows (PowerShell) | `irm http://<backend Tailscale IP>:3083/node/agent \| iex` |

It asks for the **node key** (backend `NODE_API_KEY`; used once, never saved),
downloads the code into `~/gab-ai-node` (`%USERPROFILE%\gab-ai-node`), builds
it, registers the machine, and installs the automatic start (launchd,
systemd user service, or a scheduled task). A new node starts **paused**: allow
it from MCP (`set_node_availability`).

Stopped halfway: `bash setup.sh` / `.\setup.ps1` in that folder (safe to re-run).

Going live for the first time: follow [docs/go-live.md](docs/go-live.md). Rotating keys and tokens: [docs/key-rotation.md](docs/key-rotation.md). Checking a node and its model: `gab-node eval`. What each kind of job does: [ARCHITECTURE.md](ARCHITECTURE.md).

## Day to day

| What | macOS, Linux | Windows |
|---|---|---|
| Update (rolls back if the build fails) | `bash update.sh` | `.\update.ps1` |
| Remove | `bash uninstall.sh [--purge] [--remove-code]` | `.\uninstall.ps1 [-Purge] [-RemoveCode]` |
| Status, pause, models | `gab-node status`, `gab-node pause`, `gab-node resume`, `gab-node models …` | same |
| Logs | `<data folder>/logs` | `%LOCALAPPDATA%\gab-ai-node\logs` |

Registering the same name again (a reinstalled machine) gives it a new token;
the old install stops working.

## Develop

```
npm ci
npm run build       # protocol, then node
npm run typecheck
npm test
```

The node's tests run against a fake backend (`apps/node/test/client.test.ts`);
the backend's own tests are in gasysteme (`ai-worker/__tests__/agent-*.test.js`).
