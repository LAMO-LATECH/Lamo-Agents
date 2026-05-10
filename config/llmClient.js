require("dotenv").config();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;

let client = null;
let provider = "mock";

if (ANTHROPIC_KEY) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    provider = "anthropic";
  } catch (err) {
    console.warn("[LLM] Anthropic SDK not found:", err.message);
  }
}

console.log(`[LLM] Provider: ${provider}`);

async function callLLM(prompt, mockResponse) {
  try {
    if (provider === "anthropic") {
      const res = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
      return res.content[0].text.trim();
    }
  } catch (err) {
    console.warn("[LLM] Anthropic call failed, using fallback:", err.message);
  }
  return mockResponse;
}

module.exports = { callLLM, provider };
