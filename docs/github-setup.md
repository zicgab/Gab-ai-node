# GitHub setup (once)

Agents get a short-lived token per task from a GitHub App you own. A ruleset on
each repo makes GitHub itself refuse their pushes anywhere except `agent/**`;
you (repo admin) can still push anywhere.

> **Plan requirement:** GitHub enforces rulesets on **private** repos only with
> a paid plan (Pro or above). On GitHub Free the backend and node still
> refuse non-agent pushes, but GitHub would not block one. Check
> *Settings → Billing and plans* before allowing `--push` on a repo.

## 1. Create the App

GitHub → *Settings → Developer settings → GitHub Apps → New GitHub App*

| Field | Value |
|---|---|
| Name | `gab-ai-node-<yourname>` (must be unique on GitHub) |
| Homepage URL | anything, e.g. your GitHub profile |
| Webhook | **uncheck Active** (not used) |
| Repository permissions → **Contents** | Read and write |
| Repository permissions → **Administration** | Read and write (only used by the gasysteme backend to create and check the ruleset; task tokens never get it) |
| Repository permissions → Metadata | Read-only (set automatically) |
| Everything else | No access |
| Where can this App be installed? | **Only on this account** |

Create it, then:
- note the **App ID** (top of the App page);
- *Private keys → Generate a private key*: a `.pem` file downloads. Treat it like a password.

## 2. Install it on the repos agents may use

App page → *Install App* → your account → **Only select repositories** → pick them.
Add a repo here later whenever you add it to the allowlist.

## 3. Give the backend the App

On the gasysteme backend (Coolify → the service → Environment):

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=<the PEM content, newlines as \n>
```

Store the PEM as a Coolify secret, never in a repo. Redeploy (manual).

## 4. Per repo: allowlist + ruleset

In the GabartStudio DB (you run it; `agent_repos` comes from migration 029):

```sql
-- Backend: tests run in the sandbox, fixes go to agent branches, scanners, API check against the apps.
INSERT INTO agent_repos (full_name, allowed_kinds, can_run, can_push)
VALUES ('zicgab/gasysteme', ARRAY['ask','bug_hunt','fix_finding','custom','scan','contract_check'], true, true)
ON CONFLICT (full_name) DO UPDATE SET allowed_kinds = EXCLUDED.allowed_kinds, can_run = EXCLUDED.can_run, can_push = EXCLUDED.can_push;

-- Web app (AGENT.md: setup, start, url).
INSERT INTO agent_repos (full_name, allowed_kinds, can_run, can_push)
VALUES ('zicgab/web-app', ARRAY['ask','bug_hunt','fix_finding','custom','scan','test_web'], true, true)
ON CONFLICT (full_name) DO UPDATE SET allowed_kinds = EXCLUDED.allowed_kinds, can_run = EXCLUDED.can_run, can_push = EXCLUDED.can_push;

-- Electron desktop app (AGENT.md: setup that builds it, electron: dist/main.js).
INSERT INTO agent_repos (full_name, allowed_kinds, can_run, can_push)
VALUES ('zicgab/desktop-app', ARRAY['ask','bug_hunt','fix_finding','custom','scan','test_electron'], true, true)
ON CONFLICT (full_name) DO UPDATE SET allowed_kinds = EXCLUDED.allowed_kinds, can_run = EXCLUDED.can_run, can_push = EXCLUDED.can_push;

-- React Native app (Jest in the sandbox; test_mobile also needs the node's mobile config).
INSERT INTO agent_repos (full_name, allowed_kinds, can_run, can_push)
VALUES ('zicgab/mobile-app', ARRAY['ask','bug_hunt','fix_finding','custom','scan','test_mobile'], true, true)
ON CONFLICT (full_name) DO UPDATE SET allowed_kinds = EXCLUDED.allowed_kinds, can_run = EXCLUDED.can_run, can_push = EXCLUDED.can_push;
```

The repo names above are examples: use your real ones. `contract_check` is queued on the **backend** repo with the
apps in `extraRepos` (each of them must be in `agent_repos` too).

Then, from the gasysteme repo, with the App's id and key in the environment:

```
GITHUB_APP_ID=123456 GITHUB_APP_PRIVATE_KEY="$(cat app.pem)" node scripts/agent-node-ruleset.js zicgab/gasysteme
```

That creates **"gab-ai-node: agents push only agent/\*\*"**:
- target: all branches except `refs/heads/agent/**`
- rules: block create, update, delete, force-push
- bypass: repository admins (you)

You can check it at repo *Settings → Rules → Rulesets*. Until it exists and is
active, the backend refuses to give push access for that repo (tasks fail
with a message telling you to run `scripts/agent-node-ruleset.js`).

## Without the App

The backend still works without the App: nodes use their own read-only token
(`gab-node set-secret github`, a fine-grained PAT with *Contents: read* on the
chosen repos) and no task can push.
