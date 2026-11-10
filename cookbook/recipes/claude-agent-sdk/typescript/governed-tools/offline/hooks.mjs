// Module resolve hook for offline mode (see register.mjs).

const here = new URL('./', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@armoriq/sdk') {
    return { url: new URL('armoriq-sdk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: new URL('claude-agent-sdk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
