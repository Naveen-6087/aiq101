// Module resolve hook for offline mode (see register.mjs).

const here = new URL('./', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@armoriq/sdk') {
    return { url: new URL('armoriq-sdk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/src/mcpClient.js')) {
    return { url: new URL('memory-mcp.mjs', here).href, format: 'module', shortCircuit: true };
  }
  return resolved;
}
