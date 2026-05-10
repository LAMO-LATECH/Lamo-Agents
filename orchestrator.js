const { demandAgent } = require("./agents/demandAgent");
const { routingAgent } = require("./agents/routingAgent");
const { policyAndBalancingAgent } = require("./agents/policyAndBalancingAgent");

async function runLAMO({ from, to, userId, timestamp, hour, dayOfWeek } = {}) {
  const startTime = Date.now();
  console.log(`\n🚦 LAMO Pipeline: ${userId || "anon"} | ${from} → ${to}`);

  // Step 1: Demand Agent — real congestion via TomTom + events via Ticketmaster
  console.log("[1/3] Demand Agent...");
  const demand = await demandAgent({ timestamp, hour, dayOfWeek });
  console.log(`   ✓ ${demand.summary}`);

  // Step 2: Routing Agent — real routes via Mapbox + geocoding any address
  console.log("[2/3] Routing Agent...");
  const routing = await routingAgent({ from, to, congestionForecast: demand.forecast });
  console.log(`   ✓ ${routing.routes.length} routes found`);

  // Step 3: AI Policy + Load Balancing — LLM reasons about restrictions + best route + points
  console.log("[3/3] AI Policy + Load Balancing...");
  const policyBalance = await policyAndBalancingAgent({
    routes: routing.routes,
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
      aiReasoning: policyBalance.aiReasoning,         // why AI picked this route
      pointsReasoning: policyBalance.pointsReasoning, // why AI gave these points
      demandSummary: demand.summary,
      blockedRoutes: policyBalance.blockedRoutes,
      routeLoads: policyBalance.currentRouteLoads,
      dataSource: demand.dataSource,
    },
    meta: { pipelineMs: elapsed, timestamp: new Date().toISOString() },
  };
}

module.exports = { runLAMO };
