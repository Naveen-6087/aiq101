// Offline stand-in for @armoriq/sdk. Same calls agent.js makes, checked against the Step 5 policy
// locally: the four read only tools are allowed, and everything else is blocked by default.

const ALLOWED_TOOLS = ['search_repositories', 'list_commits', 'list_issues', 'get_file_contents'];

class OfflineSession {
  async startPlan(toolCalls, goal) {
    console.log(`[armoriq] plan: ${goal} -> ${toolCalls.map((c) => c.name).join(', ')}`);
  }

  async check(toolName) {
    const allowed = ALLOWED_TOOLS.includes(toolName);
    const reason = allowed ? 'allowlisted' : 'tool-not-allowlisted';
    console.log(`[armoriq] check ${toolName}: ${allowed ? 'ALLOWED' : 'BLOCKED'} (${reason})`);
    return { allowed, action: allowed ? 'allow' : 'block', reason };
  }

  async report(toolName, args, result, opts = {}) {
    console.log(`[armoriq] report ${toolName}: ${opts.status ?? 'success'}`);
  }

  async flushObservability() {}

  async close() {}
}

export class ArmorIQClient {
  async bootstrap() {}

  forUser() {
    return { startSession: () => new OfflineSession() };
  }
}
