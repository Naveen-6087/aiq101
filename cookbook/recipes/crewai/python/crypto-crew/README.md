# Build a CrewAI Crew with the ArmorIQ SDK

A step by step guide to governing a CrewAI crew with `ArmorIQCrew`, the narrowest of ArmorIQ's four framework adapters, and the one where you should understand the trade off before you build anything.

Credit: this recipe comes from the [`crewai-crypto-crew` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/crewai-crypto-crew) in Naveen-6087/aiq-demos, and the guide text is adapted from that repo's CrewAI cookbook page and demo README.

> **Read this before the other steps.** `ArmorIQCrew` works differently from the Google ADK, Strands, and LangChain integrations. It has no `mode` option and is proxy only: it needs a network reachable MCP server, not a locally spawned one. See the Limitations section.

## What you'll build

A two agent crew: a researcher who looks up live crypto prices, and a writer who turns them into a short daily brief. `ArmorIQCrew` wraps `crewai.Crew`. On `kickoff()` it derives an intent plan from the crew's tools and tasks, mints one token for the whole run, and patches any tool that carries `.mcp` and `.action` attributes so its execution routes through ArmorIQ's cloud proxy instead of calling out directly.

That last part is the thing to understand going in. Google ADK, Strands, and LangChain all have per tool call lifecycle hooks, and `mode: "sdk"` lets those integrations execute the approved call locally, so a stdio MCP server on your own machine works fine. CrewAI has no equivalent hook system, so its adapter intercepts the call a different way, by patching the tool to go through the proxy. The proxy is a cloud service and cannot reach a process on your laptop. Against a local server, the live tool call fails with a proxy error unless you deploy the MCP server it targets somewhere reachable. The demo author ran it exactly that way, and the output is shown below so you can see what that looks like.

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `crew.py`, real CrewAI agents and tasks, and the real `ArmorIQCrew` wrapper (plan capture, token issue, tool patching). Two things are stand-ins, both in `offline/`: the ArmorIQ client, which reads `policy.yaml` and serves canned CoinGecko prices, and the Gemini model, which is scripted.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # one coin, one allowed call, then the brief
.venv/bin/python offline/test.py     # the same run as a pass or fail check
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The armoriq-sdk 0.6.10 package needs Python 3.10 to 3.13.

The run prints the shared log lines:

```
[armoriq] plan: Look up current price data for each of these coins: bitcoin. Use the get_c... -> get_price
[armoriq] check get_price: ALLOWED (policy coingecko-policy: get_price -> allow)
[armoriq] report get_price: success
```

Be clear about what this shows. The offline client applies `policy.yaml` per call so that every recipe in this cookbook can run the same way, and so editing a rule changes the offline result. The live `ArmorIQCrew` path does not give you per call allow, hold, or block decisions (see Limitations). `OFFLINE_APPROVAL=reject` is read like everywhere else, but the shipped policy holds nothing, so there is nothing to reject.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 to 3.13 | Runs the crew |
| An ArmorIQ account | Intent verification and audit |
| A Gemini API key | Drives both agents |
| A CoinGecko API key (optional) | Free Demo tier. Keyless access also works |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

CrewAI supports Gemini natively through the `google-genai` extra, and also OpenAI, Anthropic, Bedrock, and anything else through LiteLLM.

## Step 3: Install the project

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # fill in ARMORIQ_API_KEY and GEMINI_API_KEY
```

`requirements.txt` pins every package with `==`.

## Step 4: A tool ArmorIQ can see

`ArmorIQCrew` only wraps tools that expose both an `.mcp` and an `.action` attribute. A plain `@tool` function has nowhere to put them, so `crypto_tool.py` is a `BaseTool` subclass:

```python
class CryptoPriceTool(BaseTool):
    name: str = "get_crypto_price"
    args_schema: Type[BaseModel] = CryptoPriceInput

    # The two fields ArmorIQCrew's adapter looks for on every agent tool.
    mcp: str = "coingecko"
    action: str = "get_price"
```

> **It fails open when it finds nothing to protect.** If no tool on any agent has both `.mcp` and `.action`, `ArmorIQCrew` logs a warning and runs the crew anyway, unenforced. Remove those two fields and the crew runs the same, with no ArmorIQ involved. A misconfigured tool looks identical to a protected run unless you watch the logs.

## Step 5: Run the crew unwrapped first

Verify the tool and agents work before ArmorIQ is anywhere near them:

```bash
python crew_unwrapped.py
```

This is plain `crewai.Crew` with no ArmorIQ. The demo author ran it as written and got a correct brief from live data, for example "Bitcoin edging up a modest 0.097% to trade at $84,018". That confirms the crew mechanics are right, independent of ArmorIQ.

## Step 6: Register a coingecko MCP server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `coingecko`.
4. Save.

To get a wrapped crew that completes a real tool call, this must point at a deployed, network reachable copy of an MCP server exposing a `get_price` tool, speaking JSON-RPC 2.0 over HTTP with SSE responses, not stdio. See the [MCP Format Requirements guide](https://docs.armoriq.ai/sdk/mcp-directory/mcp-format). The demo author did not deploy one, which is why Step 8 shows the proxy error.

The matching policy is `policy.yaml`: the `get_price` tool is allowed and everything else is blocked.

## Step 7: Wrap it with ArmorIQCrew

`crew.py` builds the crew and returns it wrapped:

```python
return ArmorIQCrew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    process=Process.sequential,
    armoriq_client=ArmorIQClient(api_key=os.environ["ARMORIQ_API_KEY"]),
    llm=f"gemini/{os.environ.get('GEMINI_MODEL', 'gemini-flash-lite-latest')}",
    verbose=True,
)
```

Every argument other than `armoriq_client`, `llm`, and `token_validity_seconds` is forwarded to `crewai.Crew` unchanged, so an existing crew definition moves over as is.

## Step 8: Run it and read what happens

```bash
python crew.py
```

Without a deployed, reachable `coingecko` MCP server, the demo author got:

```
I encountered an error while trying to use the tool. This was the error:
MCP invocation failed: {'success': False, 'error': 'Internal Proxy Error', ...}
```

This is the documented limitation, not a bug. ArmorIQ's cloud proxy cannot reach a stdio process on your machine, and `ArmorIQCrew` has no local execution mode to fall back to. The interesting part is that the writer agent's backstory says it "only reports numbers it actually looked up", so the crew does not fabricate a price when the tool fails. It explains that it could not get real data:

> Today's crypto market data is temporarily unavailable due to a technical glitch with our price tracking tools... Because we rely strictly on verified live data rather than estimates, we cannot confirm whether the major coins are currently trading in the green or the red.

That is fail closed behavior one level up: even when the infrastructure is not fully wired, the crew refuses to guess.

What you get without deploying anything is intent verification (a plan is captured and a token minted from your crew's tools and tasks before anything runs) and an audit trail, not live policy gating.

## Limitations

Straight from ArmorIQ's SDK docs, and confirmed by the run above.

| | Google ADK / Strands / LangChain | CrewAI |
|---|---|---|
| Enforcement point | Lifecycle hooks, works with `mode: "sdk"` (local execution) | Patches the tool call itself, proxy only |
| Works with a local stdio MCP server | Yes | No, the proxy has to reach the server |
| Per user scoping | Yes | No, the whole crew runs as one identity |
| Per call policy (allow, hold, block) | Yes | No |
| Holds and approvals | Yes | No |
| One token covers | One plan | The whole `kickoff()` run, so its validity has to span the entire crew run (default one hour, not the SDK's usual 60 seconds) |
| No `.mcp` and `.action` tools found | n/a | Runs unenforced and logs a warning |

If you need per call enforcement, holds, or approvals on a CrewAI style multi agent setup, drive `ArmorIQSession` directly from inside a custom tool's `_run` instead of using `ArmorIQCrew`. See the Strands or LangChain recipes in this cookbook for that lower level pattern.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Internal Proxy Error` on every tool call | Expected without a deployed, reachable MCP server, see Step 6 |
| The crew runs but nothing shows up in ArmorIQ's dashboard | No tool has both `.mcp` and `.action`, so the adapter failed open (a warning in the logs, easy to miss) |
| `No matching distribution found for armoriq-sdk==0.6.10` | Your Python is 3.14 or newer. Use 3.10 to 3.13 |
| `429 RESOURCE_EXHAUSTED` from Gemini | Free tier daily quota per model. Try `gemini-flash-lite-latest`, which has a separate quota |
| Windows console shows `'charmap' codec can't encode character` warnings | Cosmetic. CrewAI's event logging prints emoji your code page cannot render. Safe to ignore |

## What's next

* **See the enforced version of this domain.** The CoinGecko recipe (`sdk/typescript/crypto-prices`) uses the same kind of MCP server with `mode: "sdk"` and gets real allow, hold, and block decisions with no deployment required.
* **Deploy the MCP server for real.** Wrap a CoinGecko MCP server in an HTTP and SSE transport per the MCP Format Requirements guide, deploy it, and re-point Step 6's registration at the deployed URL to see the live tool call succeed.
