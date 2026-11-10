// ArmorIQ inside the Claude Agent SDK's canUseTool permission callback.
//
// The Agent SDK calls canUseTool before it runs any tool that is not pre-approved. That is the one
// place every governed call passes through, so the ArmorIQ decision lives here:
//
//   1. grow the turn's plan with the call and (re)anchor it: session.startPlan() captures the plan
//      and mints a signed intent token on the first call, and records a reanchor as the plan grows
//   2. session.check() asks ArmorIQ for allow, hold, or block (mode "sdk": decide only; the tool
//      still runs here, in process)
//   3. allow -> { behavior: "allow" }
//      hold  -> wait for a human in the ArmorIQ console with session.awaitApproval(), then allow
//               only on an explicit approval
//      block -> { behavior: "deny", message } so Claude sees why and can adapt
//
// After a tool runs, its handler calls report() so the result lands in the ArmorIQ audit log.

export function createGovernor({ armoriq, server, userEmail, approvalWaitSeconds = 300 }) {
  // forUser() tags token minting and enforcement with the end user; check() and awaitApproval()
  // also take userEmail per call, so the identity is explicit on every decision.
  const session = armoriq.forUser(userEmail).startSession({ mode: 'sdk', defaultMcpName: server, validitySeconds: 1800 });
  const prefix = `mcp__${server}__`;
  let goal = 'release assistant turn';
  let planned = [];

  // ArmorIQ names a tool <mcp>__<action>; the Agent SDK names it mcp__<server>__<action>.
  const armoriqName = (action) => `${server}__${action}`;

  function startTurn(prompt) {
    goal = prompt;
    planned = [];
  }

  async function canUseTool(toolName, input, { signal, mcpServer }) {
    // Only this app's own in-process server is governed and allowed. Anything else (a built-in
    // that slipped through, or an MCP server from configuration) is denied outright.
    if (!toolName.startsWith(prefix) || (mcpServer && mcpServer.source !== 'sdk')) {
      return { behavior: 'deny', message: `${toolName} is not one of this assistant's governed tools.` };
    }
    const name = armoriqName(toolName.slice(prefix.length));

    // The model reveals its plan one tool call at a time, so the plan grows with each call.
    // startPlan() returns the current token unchanged when the plan has not changed.
    planned = [...planned, { name, args: input }];
    await session.startPlan(planned, goal);

    const decision = await session.check(name, input, userEmail);
    console.log(`[agent] ${name}: ${decision.action}${decision.reason ? ` (${decision.reason})` : ''}`);

    if (decision.allowed) return { behavior: 'allow', updatedInput: input };

    if (decision.action !== 'hold') {
      return { behavior: 'deny', message: `Blocked by ArmorIQ policy: ${decision.reason ?? 'not allowed'}. Do not retry this action.` };
    }

    if (!decision.delegationId) {
      return { behavior: 'deny', message: 'This action needs human approval, but no approval request could be created.' };
    }
    console.log(`[agent] ${name}: waiting for approval (delegation ${decision.delegationId})`);
    const outcome = await abortable(
      session.awaitApproval(decision.delegationId, { timeout: approvalWaitSeconds, interval: 5, userEmail }),
      signal,
    );
    if (outcome === 'approved') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `A human ${outcome === 'rejected' ? 'rejected' : 'did not approve'} ${name}. It was not run.` };
  }

  async function report(action, args, result, opts) {
    await session.report(armoriqName(action), args, result, opts);
  }

  async function close() {
    await session.flushObservability();
    await session.close();
  }

  return { canUseTool, report, startTurn, close };
}

// awaitApproval() has no abort option; stop waiting if the Agent SDK cancels the tool call.
function abortable(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      if (signal.aborted) resolve('timeout');
      signal.addEventListener('abort', () => resolve('timeout'), { once: true });
    }),
  ]);
}
