// ============================================================
// POLICY + LOAD BALANCING AGENT
// Primary:  LLM (OpenAI/Claude) reasons about policy + routing
// Fallback: V1 deterministic math — always works without AI key
// ============================================================
require("dotenv").config();
const { callLLM, provider } = require("../config/llmClient");

const routeLoad = {};
const pendingChoices = {};

// Road capacity scaled to real-world throughput per simulation window
const ROUTE_CAPACITY = {
  freeway:      2000,
  surface:       400,
  residential:   100,
};

// ── Helpers ────────────────────────────────────────────────

function initLoad(routes) {
  routes.forEach((r) => {
    if (routeLoad[r.routeId] === undefined) routeLoad[r.routeId] = 0;
  });
}

function getCapacity(route) {
  if (route.type === "freeway") return ROUTE_CAPACITY.freeway;
  if (route.throughResidential) return ROUTE_CAPACITY.residential;
  return ROUTE_CAPACITY.surface;
}

function getLoadPercent(route) {
  return Math.round(((routeLoad[route.routeId] || 0) / getCapacity(route)) * 100);
}

// ── V1 Fallback — Deterministic Logic ──────────────────────

function v1PolicyRules(routes, hour) {
  const isNight = hour >= 22 || hour < 6;
  const isSchool = (hour >= 7 && hour < 9) || (hour >= 14 && hour < 16);

  const blockedRouteIds = [];
  const blockedReasons = {};
  const penalizedRouteIds = [];
  const penalizedReasons = {};

  routes.forEach((r) => {
    if (r.throughResidential && isNight) {
      blockedRouteIds.push(r.routeId);
      blockedReasons[r.routeId] = "Residential street restricted after 10pm";
    } else if (r.throughResidential && isSchool) {
      penalizedRouteIds.push(r.routeId);
      penalizedReasons[r.routeId] = "School hours — residential streets deprioritized";
    } else if (r.emissionScore >= 8) {
      penalizedRouteIds.push(r.routeId);
      penalizedReasons[r.routeId] = "High emission route — cleaner alternatives preferred";
    }
  });

  return { blockedRouteIds, blockedReasons, penalizedRouteIds, penalizedReasons };
}

function v1BalanceScore(route) {
  const loadPct = getLoadPercent(route);
  const overloaded = loadPct >= 85;
  const loadPenalty = overloaded ? 999 : loadPct > 70 ? 60 : loadPct > 55 ? 35 : loadPct > 40 ? 15 : 0;
  const residentialPenalty = route.throughResidential ? 20 : 0;
  return loadPct * 0.7 + loadPenalty + residentialPenalty;
}

function v1Points(route, fastest) {
  if (!fastest || route.routeId === fastest.routeId) return 10;
  const timeDiff = (route.estimatedDuration || 0) - (fastest.estimatedDuration || 0);
  const congestionReduction = fastest.congestionScore > 0
    ? Math.max(0, fastest.congestionScore - route.congestionScore)
    : 0;
  return Math.min(Math.max(10 + timeDiff * 8 + congestionReduction * 2, 10), 300);
}

function runV1Fallback(routes, hour, userId) {
  const { blockedRouteIds, blockedReasons, penalizedRouteIds, penalizedReasons } = v1PolicyRules(routes, hour);

  const available = routes.filter((r) => !blockedRouteIds.includes(r.routeId));
  const pool = available.length > 0 ? available : routes;
  const fastest = [...routes].sort((a, b) => (a.estimatedDuration || 0) - (b.estimatedDuration || 0))[0];
  const recommended = [...pool].sort((a, b) => v1BalanceScore(a) - v1BalanceScore(b))[0];

  const timeDiff = recommended.estimatedDuration - fastest.estimatedDuration;
  const congestionReduction = fastest.congestionScore > 0
    ? Math.max(0, Math.round(((fastest.congestionScore - recommended.congestionScore) / fastest.congestionScore) * 100))
    : 0;
  const points = v1Points(recommended, fastest);

  const nudge = recommended.routeId === fastest.routeId
    ? `${recommended.routeName} is fastest and most balanced — earn ${points} LAMO points!`
    : `Take ${recommended.routeName} — ${timeDiff} extra minutes, ${congestionReduction}% less congestion, ${points} LAMO points.`;

  return {
    blockedRouteIds,
    blockedReasons,
    penalizedRouteIds,
    penalizedReasons,
    recommendedRouteId: recommended.routeId,
    reasoning: `V1 fallback: ${recommended.routeName} selected based on load (${getLoadPercent(recommended)}%) and congestion (${recommended.congestionScore}).`,
    pointsEarned: points,
    pointsReasoning: `${timeDiff} min sacrifice + ${congestionReduction}% congestion reduction = ${points} points.`,
    nudgeMessage: nudge,
  };
}

// ── AI Primary — LLM Reasoning ─────────────────────────────

function buildPrompt(routes, hour, minute, activeEvents, userId) {
  const timeStr = `${hour}:${String(minute).padStart(2, "0")}`;
  const isNight = hour >= 22 || hour < 6;
  const isSchool = (hour >= 7 && hour < 9) || (hour >= 14 && hour < 16);

  const routeSummaries = routes.map((r) =>
`- ${r.routeName} (ID:${r.routeId}): ${r.estimatedDuration}min, congestion ${r.congestionStatus}(${r.congestionScore}/100), residential=${r.throughResidential}, type=${r.type}, emissions=${r.emissionScore}/10`
  ).join("\n");

  return `You are an AI traffic agent for the LA Mobility Optimizer.

Time: ${timeStr}
${isNight ? "⚠️ Nighttime — after 10pm or before 6am." : ""}
${isSchool ? "⚠️ School pickup/dropoff hours active." : ""}
${activeEvents.length ? `Active events: ${activeEvents.join(", ")}.` : "No major events."}

Routes available:
${routeSummaries}

City goals (priority order):
1. Reduce city congestion — avoid routing users onto HIGH congestion roads
2. Protect residential neighborhoods — restrict at night and school hours
3. Reduce emissions — deprioritize high-emission routes when alternatives exist
4. Balance app load — don't overcrowd any single road through our app
5. Minimize user time sacrifice — keep extra time under 15 minutes

Tasks:
1. Identify BLOCKED routes (hard restriction) and PENALIZED routes (soft)
2. Pick the best route for user ${userId} — prioritize congestion avoidance over speed
3. Assign civic points (10-300) based on how much their choice helps the city

Respond ONLY in this exact JSON format with no markdown:
{
  "blockedRouteIds": [],
  "blockedReasons": {},
  "penalizedRouteIds": [],
  "penalizedReasons": {},
  "recommendedRouteId": "B",
  "reasoning": "explain why this route was chosen",
  "pointsEarned": 85,
  "pointsReasoning": "explain points calculation",
  "nudgeMessage": "friendly 1-sentence message for the user"
}`;
}

async function runAIDecision(routes, hour, minute, activeEvents, userId) {
  const prompt = buildPrompt(routes, hour, minute, activeEvents, userId);

  // Pass empty string as mock — if callLLM returns empty, we catch it below
  const raw = await callLLM(prompt, "");
  if (!raw || raw.trim() === "") throw new Error("Empty LLM response");

  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  // Validate required fields exist
  if (!parsed.recommendedRouteId) throw new Error("Missing recommendedRouteId in AI response");

  return parsed;
}

// ── Main Agent ─────────────────────────────────────────────

async function policyAndBalancingAgent({ routes, hour, minute, activeEvents = [], userId = "user" }) {
  initLoad(routes);

  let decision;
  let decisionSource;

  if (provider !== "mock") {
    try {
      console.log("[PolicyBalancing] Calling AI for routing decision...");
      decision = await runAIDecision(routes, hour, minute, activeEvents, userId);
      decisionSource = provider; // "openai" or "anthropic"
      console.log("[PolicyBalancing] AI decision received.");
    } catch (err) {
      console.warn("[PolicyBalancing] AI failed, using V1 fallback:", err.message);
      decision = runV1Fallback(routes, hour, userId);
      decisionSource = "v1-fallback";
    }
  } else {
    console.log("[PolicyBalancing] No AI key — using V1 deterministic fallback.");
    decision = runV1Fallback(routes, hour, userId);
    decisionSource = "v1-fallback";
  }

  // ── Build route options for frontend ─────────────────────
  const blockedSet = new Set(decision.blockedRouteIds || []);
  const penalizedSet = new Set(decision.penalizedRouteIds || []);
  const fastest = [...routes].sort((a, b) => (a.estimatedDuration || 0) - (b.estimatedDuration || 0))[0];

  const routeOptions = [...routes]
    .sort((a, b) => (a.estimatedDuration || 0) - (b.estimatedDuration || 0))
    .map((route) => {
      const isBlocked = blockedSet.has(route.routeId);
      const isPenalized = penalizedSet.has(route.routeId);
      const isRecommended = route.routeId === decision.recommendedRouteId;
      const isFastest = route.routeId === fastest?.routeId;

      let tag = "ALTERNATIVE";
      if (isBlocked) tag = "BLOCKED";
      else if (isRecommended && isFastest) tag = "FASTEST";
      else if (isRecommended) tag = "RECOMMENDED";
      else if (isFastest) tag = "FASTEST";
      else if ((route.emissionScore || 5) <= 4) tag = "ECO_FRIENDLY";
      else if (isPenalized) tag = "PENALIZED";

      const timeDiff = (route.estimatedDuration || 0) - (fastest?.estimatedDuration || 0);
      const congestionReduction = (fastest?.congestionScore || 0) > 0
        ? Math.max(0, Math.round(((fastest.congestionScore - route.congestionScore) / fastest.congestionScore) * 100))
        : 0;

      const points = isBlocked ? 0
        : isRecommended ? decision.pointsEarned
        : Math.max(10, Math.round(decision.pointsEarned * 0.5));

      return {
        routeId:            route.routeId,
        routeName:          route.routeName,
        estimatedDuration:  route.estimatedDuration,
        distanceMiles:      route.distance || 0,
        congestionScore:    route.congestionScore || 0,
        congestionStatus:   route.congestionStatus || "UNKNOWN",
        appLoadPercent:     getLoadPercent(route),
        timeDiffMinutes:    timeDiff,
        congestionReduction,
        pointsEarned:       points,
        tag,
        blocked:            isBlocked,
        penalized:          isPenalized,
        blockReason:        decision.blockedReasons?.[route.routeId] || null,
        penalizedReason:    decision.penalizedReasons?.[route.routeId] || null,
      };
    });

  // Store pending choices — load only increments on confirm
  pendingChoices[userId] = routeOptions.reduce((map, r) => {
    map[r.routeId] = r.pointsEarned;
    return map;
  }, {});

  return {
    agent: "PolicyAndBalancingAgent",
    decisionSource,
    userId,
    routeOptions,
    recommendedRouteId: decision.recommendedRouteId,
    nudgeMessage: decision.nudgeMessage,
    aiReasoning: decision.reasoning,
    pointsReasoning: decision.pointsReasoning,
    blockedRoutes: [...blockedSet].map((id) => routes.find((r) => r.routeId === id)?.routeName || id),
    currentRouteLoads: routes.map((r) => ({
      routeId: r.routeId,
      routeName: r.routeName,
      usersAssigned: routeLoad[r.routeId] || 0,
      capacity: getCapacity(r),
      appLoadPercent: getLoadPercent(r),
    })),
  };
}

// ── Confirm Choice ─────────────────────────────────────────

function confirmChoice(userId, chosenRouteId) {
  const pending = pendingChoices[userId];
  if (!pending) return { error: "No pending offer. Call /optimize first." };
  const points = pending[chosenRouteId];
  if (points === undefined) return { error: `Route ${chosenRouteId} not in offered options.` };
  routeLoad[chosenRouteId] = (routeLoad[chosenRouteId] || 0) + 1;
  delete pendingChoices[userId];
  return { userId, chosenRouteId, pointsEarned: points, message: `+${points} LAMO points earned.` };
}

function resetLoad() {
  Object.keys(routeLoad).forEach((k) => delete routeLoad[k]);
  Object.keys(pendingChoices).forEach((k) => delete pendingChoices[k]);
}

module.exports = { policyAndBalancingAgent, confirmChoice, resetLoad };
