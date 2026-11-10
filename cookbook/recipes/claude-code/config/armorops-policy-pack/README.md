# Apply the ArmorOps Policy Pack to Claude Code with ArmorClaude

A ready policy for a coding agent you point at live infrastructure. Looking around (`kubectl get`, `aws ... describe-*`, `terraform plan`, `docker ps`, `helm list`) runs without a prompt. Changing something (`kubectl apply`, `terraform apply`, `helm upgrade`, `docker restart`) waits for you. Anything you cannot undo (`terraform destroy`, `kubectl delete namespace`, `aws rds delete-db-instance`) never runs. There is no app code here: the recipe is the policy itself, in the format ArmorClaude loads, plus the same rules for ArmorCodex.

## What you'll get

| Area | What the agent tries | ArmorClaude |
|---|---|---|
| Discovery | `kubectl get/describe/logs/top`, `kubectl rollout status`, `aws <service> describe-*/list-*/get-*`, `aws s3 ls`, `terraform plan/validate/show/output/init`, `docker ps/logs/inspect`, `helm list/status/history` (optionally piped into `grep`, `head`, `jq`) | allow |
| State changes | `kubectl apply/create/patch/rollout restart/scale/delete <pod>/exec`, `terraform apply/import/state mv`, `helm install/upgrade/rollback`, `docker restart/stop/run/rm`, `aws ... create-*/update-*/put-*/modify-*/start-*/stop-*/run-*`, `aws s3 cp/mv/rm/sync` | hold |
| Secret values | `kubectl get secret`, `kubectl config view --raw`, `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption` | hold |
| Irreversible | `terraform destroy`, `terraform apply -destroy`, `kubectl delete namespace`, `kubectl delete ... --all`, `aws ... delete-db-instance/delete-db-cluster/terminate-instances/delete-bucket/delete-stack/delete-table`, `aws s3 rb`, `aws s3 rm --recursive`, `helm uninstall`, `docker system/volume prune`, `gcloud ... delete`, `az group delete` | block |
| Credentials and state | Read, Write, Edit, Grep, or Glob on `~/.aws/credentials`, `~/.kube/config`, `~/.terraform.d` credentials, `~/.config/gcloud`, `~/.azure`, `*.tfstate`. A shell command that names one (`cat ~/.kube/config`) | block |
| Everything else in the shell | `kubectl port-forward`, scripts, anything chained with `&&` or `;` that is not already held or blocked | hold |
| Everything else | Read, Grep, Glob of your infra code, web search, MCP tools | allow |

The pack lives in three files:

| File | What it is |
|---|---|
| `armorclaude/armorops.json` | The policy ArmorClaude enforces: an `armor.policy.v1` `PolicyProfile`. |
| `armorcodex/policy-profiles.json` | The same rules in ArmorCodex's rule list format, as a saved profile named `armorops`. |
| `policy.yaml` | A readable summary for the recipe browser. Neither plugin reads it. |

## Run it offline

No plugin, cloud account, cluster, keys, or network needed. Node 20 or newer, no `npm install`:

```bash
node offline/demo.mjs     # one incident: look at pods and logs, a held restart, a blocked destroy and namespace delete
node offline/test.mjs     # 43 sample calls against both plugins' rules, as a pass or fail check
```

`offline/test.mjs` first validates `armorclaude/armorops.json` with the same checks ArmorClaude runs when you stage a policy, and checks that `policy.yaml` names the same rules. Then it runs every call in `offline/cases.mjs` through a small evaluator that copies each plugin's matching rules (`offline/evaluate.mjs` says which source files it follows) and exits non zero on any verdict that differs from the table. Each decision prints one line:

```
[armoriq] check Bash: ALLOWED (policy armorops: allow-discovery -> allow)
[armoriq] check Bash: HELD (policy armorops: hold-state-change -> hold)
[armoriq] hold Bash: APPROVED
[armoriq] check Bash: BLOCKED (policy armorops: forbid-irreversible -> block)
```

Set `OFFLINE_APPROVAL=reject` to see held calls rejected instead. Edit a statement in `armorclaude/armorops.json` and the offline result changes with it; the test then tells you which rows of `offline/cases.mjs` and `policy.yaml` to update.

## Before you start

| Requirement | Why |
|---|---|
| Claude Code | The agent this pack guards |
| ArmorClaude installed | Enforces the policy in Claude Code's hooks |
| kubectl, aws, terraform, helm, or docker | Whatever your agent will run. The pack only governs the calls; it needs none of them to load |

Install ArmorClaude if you have not:

```bash
curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

## Step 1: Stage the pack

Open Claude Code in your infra repo. Type `/armorclaude:armor policy stage `, then paste the whole contents of `armorclaude/armorops.json` after it, and send:

```text
/armorclaude:armor policy stage {
  "schemaVersion": "armor.policy.v1",
  "kind": "PolicyProfile",
  ...the rest of armorclaude/armorops.json...
}
```

ArmorClaude validates the JSON and shows a diff against your current policy. Nothing is active yet.

## Step 2: Confirm it

Read the diff, then:

```text
/armorclaude:armor yes
```

The pack is now your active policy. To keep it as a named profile you can switch back to later:

```text
/armorclaude:armor profile save armorops
```

Only you can do this. Claude can read the policy and suggest drafts, but ArmorClaude does not let it confirm a change, edit `policy.json`, or call the policy commands through Bash.

## Step 3: See a held and a blocked action

Ask Claude:

```text
Run `kubectl scale deploy/web --replicas=1 --dry-run=client -o yaml`.
```

Claude Code shows its normal approval prompt, with ArmorClaude's reason `ArmorClaude policy requires approval: hold-state-change`. A client side dry run changes nothing, so approving is safe (it does need `kubectl` installed).

Then ask:

```text
Run `kubectl delete namespace armorops-test`.
```

ArmorClaude denies the call with `ArmorClaude policy forbid: forbid-irreversible`, and `kubectl` never runs. Check what is active at any time with `/armorclaude:armor policy list`.

## Using it with Codex (ArmorCodex)

The same rules ship for ArmorCodex in `armorcodex/policy-profiles.json`. ArmorCodex keeps saved profiles in `policy-profiles.json` in its data folder (`~/.codex/armorcodex/` unless `ARMORCODEX_DATA_DIR` or the plugin's data folder says otherwise), so applying the pack is a file copy and a switch:

1. Install ArmorCodex (`curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash`) and make sure `~/.codex/config.toml` has `[features] codex_hooks = true`.
2. If `~/.codex/armorcodex/policy-profiles.json` does not exist, copy `armorcodex/policy-profiles.json` there. If it does, add the `armorops` entry from this file under its `profiles` key.
3. In Codex, run `armor profile switch armorops`, read the diff, then `armor yes`.

Three differences from ArmorClaude, all from the plugin, not the pack:

- **No hold.** In ArmorCodex 0.3.2 a `require_approval` rule makes the PreToolUse hook deny the call with "ArmorCodex policy requires approval: ...". State changes and secret reads are therefore blocked on Codex, not paused, which makes the pack read mostly: you run the `apply` yourself. The docs describe hold as a pause, so check your version.
- **No catch all hold for the shell.** Because a hold denies on Codex, the "hold everything else in the shell" rule is left out. Shell commands the pack does not name are allowed.
- **Coverage.** Codex hooks fire for Bash, `apply_patch`, and MCP tool calls only. `list_dir`, `view_image`, `web_search`, and the orchestration tools are not gated ([CODEX_HARNESS_LIMITATIONS.md](https://github.com/armoriq/armorCodex/blob/main/CODEX_HARNESS_LIMITATIONS.md)). Codex hooks are also disabled on Windows.

## Limits

Be clear about what this is: a policy over tool calls, not a sandbox, and not a replacement for scoped cloud credentials.

- **Give the agent read only credentials anyway.** The strongest control for an infra copilot is an IAM role or kubeconfig that cannot delete a database. This pack is the second layer that also catches the human mistakes.
- **Shell rules match command text.** An alias (`k delete ns prod`), a wrapper script (`bash ./teardown.sh`), a variable, or a Makefile target hides what it does. On ArmorClaude those land in `hold-unlisted-shell`, so you still get asked, but they are never recognised as irreversible. The same weakness in ArmorClaude's own policy file guard is tracked in [armoriq/armorClaude#358](https://github.com/armoriq/armorClaude/issues/358). Both cases are in the offline table, marked `[known gap]`.
- **Flags placed first are not recognised.** `aws --region us-east-1 ec2 describe-instances` is held, not allowed, because the discovery list expects the service name right after `aws`. `kubectl -n prod get pods` is held for the same reason.
- **MCP tools are not covered.** If your agent reaches Kubernetes or AWS through an MCP server rather than the shell, those calls fall to the default `allow`. Use `/armorclaude:armor mcp deny <server>`, or add statements for `mcp__<server>__*` tools.
- **Path rules are not an OS sandbox.** `forbid-cloud-credential-files` reads the `file_path` or `path` a tool is given; a symlink or a tool that takes no path gets past it.
- **Matching is case sensitive on ArmorClaude** (`new RegExp(value)` with no flags) and case insensitive on ArmorCodex.
- **The offline evaluator is a copy.** It follows ArmorClaude 0.2.9 (`scripts/lib/policy-ir.mjs`) and ArmorCodex 0.3.2 (`plugins/armorcodex/scripts/lib/policy.mjs`, `common.mjs`). It does not run intent plan checks, crypto policy binding, or OPA mode, which the real plugins apply around this step.

## Change it

Every rule is one statement in `armorclaude/armorops.json`. ArmorClaude evaluates all statements and the strictest match wins: `forbid` beats `require_approval` beats `permit`, and anything unmatched falls to `defaults.decision` (`allow` here). That is why `aws secretsmanager get-secret-value` is held even though it also matches the `get-*` discovery list. To add a read only command, add it to the `^(?:...)` list in both `hold-unlisted-shell` and `allow-discovery`. Then add a row to `offline/cases.mjs`, run `node offline/test.mjs`, and stage the file again.

## What's next

* **ArmorDev pack.** The sibling recipe `claude-code/config/armordev-policy-pack` covers everyday coding: secrets, destructive git and shell commands, and package publishing.
* **Share it with your team.** After `profile save armorops`, `/armorclaude:armor profile push armorops` sends the profile to your ArmorIQ organization, and teammates run `/armorclaude:armor profile pull`.
* **Tighten the default.** Once you have watched a week of sessions, set `defaults.decision` to `hold` so that new tools the agent picks up ask first too.
