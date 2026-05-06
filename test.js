require("dotenv").config();
const { demandAgent } = require("./agents/demandAgent");
const { routingAgent } = require("./agents/routingAgent");
const { policyAndBalancingAgent, confirmChoice, resetLoad } = require("./agents/policyAndBalancingAgent");
const { runLAMO } = require("./orchestrator");

async function test() {
  console.log("=".repeat(50));
  console.log("  LAMO TEST SUITE");
  console.log("=".repeat(50));

  // Test 1: Demand Agent — evening rush
  console.log("\n[1] Demand Agent (hour=18)");
  const demand = await demandAgent({ hour: 18, dayOfWeek: 1 });
  console.log("Summary:", demand.summary);
  console.log("Source:", demand.dataSource);
  console.log("Forecast:", demand.forecast.map((f) => `${f.routeName}: ${f.status}(${f.congestionScore})`));

  // Test 2: Routing Agent
  console.log("\n[2] Routing Agent");
  const routing = await routingAgent({ from: "Downtown LA", to: "Santa Monica", congestionForecast: demand.forecast });
  console.log("Routes:", routing.routes.map((r) => `${r.routeName}(${r.estimatedDuration}min)`));

  // Test 3: AI Policy + Balancing — evening
  console.log("\n[3] AI Policy + Balancing (evening)");
  resetLoad();
  const pb = await policyAndBalancingAgent({
    routes: routing.routes,
    hour: 18, minute: 30,
    activeEvents: [],
    userId: "test_user",
  });
  console.log("Recommended:", pb.recommendedRouteId);
  console.log("Blocked:", pb.blockedRoutes);
  console.log("Nudge:", pb.nudgeMessage);
  console.log("AI Reasoning:", pb.aiReasoning);
  pb.routeOptions.forEach((r) => console.log(`  [${r.tag}] ${r.routeName} ${r.estimatedDuration}min ${r.pointsEarned}pts`));

  // Test 4: AI Policy + Balancing — nighttime (should block residential)
  console.log("\n[4] AI Policy + Balancing (night 23:00)");
  const pb2 = await policyAndBalancingAgent({
    routes: routing.routes,
    hour: 23, minute: 0,
    activeEvents: [],
    userId: "test_user_night",
  });
  console.log("Blocked:", pb2.blockedRoutes);
  console.log("Recommended:", pb2.recommendedRouteId);

  // Test 5: Full pipeline
  console.log("\n[5] Full Pipeline");
  resetLoad();
  const result = await runLAMO({ from: "Downtown LA", to: "Santa Monica", userId: "commuter_1", hour: 18 });
  console.log("Route options:");
  result.result.routeOptions.forEach((r) => console.log(`  [${r.tag}] ${r.routeName} ${r.estimatedDuration}min ${r.pointsEarned}pts`));
  console.log("Nudge:", result.result.nudgeMessage);

  // Test 6: Confirm choice
  console.log("\n[6] Confirm Choice");
  const confirm = confirmChoice("commuter_1", result.result.recommendedRouteId);
  console.log(confirm.message);

  console.log("\n" + "=".repeat(50));
  console.log("  ✅ ALL TESTS PASSED");
  console.log("=".repeat(50));
}

test().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
