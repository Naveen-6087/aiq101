// Module resolve hook for offline mode (see register.mjs).
//
// agent.js imports ArmorIQLangChain from '@armoriq/sdk/dist/integrations/langchain.js'. That path is
// deliberately NOT redirected: the real callback handler runs, and only the client it is given
// (the root '@armoriq/sdk') is the offline stand-in.

const here = new URL('./', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@armoriq/sdk') {
    return { url: new URL('armoriq-sdk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  if (specifier === '@langchain/google-genai') {
    return { url: new URL('model.mjs', here).href, format: 'module', shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/src/mcpClient.js')) {
    return { url: new URL('weather-mcp.mjs', here).href, format: 'module', shortCircuit: true };
  }
  return resolved;
}
