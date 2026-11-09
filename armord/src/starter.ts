// The policy `armord init` writes: a sensible coding-agent baseline in armor.io/v2.
export const STARTER_POLICY = `# armord starter policy (armor.io/v2). Edit, then: armord policy check <this file>
apiVersion: armor.io/v2
kind: Policy
metadata:
  name: starter
  description: Coding agent baseline - reads run, shell asks, secrets and destructive commands stop.
target:
  device: local
spec:
  expiresAt: never
  approvalDefaults: {approvers: 1, anyMember: true}
  tools:
    default: allow
    rules:
      # armord tags rm -rf / -fr, git reset --hard, git clean -f, force pushes, mkfs and dd
      # anywhere in a command line (after pipes and && too) with the 'destructive' capability.
      destructive: block
      Bash:
        - when: {pipeToShell: {eq: true}}
          action: block
          reason: downloaded code piped into a shell
        - when: {obfuscated: {eq: true}}
          action: hold
          reason: obfuscated or unparseable shell command
        - when: {envDump: {eq: true}}
          action: hold
          reason: dumps the whole environment
        - when: {args.command: {matches: '(npm|pnpm|yarn)\\s+publish|cargo\\s+publish|twine\\s+upload'}}
          action: hold
          reason: package publish
        # read-only commands run without asking, but only on their own: no ; & | backtick $( or > chaining
        - when: {args.command: {matches: '^\\s*(ls|pwd|cat|head|tail|wc|git\\s+(status|diff|log|show)|npm\\s+(test|run\\s+test)|pytest|cargo\\s+(test|check))\\b[^;&|$<>\`]*$'}}
          action: allow
        - action: hold
  files:
    deny:
      - '~/.ssh/**'
      - '~/.aws/**'
      - '~/.config/gcloud/**'
      - '~/.armoriq/**'
      - '**/.env'
      - '**/.env.*'
      - '**/*.pem'
      - '**/id_rsa*'
  network:
    default: hold
    allow:
      - registry.npmjs.org
      - pypi.org
      - files.pythonhosted.org
      - api.github.com
      - github.com
  secrets:
    envBlocklist: [AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, ARMORIQ_API_KEY]
`;
