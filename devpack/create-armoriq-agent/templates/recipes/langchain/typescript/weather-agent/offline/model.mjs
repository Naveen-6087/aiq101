// Offline stand-in for @langchain/google-genai: a scripted tool calling chat model. It plays the
// part Gemini plays in the live run and makes the same two sequential tool calls:
//   1. weather__search_location for the place in the question
//   2. weather__get_current_conditions for the coordinates that came back
// then answers in a sentence. It is a real LangChain chat model, so createAgent, the tool node,
// and the ArmorIQLangChain handleLLMEnd / handleToolStart callbacks all run for real.

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

const text = (message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content));

function script(messages) {
  const last = messages.at(-1);
  const kind = last.getType();

  if (kind === 'tool') {
    const failed = last.status === 'error' || /ArmorIQ|Error/i.test(text(last));
    if (failed) return { content: `I could not finish that lookup: ${text(last).slice(0, 160)}` };

    if (last.name === 'weather__search_location') {
      const place = text(last).match(/"name":"([^"]+)".*?"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)/);
      if (!place) return { content: 'I could not find that place.' };
      return {
        content: '',
        tool_calls: [{ id: 'call_conditions', name: 'weather__get_current_conditions', args: { latitude: Number(place[2]), longitude: Number(place[3]) } }],
      };
    }

    const c = JSON.parse(text(last));
    return { content: `It is ${c.summary.toLowerCase()} at ${c.temperature_c} C, with ${c.humidity_percent}% humidity and wind at ${c.wind_kph} km/h.` };
  }

  const question = text(messages.findLast((m) => m.getType() === 'human'));
  const place = question.match(/\bin ([A-Z][\w ,]*?)(?: right now)?\??$/)?.[1] ?? 'Bengaluru, India';
  return { content: '', tool_calls: [{ id: 'call_search', name: 'weather__search_location', args: { query: place } }] };
}

export class ChatGoogleGenerativeAI extends BaseChatModel {
  _llmType() {
    return 'offline-scripted';
  }

  bindTools() {
    return this;
  }

  async _generate(messages) {
    const message = new AIMessage(script(messages));
    return { generations: [{ text: text(message), message }] };
  }
}
