// Module resolve hook for offline mode (see register.mjs).

const here = new URL('./', import.meta.url);
const adkStandIn = new URL('adk.mjs', here).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@armoriq/sdk/dist/integrations/google_adk') {
    return { url: new URL('armoriq-adk.mjs', here).href, format: 'module', shortCircuit: true };
  }
  // The stand-in itself imports the real ADK, so only redirect everyone else.
  if (specifier === '@google/adk' && context.parentURL !== adkStandIn) {
    return { url: adkStandIn, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
