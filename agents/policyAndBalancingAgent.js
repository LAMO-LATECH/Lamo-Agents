require("dotenv").config();
const { callLLM, provider } = require("../config/llmClient");

const routeLoad = {};
const pendingChoices = {};

const ROUTE_CAPACITY = {
  freeway:      2000,
  surface:       400,
  residential:   100,
};

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

// ── V1 Fallback ────────────────────────────────────────────

function v1PolicyRules(routes, hour) {
  const isNight = hour >= 22 || hour < 6;
  const isSchool = (hour >= 7 && hour < 9) || (hour >= 14 && hour < 16);
  const blockedRouteIds = [], blockedReasons = {}, penalizedRouteIds = [], penalizedReasons = {};

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
  const congestionReduction = Math.max(0, (fastest.congestionScore || 0) - (route.congestionScore || 0));
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
    blockedRouteIds, blockedReasons, penalizedRouteIds, penalizedReasons,
    recommendedRouteId: recommended.routeId,
    reasoning: `${recommended.routeName} selected — lower congestion and available capacity.`,
    pointsEarned: points,
    pointsReasoning: `${points} points for civic routing choice.`,
    nudgeMessage: nudge,
  };
}

// ── AI Primary — Short Prompt for Speed ───────────────────

function buildPrompt(routes, hour, minute, activeEvents, userId) {
  const timeStr = `${hour}:${String(minute).padStart(2, "0")}`;
  const isNight = hour >= 22 || hour < 6;
  const isSchool = (hour >= 7 && hour < 9) || (hour >= 14 && hour < 16);

  // Keep route summary short — only what AI needs to decide
  const routeSummaries = routes.map((r) =>
    `${r.routeId}: ${r.routeName}, ${r.estimatedDuration}min, ${r.congestionStatus}(${r.congestionScore}), residential=${r.throughResidential}, emissions=${r.emissionScore}`
  ).join("\n");

  return `LA traffic AI. Time:${timeStr}. ${isNight ? "NIGHTTIME." : ""}${isSchool ? "SCHOOL HOURS." : ""}${activeEvents.length ? " Events:" + activeEvents.slice(0, 2).join(",") + "." : ""}

Routes:
${routeSummaries}

Goals: reduce congestion, protect residential at night/school hours, low emissions preferred.

Respond in JSON only, no markdown. Keep reasoning and pointsReasoning under 15 words each:
{"blockedRouteIds":[],"blockedReasons":{},"penalizedRouteIds":[],"penalizedReasons":{},"recommendedRouteId":"","reasoning":"","pointsEarned":0,"pointsReasoning":"","nudgeMessage":""}`;
}

async function runAIDecision(routes, hour, minute, activeEvents, userId) {
  const prompt = buildPrompt(routes, hour, minute, activeEvents, userId);
  const raw = await callLLM(prompt, "");
  if (!raw || raw.trim() === "") throw new Error("Empty LLM response");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.recommendedRouteId) throw new Error("Missing recommendedRouteId");
  return parsed;
}

// ── Main Agent ─────────────────────────────────────────────

async function policyAndBalancingAgent({ routes, hour, minute, activeEvents = [], userId = "user" }) {
  initLoad(routes);

  let decision, decisionSource;

  if (provider !== "mock") {
    try {
      console.log("[PolicyBalancing] Calling AI for routing decision...");
      decision = await runAIDecision(routes, hour, minute, activeEvents, userId);
      decisionSource = provider;
      console.log("[PolicyBalancing] AI decision received.");
    } catch (err) {
      console.warn("[PolicyBalancing] AI failed, using V1 fallback:", err.message);
      decision = runV1Fallback(routes, hour, userId);
      decisionSource = "v1-fallback";
    }
  } else {
    console.log("[PolicyBalancing] No AI key — using V1 fallback.");
    decision = runV1Fallback(routes, hour, userId);
    decisionSource = "v1-fallback";
  }

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
        routeId:           route.routeId,
        routeName:         route.routeName,
        estimatedDuration: route.estimatedDuration,
        distanceMiles:     route.distance || 0,
        congestionScore:   route.congestionScore || 0,
        congestionStatus:  route.congestionStatus || "UNKNOWN",
        timeDiffMinutes:   timeDiff,
        congestionReduction,
        pointsEarned:      points,
        tag,
        blocked:           isBlocked,
        penalized:         isPenalized,
        blockReason:       decision.blockedReasons?.[route.routeId] || null,
        penalizedReason:   decision.penalizedReasons?.[route.routeId] || null,
      };
    });

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