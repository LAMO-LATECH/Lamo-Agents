// ============================================================
// ORCHESTRATOR
// Runs 3 agents. Routing and Demand run in parallel for speed.
// ============================================================
const { demandAgent } = require("./agents/demandAgent");
const { routingAgent } = require("./agents/routingAgent");
const { policyAndBalancingAgent } = require("./agents/policyAndBalancingAgent");

async function runLAMO({ from, to, userId, timestamp, hour, dayOfWeek } = {}) {
  const startTime = Date.now();
  console.log(`\n🚦 LAMO Pipeline: ${userId || "anon"} | ${from} → ${to}`);

  // Step 1: Routing first — Mapbox returns routes WITH congestion annotations
  console.log("[1/3] Routing Agent (Mapbox)...");
  const routing = await routingAgent({ from, to, congestionForecast: [] });
  console.log(`   ✓ ${routing.routes.length} routes found`);

  // Extract Mapbox congestion scores per route to pass to demand agent
  const mapboxScores = routing.routes.reduce((map, r) => {
    map[r.routeId] = r.congestionScore;
    return map;
  }, {});

  // Step 2: Demand agent uses Mapbox scores 
  console.log("[2/3] Demand Agent (events + congestion)...");
  const demand = await demandAgent({ timestamp, hour, dayOfWeek, mapboxScores });
  console.log(`   ✓ ${demand.summary}`);

  // Merge demand forecast back into routes for accurate status labels
  const routesWithDemand = routing.routes.map((route) => {
    const demandData = demand.forecast.find((f) => f.routeId === route.routeId);
    return {
      ...route,
      congestionScore: demandData?.congestionScore ?? route.congestionScore,
      congestionStatus: demandData?.status ?? route.congestionStatus,
    };
  });

  // Step 3: AI policy + load balancing
  console.log("[3/3] AI Policy + Load Balancing...");
  const policyBalance = await policyAndBalancingAgent({
    routes: routesWithDemand,
    hour: demand.context.hour,
    minute: demand.context.minute,
    activeEvents: demand.context.activeEvents,
    userId,
  });
  console.log(`   ✓ Recommended: ${policyBalance.recommendedRouteId}`);
  console.log(`   ✓ ${policyBalance.nudgeMessage}`);

  const elapsed = Date.now() - startTime;
  console.log(`✅ Done in ${elapsed}ms\n`);

  return {
    userId,
    request: { from, to },
    result: {
      routeOptions: policyBalance.routeOptions.map(({ _geometry, ...r }) => r),
      routeGeometries: routing.routes.map((r) => ({
        routeId: r.routeId,
        routeName: r.routeName,
        geometry: r._geometry || null,
      })),
      recommendedRouteId: policyBalance.recommendedRouteId,
      nudgeMessage: policyBalance.nudgeMessage,
      aiReasoning: policyBalance.aiReasoning,
      pointsReasoning: policyBalance.pointsReasoning,
      demandSummary: demand.summary,
      blockedRoutes: policyBalance.blockedRoutes,
      routeLoads: policyBalance.currentRouteLoads,
      dataSource: demand.dataSource,
      decisionSource: policyBalance.decisionSource,
    },
    meta: { pipelineMs: elapsed, timestamp: new Date().toISOString() },
  };
}

module.exports = { runLAMO };
