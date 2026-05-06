# LAMO — LA Mobility Optimizer (Agent Pipeline)

AI-powered traffic agent system that optimizes city-wide flow. Unlike Google Maps which optimizes for one user, LAMO distributes users across routes to reduce system-wide congestion — rewarding civic routing with points.

---

## How It Works

```
POST /optimize  { from, to, userId, timestamp }
        ↓
  orchestrator.js runs 3 agents:
        ↓
┌──────────────────────────────────────────────────┐
│ Agent 1: Demand Agent                            │
│  Primary:  TomTom Traffic API (live congestion)  │
│            Ticketmaster API (real LA events)      │
│  Fallback: Rush hour simulation                  │
├──────────────────────────────────────────────────┤
│ Agent 2: Routing Agent                           │
│  Primary:  Mapbox Geocoding (any address → GPS)  │
│            Mapbox Directions (real routes)        │
│  Fallback: Hardcoded LA routes                   │
├──────────────────────────────────────────────────┤
│ Agent 3: AI Policy + Load Balancing Agent        │
│  Primary:  LLM (OpenAI/Claude) reasons about:   │
│            - Which routes to restrict            │
│            - Which route reduces most congestion │
│            - How many points user earns          │
│  Fallback: V1 deterministic math (always works)  │
└──────────────────────────────────────────────────┘
        ↓
Response: routeOptions[], recommendation, nudgeMessage, aiReasoning
```

**Key difference from Google Maps:** LAMO tracks how many app users are on each road and factors that into routing decisions — preventing the "Waze problem" where everyone gets sent down the same shortcut.

---

## Setup

### 1. Clone and install
```bash
cd lamo-agents
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Edit `.env`:
```
OPENAI_API_KEY=sk-...
MAPBOX_ACCESS_TOKEN=pk.ey...
TICKETMASTER_API_KEY=...
TOMTOM_API_KEY=...
PORT=3001
```

**All keys are optional.** Missing keys fall back automatically:
- No `TOMTOM_API_KEY` → rush hour simulation
- No `MAPBOX_ACCESS_TOKEN` → hardcoded LA routes
- No `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` → V1 deterministic logic

### 3. Run tests
```bash
node test.js
```

### 4. Start server
```bash
npm start
# Server runs at http://localhost:3001
```

---

## API Reference

### `GET /health`
Verify server is running.

**Response:**
```json
{
  "status": "ok",
  "service": "LAMO Agents",
  "timestamp": "2026-04-29T17:30:00.000Z"
}
```

---

### `POST /optimize`
**Main endpoint.** Call this when a user enters an origin and destination.

**Request body:**
```json
{
  "from": "Downtown LA",
  "to": "Santa Monica",
  "userId": "user_123",
  "timestamp": "2026-04-29T17:30:00"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | string | ✅ | Any address — geocoded automatically |
| `to` | string | ✅ | Any address — geocoded automatically |
| `userId` | string | ✅ | User ID from your auth system |
| `timestamp` | ISO string | ❌ | Defaults to current server time |

**Response:**
```json
{
  "userId": "user_123",
  "request": { "from": "Downtown LA", "to": "Santa Monica" },
  "result": {
    "routeOptions": [
      {
        "routeId": "A",
        "routeName": "I-10 Freeway",
        "estimatedDuration": 61,
        "distanceMiles": 16,
        "congestionScore": 75,
        "congestionStatus": "HIGH",
        "appLoadPercent": 42,
        "timeDiffMinutes": 0,
        "congestionReduction": 0,
        "pointsEarned": 10,
        "tag": "FASTEST",
        "blocked": false,
        "penalized": false,
        "blockReason": null,
        "penalizedReason": null
      },
      {
        "routeId": "B",
        "routeName": "Olympic Blvd",
        "estimatedDuration": 65,
        "distanceMiles": 15,
        "congestionScore": 50,
        "congestionStatus": "MEDIUM",
        "appLoadPercent": 20,
        "timeDiffMinutes": 4,
        "congestionReduction": 28,
        "pointsEarned": 95,
        "tag": "RECOMMENDED",
        "blocked": false,
        "penalized": false,
        "blockReason": null,
        "penalizedReason": null
      },
      {
        "routeId": "C",
        "routeName": "Venice Blvd",
        "estimatedDuration": 55,
        "tag": "BLOCKED",
        "blocked": true,
        "blockReason": "Residential street restricted after 10pm",
        "pointsEarned": 0
      }
    ],
    "recommendedRouteId": "B",
    "nudgeMessage": "Take Olympic Blvd — 4 extra minutes, 28% less congestion, 95 LAMO points.",
    "aiReasoning": "Olympic Blvd has MEDIUM congestion vs I-10 HIGH, and only 20% app load vs 42%. Small time sacrifice meaningfully reduces congestion spread.",
    "pointsReasoning": "95 points for avoiding HIGH congestion and taking a less loaded route.",
    "demandSummary": "Evening Rush — heavy congestion on I-10 and I-405.",
    "blockedRoutes": ["Venice Blvd", "Pico Blvd"],
    "dataSource": "tomtom",
    "decisionSource": "openai"
  },
  "meta": {
    "pipelineMs": 843,
    "timestamp": "2026-04-29T17:30:01.000Z"
  }
}
```

**Route tags:**
| Tag | Meaning | Points |
|---|---|---|
| `FASTEST` | Shortest travel time | Minimum (10) |
| `RECOMMENDED` | AI-selected best civic choice | Full points |
| `ECO_FRIENDLY` | Lowest emissions | 50% of recommended |
| `ALTERNATIVE` | Valid option | 50% of recommended |
| `PENALIZED` | Soft restriction — discouraged | 50% of recommended |
| `BLOCKED` | City policy violation — unavailable | 0 |

**`decisionSource` values:**
| Value | Meaning |
|---|---|
| `openai` | OpenAI made the routing decision |
| `anthropic` | Claude made the routing decision |
| `v1-fallback` | No AI key — deterministic math used |

---

### `POST /confirm-choice`
Call this when the user taps a route in the UI. Returns points to save to your database.

**Request body:**
```json
{
  "userId": "user_123",
  "chosenRouteId": "B"
}
```

**Response:**
```json
{
  "userId": "user_123",
  "chosenRouteId": "B",
  "pointsEarned": 95,
  "message": "+95 LAMO points earned."
}
```

> ⚠️ Must call `/optimize` first for the same `userId`. Attempting to confirm without a pending optimize returns a 400 error.

---

### `POST /simulate`
Simulate N users for demo/testing. Defaults to evening rush if no timestamp given.

**Request body:**
```json
{
  "userCount": 100,
  "from": "Downtown LA",
  "to": "Santa Monica",
  "timestamp": "2026-04-29T17:30:00"
}
```

**Response:**
```json
{
  "totalUsers": 100,
  "simulatedAt": "2026-04-29T17:30:00.000Z",
  "routeDistribution": {
    "I-10 Freeway": 48,
    "I-405 Loop": 41,
    "Olympic Blvd": 11
  },
  "userResults": []
}
```

---

### `POST /reset`
Reset load tracker between simulations.

**Response:**
```json
{ "message": "Load state reset." }
```

---

## Integration Guide — Backend 

Your backend receives requests from the frontend and calls the LAMO agent server.

### Step 1 — When user requests a route
```js
async function getRouteOptions(userOrigin, userDestination, userId) {
  const response = await fetch("http://localhost:3001/optimize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: userOrigin,
      to: userDestination,
      userId: userId,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) throw new Error("LAMO agent error");
  const data = await response.json();
  return data.result; // send this to frontend
}
```

### Step 2 — When user picks a route
```js
async function confirmUserRoute(userId, chosenRouteId) {
  const response = await fetch("http://localhost:3001/confirm-choice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, chosenRouteId }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error);

  // Save data.pointsEarned to your database for this user
  await db.users.incrementPoints(userId, data.pointsEarned);
  return data.pointsEarned;
}
```

### On Deployment
Replace `localhost:3001` with the EC2 public IP where lamo-agents is deployed:
```js
const LAMO_URL = process.env.LAMO_URL || "http://localhost:3001";
```

---

## Integration Guide — Frontend 

You receive `data.result` from your backend. Here's what to render:

### Route List
```
nudgeMessage          → display above the route list
aiReasoning           → optional info tooltip ("Why this route?")

For each route in routeOptions[]:
  routeName           → card title
  estimatedDuration   → "61 min"
  timeDiffMinutes     → "+4 min" (show only if > 0)
  congestionStatus    → color badge: HIGH=red, MEDIUM=yellow, LOW=green
  congestionReduction → "28% less congestion" (show only if > 0)
  pointsEarned        → "🏆 95 pts" badge
  tag = RECOMMENDED   → highlight this card (border, star icon)
  tag = FASTEST       → show "⚡ Fastest" label
  tag = BLOCKED       → gray out, show blockReason, disable tap
  tag = PENALIZED     → show warning icon, show penalizedReason
  tag = ECO_FRIENDLY  → show "🌱" icon
```

### On User Tap
```
User taps a route card
  → send { userId, chosenRouteId } to your backend
  → backend calls /confirm-choice
  → backend saves pointsEarned to DB
  → show "+95 LAMO points earned!" confirmation to user
```

---

## Points System

Points reward congestion avoidance — not just travel time.

```
RECOMMENDED route → AI-assigned points (10–300)
Other routes      → 50% of recommended points  
BLOCKED routes    → 0 points

AI considers:
  - Congestion score difference vs fastest route
  - App load % (how overcrowded is this road through our app)
  - Time sacrifice made by the user
  - City policy alignment
```

---

## AI Decision vs V1 Fallback

The `policyAndBalancingAgent` has two modes:

**AI Mode** (when OpenAI or Anthropic key is present)
- LLM receives all route data, load stats, time, events, city goals
- LLM reasons about which routes to block, which to recommend, how many points to award
- Response includes `aiReasoning` and `pointsReasoning` explaining the decision
- `decisionSource` = `"openai"` or `"anthropic"`

**V1 Fallback** (no AI key, or if AI call fails)
- Deterministic math: load score + congestion score + policy rules
- Policy rules: residential blocked at night, school zones penalized, high emissions penalized
- Points: base 10 + time sacrifice × 8 + congestion reduction × 2
- `decisionSource` = `"v1-fallback"`
- System always works — AI just makes it smarter

---

## File Structure

```
lamo-agents/
├── agents/
│   ├── demandAgent.js              ← TomTom + Ticketmaster + fallback
│   ├── routingAgent.js             ← Mapbox geocoding + directions + fallback
│   └── policyAndBalancingAgent.js  ← AI primary + V1 math fallback
├── config/
│   ├── data.js                     ← simulation routes + events + rush hours
│   └── llmClient.js                ← OpenAI / Anthropic / mock switch
├── orchestrator.js                 ← runs 3 agents in sequence
├── server.js                       ← Express HTTP server
├── test.js                         ← test all agents
├── package.json
├── .env.example
└── README.md
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | No | OpenAI key — enables AI decisions |
| `ANTHROPIC_API_KEY` | No | Claude key — alternative to OpenAI |
| `MAPBOX_ACCESS_TOKEN` | No | Real routes + geocoding |
| `TICKETMASTER_API_KEY` | No | Real LA event data |
| `TOMTOM_API_KEY` | No | Live traffic congestion |
| `PORT` | No | Server port (default: 3001) |
