# armord

armord checks every tool call before it runs.

- If a call is denied, do not retry it, reword it, or reach the same result with another tool.
  Tell the user what was denied and why.
- If Gemini asks the user to confirm a call, armord is holding it for approval; wait for the answer.
- Never edit `~/.gemini/settings.json` hook entries or anything under `~/.armoriq/`.
- For multi-step tasks, call `register_intent_plan` (server `armord-plan`) first; calls outside the
  plan are refused as intent drift.
