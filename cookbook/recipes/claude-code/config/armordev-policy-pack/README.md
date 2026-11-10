# Apply the ArmorDev Policy Pack to Claude Code with ArmorClaude

A ready policy for a coding agent doing everyday software work. Reads, edits, tests, and builds run without a prompt. Secrets and keys are out of reach, destructive commands and pushes to `main` never run, and publishing a package or reaching the network from the shell waits for you. There is no app code here: the recipe is the policy itself, in the format ArmorClaude loads, plus the same rules for ArmorCodex.

## What you'll get

| Area | What the agent tries | ArmorClaude |
|---|---|---|
| Secret and key quarantine | Read, Write, Edit, Grep, or Glob on `.env*` (not `.env.example`), `~/.ssh`, `~/.aws`, `id_rsa` style keys, `*.pem`, `*.key`, `credentials` files, `.netrc`, `.npmrc`, `.pypirc`, `.kube/config`. A shell command that names one (`cat .env`) | block |
| Destructive commands | `rm -r` / `rm -rf`, `git reset --hard`, `git clean -f`, `dd of=`, `mkfs`, `shred`, `Remove-Item -Recurse` | block |
| Git safety | `git push --force` (or `-f`, `--force-with-lease`, `+branch`), any push that names `main` or `master` | block |
| Network from the shell | `curl ... \| sh`, `bash -c "$(curl ...)"`, `iwr ... \| iex` | block |
| | Any other `curl`, `wget`, `nc`, `scp`, `rsync`, `ssh` | hold |
| Publishing | `npm publish`, `cargo publish`, `twine upload`, `poetry publish`, `gem push`, `gh release create`, `docker push` | hold |
| Tests and builds | `npm test`, `npm run build`, `pytest`, `go test`, `cargo build`, `make`, `tsc`, `git status/diff/log/add/commit`, `ls`, `cat`, `grep` | allow |
| Everything else in the shell | `docker compose up`, `git push origin feature/x`, `echo x > file`, anything chained with `&&` or `;` | hold |
| Everything else | Read, Grep, Glob, edits outside the secret list, web search, MCP tools | allow |

The pack lives in three files:

| File | What it is |
|---|---|
| `armorclaude/armordev.json` | The policy ArmorClaude enforces: an `armor.policy.v1` `PolicyProfile`. |
| `armorcodex/policy-profiles.json` | The same rules in ArmorCodex's rule list format, as a saved profile named `armordev`. |
| `policy.yaml` | A readable summary for the recipe browser. Neither plugin reads it. |

## Run it offline

No plugin, accounts, keys, or network needed. Node 20 or newer, no `npm install`:

```bash
node offline/demo.mjs     # one coding session: a read, a blocked .env, tests, a blocked reset and push, a held publish
node offline/test.mjs     # 42 sample calls against both plugins' rules, as a pass or fail check
```

`offline/test.mjs` first validates `armorclaude/armordev.json` with the same checks ArmorClaude runs when you stage a policy, and checks that `policy.yaml` names the same rules. Then it runs every call in `offline/cases.mjs` through a small evaluator that copies each plugin's matching rules (`offline/evaluate.mjs` says which source files it follows) and exits non zero on any verdict that differs from the table. Each decision prints one line:

```
[armoriq] check Bash: ALLOWED (policy armordev: allow-test-build -> allow)
[armoriq] check Bash: HELD (policy armordev: hold-package-publish -> hold)
[armoriq] hold Bash: APPROVED
[armoriq] check Bash: BLOCKED (policy armordev: forbid-push-protected-branch -> block)
```

Set `OFFLINE_APPROVAL=reject` to see held calls rejected instead. Edit a statement in `armorclaude/armordev.json` (say, change `hold-package-publish` to `forbid`) and the offline result changes with it; the test then tells you which rows of `offline/cases.mjs` and `policy.yaml` to update.

## Before you start

| Requirement | Why |
|---|---|
| Claude Code | The agent this pack guards |
| ArmorClaude installed | Enforces the policy in Claude Code's hooks |

Install ArmorClaude if you have not:

```bash
curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

## Step 1: Stage the pack

Open Claude Code in any project. Type `/armorclaude:armor policy stage `, then paste the whole contents of `armorclaude/armordev.json` after it, and send:

```text
/armorclaude:armor policy stage {
  "schemaVersion": "armor.policy.v1",
  "kind": "PolicyProfile",
  ...the rest of armorclaude/armordev.json...
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
/armorclaude:armor profile save armordev
```

Only you can do this. Claude can read the policy and suggest drafts, but ArmorClaude does not let it confirm a change, edit `policy.json`, or call the policy commands through Bash.

## Step 3: See a held and a blocked action

Ask Claude:

```text
Run `npm publish --dry-run` in this repo.
```

Claude Code shows its normal approval prompt, with ArmorClaude's reason `ArmorClaude policy requires approval: hold-package-publish`. A dry run publishes nothing, so approving is safe.

Then ask:

```text
Run `git push origin main`.
```

ArmorClaude denies the call with `ArmorClaude policy forbid: forbid-push-protected-branch`, and nothing is pushed. Check what is active at any time with `/armorclaude:armor policy list`.

## Using it with Codex (ArmorCodex)

The same rules ship for ArmorCodex in `armorcodex/policy-profiles.json`. ArmorCodex keeps saved profiles in `policy-profiles.json` in its data folder (`~/.codex/armorcodex/` unless `ARMORCODEX_DATA_DIR` or the plugin's data folder says otherwise), so applying the pack is a file copy and a switch:

1. Install ArmorCodex (`curl -fsSL https://armoriq.ai/install_armorcodex.sh | bash`) and make sure `~/.codex/config.toml` has `[features] codex_hooks = true`.
2. If `~/.codex/armorcodex/policy-profiles.json` does not exist, copy `armorcodex/policy-profiles.json` there. If it does, add the `armordev` entry from this file under its `profiles` key.
3. In Codex, run `armor profile switch armordev`, read the diff, then `armor yes`.

Three differences from ArmorClaude, all from the plugin, not the pack:

- **No hold.** In ArmorCodex 0.3.2 a `require_approval` rule makes the PreToolUse hook deny the call with "ArmorCodex policy requires approval: ...". Publishing and shell network calls are therefore blocked on Codex, not paused. The docs describe hold as a pause, so check your version.
- **No catch all hold for the shell.** Because a hold denies on Codex, the "hold everything else in the shell" rule is left out. Shell commands the pack does not name are allowed.
- **Coverage.** Codex hooks fire for Bash, `apply_patch`, and MCP tool calls only. `list_dir`, `view_image`, `web_search`, and the orchestration tools are not gated ([CODEX_HARNESS_LIMITATIONS.md](https://github.com/armoriq/armorCodex/blob/main/CODEX_HARNESS_LIMITATIONS.md)). Codex hooks are also disabled on Windows.

The secret rule matches any string in the call (`anyParam`), so an `apply_patch` that edits `.env.local` is blocked, and so is a patch whose text merely mentions `.env`.

## Limits

Be clear about what this is: a policy over tool calls, not a sandbox.

- **Path rules are not an OS sandbox.** `forbid-secret-files` reads the `file_path` or `path` a tool is given. A symlink, a relative path built at run time, or a tool that takes no path gets past it. ArmorIQ's own docs say the same about folder rules.
- **Shell rules match command text.** A script (`bash ./cleanup.sh`), an alias, a variable, or an encoded command (`eval "$(echo ... | base64 -d)"`) hides what it does. On ArmorClaude those land in `hold-unlisted-shell`, so you still get asked, but they are never recognised as destructive. The same weakness in ArmorClaude's own policy file guard is tracked in [armoriq/armorClaude#358](https://github.com/armoriq/armorClaude/issues/358). Both cases are in the offline table, marked `[known gap]`.
- **A bare `git push` while on `main` is held, not blocked.** The branch is not in the command text.
- **Some safe commands are blocked.** `rm -rf node_modules` is blocked, and so is `git commit -m "ignore .env"` because the text names `.env`. Run those yourself, or narrow the pattern.
- **Matching is case sensitive on ArmorClaude** (`new RegExp(value)` with no flags) and case insensitive on ArmorCodex.
- **The offline evaluator is a copy.** It follows ArmorClaude 0.2.9 (`scripts/lib/policy-ir.mjs`) and ArmorCodex 0.3.2 (`plugins/armorcodex/scripts/lib/policy.mjs`, `common.mjs`). It does not run intent plan checks, crypto policy binding, or OPA mode, which the real plugins apply around this step.

## Change it

Every rule is one statement in `armorclaude/armordev.json`. ArmorClaude evaluates all statements and the strictest match wins: `forbid` beats `require_approval` beats `permit`, and anything unmatched falls to `defaults.decision` (`allow` here). To let `curl` run freely, delete `hold-network-shell`. To add a command to the free list, add it to the `^(?:...)` list in both `hold-unlisted-shell` and `allow-test-build`. Then add a row to `offline/cases.mjs`, run `node offline/test.mjs`, and stage the file again.

## What's next

* **ArmorOps pack.** The sibling recipe `claude-code/config/armorops-policy-pack` does the same for kubectl, terraform, aws, docker, and helm.
* **Share it with your team.** After `profile save armordev`, `/armorclaude:armor profile push armordev` sends the profile to your ArmorIQ organization, and teammates run `/armorclaude:armor profile pull`.
* **Watch what gets held.** A week of real sessions shows which held commands you always approve. Move those into `allow-test-build`.
