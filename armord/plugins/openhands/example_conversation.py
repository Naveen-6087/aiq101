"""Run an OpenHands SDK conversation under armord. Needs: armord start, pip install ./adapters/openhands openhands-sdk.

Placeholders: set LLM_MODEL / LLM_API_KEY yourself; the key is read from the environment and never stored here.
"""
import os

from openhands.sdk import LLM, Conversation
from openhands.sdk.conversation.state import ConversationExecutionStatus
from openhands.tools.preset.default import get_default_agent

from armord_openhands import ArmordSecurityAnalyzer, confirm_risky_policy, pending_actions, reject_blocked


def main() -> None:
    llm = LLM(model=os.environ.get("LLM_MODEL", "anthropic/claude-sonnet-5-5"), api_key=os.environ["LLM_API_KEY"])
    workspace = os.getcwd()
    conversation = Conversation(agent=get_default_agent(llm=llm, cli_mode=True), workspace=workspace)

    analyzer = ArmordSecurityAnalyzer(cwd=workspace)
    conversation.set_security_analyzer(analyzer)
    conversation.set_confirmation_policy(confirm_risky_policy())  # required, or armord is not enforced

    conversation.send_message("List the files here, then try to read ~/.ssh/id_rsa.")
    conversation.run()
    while conversation.state.execution_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
        if not reject_blocked(conversation, analyzer):  # armord blocked it: rejected, no question asked
            actions = pending_actions(conversation)
            answer = input(f"armord holds {len(actions)} action(s) for approval. Run them? [y/N] ")
            if answer.strip().lower() != "y":
                conversation.reject_pending_actions("User rejected the action")
        conversation.run()


if __name__ == "__main__":
    main()
