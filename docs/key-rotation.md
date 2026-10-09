# Rotating keys and tokens

When to rotate: someone left, a key may have leaked (pasted in a chat, committed,
on a lost laptop), or once a year. Each section is independent. Rotating one never
requires rotating another.

| Secret | Where it lives | What breaks while it is wrong |
|---|---|---|
| GitHub App private key | backend `GITHUB_APP_PRIVATE_KEY` | tasks get no GitHub token: no clone of private repos, no push |
| `GITHUB_TOKEN_NODE` | backend env | node installs and updates (code download) |
| `NODE_API_KEY` | backend env, typed once per install | new installs and re-registrations only |
| Node token | each node (Keychain / Credential Manager / file) | that node only |
| MCP token | your MCP client (Claude Code, phone) | that client only |

## GitHub App private key

1. GitHub → Settings → Developer settings → GitHub Apps → the App → **Private keys →
   Generate a private key**. A new `.pem` downloads. The old key keeps working for now.
2. Put the new key in Coolify as `GITHUB_APP_PRIVATE_KEY` (one line, newlines as `\n`):
   `awk 'BEGIN{ORS="\\n"}1' new.pem | sed 's/\\n$//' | pbcopy`. Redeploy.
3. Check: run a small `ask` task on a private repo. It must finish (the clone uses the App token).
4. Delete the **old** key on the App page, then delete the `.pem` files from your disk.

## GITHUB_TOKEN_NODE

1. GitHub → Settings → Developer settings → Fine-grained tokens → **Generate new token**:
   only the node code repos (`zicgab/Gab-ai-node`, and those of the other node projects),
   **Contents: Read-only**, nothing else. Set an expiry and a calendar reminder before it.
2. Update `GITHUB_TOKEN_NODE` in Coolify. Redeploy.
3. Check: `curl -sI http://<backend>:3083/node/agent | head -1` shows `200` (the installer is read from GitHub with this token).
4. Delete the old token on GitHub.

## NODE_API_KEY

Installed nodes do not use it. They use their own node token, so changing it
stops nothing that runs.

1. New value: `openssl rand -base64 48 | tr -d '\n' | pbcopy` (at least 32 characters).
2. Update `NODE_API_KEY` in Coolify. Redeploy. Give the new key only to whoever installs the next node.

## A node token (one machine)

- Machine lost or compromised: turn it off from the backend:
  `UPDATE ai_workers SET is_active = false WHERE project = 'agent' AND name = '<node>';`
  Its tasks go back to the queue when their lease expires.
- Machine fine, token to renew: on that machine run `gab-node register --server <url> --name <same name>`
  with `NODE_API_KEY`. The old token stops working at once.

## MCP token

1. `node scripts/agent-node-token.js mcp "claude code on macbook"` in gasysteme. It prints the token
   once and the SQL to store its hash. Run the SQL, then put the token in your MCP client.
2. Revoke the old one: `UPDATE agent_api_tokens SET revoked_at = NOW() WHERE id = '<id>';`
