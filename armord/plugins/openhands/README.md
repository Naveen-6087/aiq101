# armord for OpenHands

OpenHands has no hook files; armord plugs in as a security analyzer. The package lives in
[`adapters/openhands`](../../adapters/openhands) (`armord_openhands.ArmordSecurityAnalyzer`).

```bash
pip install ./adapters/openhands openhands-sdk      # openhands-sdk needs Python >= 3.12
armord start                                        # the analyzer talks to the daemon
armord install openhands                            # writes openhands_armord.py with govern()
python example_conversation.py
```

`example_conversation.py` is a runnable-shape script: it builds a conversation, calls `govern()`
and handles the confirmation loop (block -> rejected automatically, hold -> your prompt).

## Verification status

The analyzer is tested against real `openhands-sdk` 1.61 classes. The example script was written
from the SDK's documented Conversation API and has not been run against a live LLM; model and
workspace arguments are placeholders. With the default `NeverConfirm` policy armord's verdict is
not enforced, which is why `govern()` sets `ConfirmRisky`.
