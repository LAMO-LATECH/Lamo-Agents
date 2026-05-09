require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { runLAMO } = require("./orchestrator");
const { resetLoad, confirmChoice } = require("./agents/policyAndBalancingAgent");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "LAMO Agents", timestamp: new Date().toISOString() });
});

app.post("/optimize", async (req, res) => {
  const { from, to, userId, timestamp } = req.body;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  try {
    const result = await runLAMO({ from, to, userId, timestamp });
    res.json(result);
  } catch (err) {
    console.error("Pipeline error:", err);
    res.status(500).json({ error: "Agent pipeline failed", details: err.message });
  }
});

app.post("/confirm-choice", (req, res) => {
  const { userId, chosenRouteId } = req.body;
  if (!userId || !chosenRouteId) return res.status(400).json({ error: "userId and chosenRouteId are required" });
  const result = confirmChoice(userId, chosenRouteId);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post("/simulate", async (req, res) => {
  const { userCount = 10, from = "Downtown LA", to = "Santa Monica", timestamp } = req.body;
  const simTimestamp = timestamp || new Date(new Date().setHours(17, 30, 0, 0)).toISOString();

  resetLoad();
  const results = [];

  for (let i = 1; i <= userCount; i++) {
    const result = await runLAMO({ from, to, userId: `user_${i}`, timestamp: simTimestamp });
    const recommended = result.result.routeOptions.find((r) => r.routeId === result.result.recommendedRouteId);
    results.push({
      userId: `user_${i}`,
      recommendedRoute: recommended?.routeName,
      estimatedDuration: recommended?.estimatedDuration,
      pointsEarned: recommended?.pointsEarned,
    });
    confirmChoice(`user_${i}`, result.result.recommendedRouteId);
  }

  const distribution = {};
  results.forEach((r) => {
    if (r.recommendedRoute) distribution[r.recommendedRoute] = (distribution[r.recommendedRoute] || 0) + 1;
  });

  res.json({
    totalUsers: userCount,
    simulatedAt: simTimestamp,
    routeDistribution: distribution,
    userResults: results,
  });
});

app.post("/reset", (req, res) => {
  resetLoad();
  res.json({ message: "Load state reset." });
});

app.listen(PORT, () => {
  console.log(`\n🚦 LAMO Agent Server running on http://localhost:${PORT}`);
  console.log(`   POST /optimize        — get all route options for a user`);
  console.log(`   POST /confirm-choice  — user picked a route, lock in points`);
  console.log(`   POST /simulate        — simulate N users`);
  console.log(`   POST /reset           — reset simulation state\n`);
});
