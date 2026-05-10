const { demandAgent } = require("./agents/demandAgent");
const { routingAgent } = require("./agents/routingAgent");
const { policyAndBalancingAgent } = require("./agents/policyAndBalancingAgent");

async function runLAMO({ from, to, userId, timestamp, hour, dayOfWeek } = {}) {
  const startTime = Date.now();
  console.log(`\n🚦 LAMO Pipeline: ${userId || "anon"} | ${from} → ${to}`);

  // Step 1: Routing — Mapbox returns routes with live congestion annotations
  const t1 = Date.now();
  console.log("[1/3] Routing Agent (Mapbox)...");
  const routing = await routingAgent({ from, to, congestionForecast: [] });
  console.log(`   ✓ ${routing.routes.length} routes found (${Date.now() - t1}ms)`);

  const mapboxScores = routing.routes.reduce((map, r) => {
    map[r.routeId] = r.congestionScore;
    return map;
  }, {});

  // Step 2: Demand — events + congestion from Mapbox scores
  const t2 = Date.now();
  console.log("[2/3] Demand Agent (events + congestion)...");
  const demand = await demandAgent({ timestamp, hour, dayOfWeek, mapboxScores });
  console.log(`   ✓ ${demand.summary} (${Date.now() - t2}ms)`);

  const routesWithDemand = routing.routes.map((route) => {
    const demandData = demand.forecast.find((f) => f.routeId === route.routeId);
    return {
      ...route,
      congestionScore: demandData?.congestionScore ?? route.congestionScore,
      congestionStatus: demandData?.status ?? route.congestionStatus,
    };
  });

  // Step 3: AI policy + load balancing
  const t3 = Date.now();
  console.log("[3/3] AI Policy + Load Balancing...");
  const policyBalance = await policyAndBalancingAgent({
    routes: routesWithDemand,
    hour: demand.context.hour,
    minute: demand.context.minute,
    activeEvents: demand.context.activeEvents,
    userId,
  });
  console.log(`   ✓ Recommended: ${policyBalance.recommendedRouteId} (${Date.now() - t3}ms)`);

  const elapsed = Date.now() - startTime;
  console.log(`✅ Total: ${elapsed}ms\n`);

  return {
    userId,
    request: { from, to },
    result: {
      // appLoadPercent hidden from output — uncomment routeLoads below when app has real users
      routeOptions: policyBalance.routeOptions.map(({ _geometry, appLoadPercent, ...r }) => r),
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
      // routeLoads: policyBalance.currentRouteLoads, // uncomment when app has real users
      dataSource: demand.dataSource,
      decisionSource: policyBalance.decisionSource,
    },
    meta: { pipelineMs: elapsed, timestamp: new Date().toISOString() },
  };
}

module.exports = { runLAMO };