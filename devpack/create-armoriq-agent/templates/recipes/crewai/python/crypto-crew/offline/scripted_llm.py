"""A scripted CrewAI model that stands in for Gemini. It speaks CrewAI's text tool format."""

import ast
import json
import re

from crewai.llms.base_llm import BaseLLM


def _text(messages):
    if isinstance(messages, str):
        return messages
    return "\n".join(str(m.get("content", "")) for m in messages)


class ScriptedLLM(BaseLLM):
    """Researcher: one get_crypto_price call per coin, then a final answer. Writer: a short brief."""

    def __init__(self, model="scripted", **kwargs):
        kwargs.pop("api_key", None)
        super().__init__(model=model, **kwargs)

    def call(self, messages, tools=None, callbacks=None, available_functions=None,
             from_task=None, from_agent=None, response_model=None):
        text = _text(messages)
        if "Daily Crypto Brief" in text and "Crypto Market Writer" in text:
            return self._brief(text)
        match = re.search(r"each of these coins: ([a-z0-9,\s-]+?)\.", text)
        coins = [c.strip() for c in match.group(1).split(",")] if match else ["bitcoin"]
        # The prompt template itself mentions "Observation:", so only count what follows "Begin!".
        tail = text.split("Begin!")[-1]
        looked_up = len(re.findall(r"^Observation:", tail, flags=re.M))
        if looked_up < len(coins):
            args = json.dumps({"coin_id": coins[looked_up], "vs_currency": "usd"})
            return (
                f"Thought: I need the current price for {coins[looked_up]}.\n"
                f"Action: get_crypto_price\nAction Input: {args}"
            )
        observations = re.findall(r"^Observation:\s*(.+)", tail, flags=re.M)
        return "Thought: I now know the final answer\nFinal Answer: " + " ; ".join(
            f"{coin}: {obs.strip()}" for coin, obs in zip(coins, observations)
        )

    @staticmethod
    def _brief(text):
        context = text.split("This is the context you're working with:")[-1]
        coins = []
        for name, raw in re.findall(r"^([\w-]+): (\{.*\})", context, flags=re.M):
            try:
                coins.append((name.capitalize(), ast.literal_eval(raw)))
            except (ValueError, SyntaxError):
                continue
        if not coins:
            body = "Price data was not available, so this brief makes no claims about the market."
        else:
            lines = []
            for name, data in coins:
                change = data.get("usd_24h_change", 0.0)
                direction = "up" if change >= 0 else "down"
                lines.append(
                    f"{name} is {direction} {abs(change):.2f}% over 24 hours at ${data['usd']:,.2f}, "
                    f"with a market cap near ${data['usd_market_cap'] / 1e9:,.0f} billion."
                )
            body = " ".join(lines) + "\n\nThese figures are canned CoinGecko answers served by the offline stand-in."
        return "Thought: I now can give a great answer\nFinal Answer: " + body

    def supports_function_calling(self):
        return False

    def get_context_window_size(self):
        return 8192
