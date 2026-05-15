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
        system: `You are an agent that balances out congestion in locations based on traffic and multiple routes. Your job is to predict and recommend the route to a user that reduces overall traffic in the specific area. IMPORTANT RULES:
- NEVER recommend the fastest route. The fastest route is shown to the user for reference only.
- Always recommend an alternate route that reduces congestion compared to the fastest route.
- The fastest route earns 0 points. Only alternate routes earn points.
- If all alternates are blocked, recommend the least congested available route.
- Respond in valid JSON only, no markdown, no asterisks, no bold text.`,
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
