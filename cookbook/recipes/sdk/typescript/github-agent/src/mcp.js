import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient = null;
let mcpTransport = null;

export async function connectGitHubMcp(githubToken) {
  if (mcpClient) return mcpClient;

  mcpTransport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
  });

  mcpClient = new Client(
    { name: "armoriq-github-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

export async function listTools() {
  const result = await mcpClient.listTools();
  return result.tools;
}

export async function callTool(toolName, args) {
  return mcpClient.callTool({ name: toolName, arguments: args });
}

export async function disconnectGitHubMcp() {
  if (mcpTransport) {
    await mcpTransport.close();
    mcpTransport = null;
    mcpClient = null;
  }
}
