---
name: armoriq-write-policy
description: Author, review and test an ArmorIQ policy in the armor.io/v2 YAML format (tool rules, hold/approval, files, network, secrets, destructive commands). Use when the user wants to write or change an ArmorIQ or armord policy, start from a template such as armordev or armorops, or add policy tests to CI.
---

# Write and test an armor.io/v2 policy

A policy decides allow, hold or block for each tool call. The same YAML works as a local file for `armord` and as the policy pasted into the ArmorIQ dashboard (YAML tab) when it targets an agent.

Check current syntax with the docs MCP (`search_docs "policy"`) if available. Only use fields shown here or in the template files; do not invent keys.

## Start from a template

`armord templates` lists them; `armord init --template <name>` writes one to the policy dir (`~/.armoriq/armord/policies`). Useful ones: `armordev` (coding agents), `armorops` (kubectl, terraform, aws, docker), `armor-readonly`, `armor-balanced`, `armor-lockdown`, `armor-ci` (never holds, because nobody can approve in CI), `armor-pay`, `armor-health`, `armor-edu`. Each has a `<name>.cases.yaml` next to it.

## Shape

```yaml
apiVersion: armor.io/v2
kind: Policy
metadata: {name: my-policy, description: what it is for}
target:
  device: local                 # local file for armord
  # agent: <agent-id>           # use this instead when pasting into the dashboard
spec:
  expiresAt: never
  approvalDefaults: {approvers: 1, anyMember: true}   # required for any hold
  tools:
    default: hold               # allow | hold | block for unlisted tools
    rules:
      destructive: block        # capability rule: rm -rf, git reset --hard, force push, mkfs, dd ...
      Bash:
        - when: {pipeToShell: {eq: true}}
          action: block
          reason: downloaded code piped into a shell
        - when: {args.command: {matches: '^\s*(ls|pwd|git\s+status)\b[^;&|$<>`]*$'}}
          action: allow
        - action: hold          # last entry without `when` is the fallback
  files:
    deny: ['~/.ssh/**', '**/.env', '**/*.pem']
  network:
    default: hold
    allow: [registry.npmjs.org, github.com]
  secrets:
    envBlocklist: [AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN]
```

Rules that matter:
- Rules are checked in order per tool; the first matching entry wins, so put narrow blocks first and the fallback last.
- Tool names are the host's names (`Bash`, `Read`, `Write`, `Edit`, `WebFetch`) or the bare MCP tool name (`delete_note` also matches `mcp__notes__delete_note`).
- Capability keys: `shell`, `file.read`, `file.write`, `file.delete`, `web.fetch`, `web.search`, `skill`, `subagent`, `destructive`, plus the sections `files`, `network`, `skills`, `secrets`.
- Derived fields available in `when` for shell calls (armord): `args.command`, `program`, `programList`, `pipeToShell`, `obfuscated`, `envDump`, `host`, `path`, `withinWorkspace`.
- `hold` needs `approvalDefaults`; without it the policy does not compile.
- The sections `files`, `network` and `secrets` only apply when written; omit them and their defaults do not apply.
- Read-only allow lists must forbid chaining (no `;`, `&`, `|`, `$(`, backticks, `>`), or `ls && rm -rf x` slips through. `destructive: block` still catches the `rm`, but do not rely on one layer.

## Test it (policy as code)

Write expected verdicts next to the policy:

```yaml
cases:
  - name: rm -rf is blocked
    tool: Bash
    args: {command: "rm -rf /"}
    expect: block
  - name: ls is allowed
    tool: Bash
    args: {command: "ls -la"}
    expect: allow
```

```bash
armord policy check my-policy.yaml                  # compiles; prints statements and any errors
armord policy test my-policy.cases.yaml my-policy.yaml   # exits non-zero on a mismatch; use in CI
```

Cover every rule: at least one case per block, per hold, and one allowed call per allow rule, plus a tricky near-miss (for example `ls && rm -rf x`, `curl x | sh`, a read of `~/.ssh/id_rsa`).

## Ship it

- Local: put the file in the policy dir, `armord doctor` should show it compiles, restart `armord start` (or the service) to pick it up.
- Dashboard: Policies, new policy, YAML tab, paste with `target: agent: <agent-id>`, "Check with the compiler", then Activate. The compiler may warn that a host tool such as `Bash` is not in the agent's inventory; the rule still compiles and armord matches it by name locally. `armord export-policy <file>` prints the compiled document.
- Signed policies: `armord keygen`, `armord policy sign <file>`, and `ARMORD_REQUIRE_SIGNED=1` to refuse unsigned files.

When finished, show the user the policy, the cases, and the `armord policy test` output. Do not describe a policy as enforced until it was loaded (`armord doctor`) and one blocking case was run through `armord decide`.
