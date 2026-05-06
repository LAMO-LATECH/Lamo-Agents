require("dotenv").config();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;

let client = null;
let provider = "mock";

if (ANTHROPIC_KEY) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    provider = "anthropic";
  } catch {}
} else if (OPENAI_KEY) {
  try {
    const OpenAI = require("openai");
    client = new OpenAI({ apiKey: OPENAI_KEY });
    provider = "openai";
  } catch {}
}

console.log(`[LLM] Provider: ${provider}`);

async function callLLM(prompt, mockResponse) {
  try {
    if (provider === "anthropic") {
      const res = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      });
      return res.content[0].text.trim();
    }
    if (provider === "openai") {
      const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content.trim();
    }
  } catch (err) {
    console.warn("[LLM] API call failed, using mock:", err.message);
  }
  return mockResponse;
}

module.exports = { callLLM, provider };
