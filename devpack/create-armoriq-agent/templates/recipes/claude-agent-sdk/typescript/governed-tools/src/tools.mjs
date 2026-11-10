// The release assistant's tools, defined as in-process MCP tools with the Claude Agent SDK.
//
// They run inside this Node process (no separate MCP server process). The "release system" here
// is an in-memory stand-in so the recipe runs anywhere; swap the bodies for calls to your CI/CD
// API. The tool handlers do not know about ArmorIQ: the decision happens before they run, in
// canUseTool (src/governance.mjs). Each handler only reports its result back to ArmorIQ.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const SERVER = 'release';

const releases = [
  { version: '2.4.0', commit: '9f3c2ab', build: 'passed', deployed: false },
  { version: '2.3.1', commit: '41d07e5', build: 'passed', deployed: true },
];
const environments = new Set(['production', 'staging', 'staging-old']);

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

// Wraps a handler so every executed call is reported to ArmorIQ with its outcome.
function reported(name, report, handler) {
  return async (args) => {
    try {
      const result = await handler(args);
      await report(name, args, result, { status: 'success' });
      return result;
    } catch (err) {
      await report(name, args, { error: err.message }, { status: 'failed', errorMessage: err.message });
      return { ...text(`Error: ${err.message}`), isError: true };
    }
  };
}

// `report(toolName, args, result, opts)` comes from the governor. Returns the SDK MCP server config.
export function createReleaseServer(report) {
  const tools = [
    tool('list_releases', 'List release candidates with their commit, build status, and whether they are live.', {}, reported('list_releases', report, async () => text(releases))),

    tool(
      'get_build_status',
      'Get the CI build status for one release version.',
      { version: z.string().describe('Release version, for example 2.4.0') },
      reported('get_build_status', report, async ({ version }) => {
        const release = releases.find((r) => r.version === version);
        if (!release) throw new Error(`no release ${version}`);
        return text({ version, build: release.build, commit: release.commit });
      }),
    ),

    tool(
      'deploy_to_production',
      'Deploy a release version to the production environment.',
      { version: z.string().describe('Release version to deploy') },
      reported('deploy_to_production', report, async ({ version }) => {
        const release = releases.find((r) => r.version === version);
        if (!release) throw new Error(`no release ${version}`);
        for (const r of releases) r.deployed = r === release;
        return text(`Deployed ${version} (${release.commit}) to production.`);
      }),
    ),

    tool(
      'delete_environment',
      'Permanently delete a deployment environment and its data.',
      { environment: z.string().describe('Environment name, for example staging-old') },
      reported('delete_environment', report, async ({ environment }) => {
        if (!environments.delete(environment)) throw new Error(`no environment ${environment}`);
        return text(`Deleted environment ${environment}.`);
      }),
    ),
  ];

  return createSdkMcpServer({ name: SERVER, version: '1.0.0', tools });
}
