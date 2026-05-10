# LAMO — LA Mobility Optimizer (Agent Pipeline)

This is the AI agent service for the LAMO project. It is a standalone server that receives a user's origin and destination, runs it through 3 AI agents, and returns route options with congestion data, recommendations, and points.

You do not need to understand the internal code to use this. Just call the API endpoints described below.

---

## What This Service Does 

When a user wants to go from point A to point B, this service:

1. Finds all real driving routes using Mapbox
2. Checks live traffic congestion on each route (from Mapbox)
3. Checks if any events are happening nearby (Ticketmaster, Eventbrite, SeatGeek, PredictHQ)
4. Applies city rules — blocks residential streets at night, penalizes high-emission routes
5. Uses AI (Claude) to decide which route is best for the city, not just the user
6. Returns all routes with travel times, congestion levels, and points the user earns for picking the civic route

**The key difference from Google Maps:** this system tracks how many app users are already on each road and avoids sending everyone down the same route. Users earn points for taking a slightly longer but less congested route.

---

## Setup (One Time)

```bash
cd lamo-agents
npm install
cp .env.example .env
```

Add your keys to `.env`:
```
ANTHROPIC_API_KEY=        ← AI decisions (optional, falls back to math)
MAPBOX_ACCESS_TOKEN=      ← routes + live traffic (recommended)
TICKETMASTER_API_KEY=     ← event data (optional)
EVENTBRITE_API_KEY=       ← event data (optional)
PREDICTHQ_API_KEY=        ← event data (optional)
SEATGEEK_CLIENT_ID=       ← event data (optional)
PORT=3001
```

All keys are optional. Missing keys fall back automatically — the service always works.

Start the server:
```bash
npm start
```

Server runs at `http://localhost:3001`

---

## API Endpoints

### GET /health
Check if the server is running.

**Response:**
```json
{ "status": "ok", "service": "LAMO Agents" }
```

---

### POST /optimize
**The main endpoint.** Call this when a user enters an origin and destination.

**Input:**
```json
{
  "from": "LAX Airport",
  "to": "Dodger Stadium",
  "userId": "user_123",
  "timestamp": "2026-04-29T17:30:00"
}
```

| Field | Required | Description |
|---|---|---|
| `from` | Yes | Any address or landmark in LA |
| `to` | Yes | Any address or landmark in LA |
| `userId` | Yes | The logged-in user's ID from your auth system |
| `timestamp` | No | ISO date string. Defaults to current time if not sent |

**Output:**
```json
{
  "result": {
    "routeOptions": [
      {
        "routeId": "A",
        "routeName": "I-10 Freeway",
        "estimatedDuration": 61,
        "distanceMiles": 16,
        "congestionStatus": "HIGH",
        "congestionScore": 75,
        "timeDiffMinutes": 0,
        "congestionReduction": 0,
        "pointsEarned": 10,
        "tag": "FASTEST",
        "blocked": false,
        "blockReason": null
      },
      {
        "routeId": "B",
        "routeName": "Olympic Blvd",
        "estimatedDuration": 65,
        "distanceMiles": 15,
        "congestionStatus": "MEDIUM",
        "congestionScore": 50,
        "timeDiffMinutes": 4,
        "congestionReduction": 28,
        "pointsEarned": 95,
        "tag": "RECOMMENDED",
        "blocked": false,
        "blockReason": null
      },
      {
        "routeId": "C",
        "routeName": "Venice Blvd",
        "estimatedDuration": 55,
        "congestionStatus": "LOW",
        "tag": "BLOCKED",
        "blocked": true,
        "blockReason": "Residential street restricted after 10pm",
        "pointsEarned": 0
      }
    ],
    "recommendedRouteId": "B",
    "nudgeMessage": "Take Olympic Blvd — 4 extra minutes, 28% less congestion, 95 LAMO points.",
    "aiReasoning": "Olympic Blvd has MEDIUM vs HIGH congestion and lower app load. Small sacrifice meaningfully reduces city congestion.",
    "demandSummary": "Evening Rush in effect — heavy congestion on I-10.",
    "blockedRoutes": ["Venice Blvd"],
    "routeGeometries": [
      {
        "routeId": "A",
        "routeName": "I-10 Freeway",
        "geometry": { "type": "LineString", "coordinates": [[...]] }
      }
    ],
    "dataSource": "mapbox",
    "decisionSource": "anthropic"
  }
}
```

**What each field means:**

| Field | What it is |
|---|---|
| `routeOptions` | All available routes — render these as cards in the UI |
| `recommendedRouteId` | Which route the AI recommends — highlight this card |
| `nudgeMessage` | One sentence to show above the route list |
| `aiReasoning` | Why the AI picked that route — optional tooltip |
| `demandSummary` | Current traffic situation in plain English |
| `blockedRoutes` | Routes removed by city policy — names only |
| `routeGeometries` | GPS coordinates to draw route lines on a Mapbox map |
| `dataSource` | `"mapbox"` if real data, `"simulation"` if fallback |
| `decisionSource` | `"anthropic"` if AI decided, `"v1-fallback"` if math |

**Route tags:**

| Tag | Meaning | What to show |
|---|---|---|
| `FASTEST` | Shortest travel time | ⚡ Fastest label |
| `RECOMMENDED` | AI-selected best civic choice | Highlighted card |
| `ECO_FRIENDLY` | Lowest emissions | 🌱 icon |
| `ALTERNATIVE` | Valid option | Normal card |
| `PENALIZED` | Soft restriction | ⚠️ warning |
| `BLOCKED` | City policy — unavailable | Grayed out, disabled |

---

### POST /confirm-choice
Call this when the user taps a route card. Returns points earned.

**Input:**
```json
{
  "userId": "user_123",
  "chosenRouteId": "B"
}
```

**Output:**
```json
{
  "userId": "user_123",
  "chosenRouteId": "B",
  "pointsEarned": 95,
  "message": "+95 LAMO points earned."
}
```

Save `pointsEarned` to your database for this user.

> Note: `/confirm-choice` must be called after `/optimize` for the same userId. If called without a prior optimize, returns a 400 error.

---

### POST /simulate
Simulate multiple users for demo and testing purposes.

**Input:**
```json
{
  "userCount": 100,
  "from": "Downtown LA",
  "to": "Santa Monica",
  "timestamp": "2026-04-29T17:30:00"
}
```

**Output:**
```json
{
  "totalUsers": 100,
  "simulatedAt": "2026-04-29T17:30:00.000Z",
  "routeDistribution": {
    "I-10 Freeway": 48,
    "I-405 Loop": 41,
    "Olympic Blvd": 11
  },
  "userResults": [...]
}
```

---

### POST /reset
Resets the load tracker. Use between simulations.

**Output:**
```json
{ "message": "Load state reset." }
```

---

## Backend 


**Step 1 — When user requests a route:**
```js
const response = await fetch("http://localhost:3001/optimize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    from: req.body.from,           // from user input
    to: req.body.to,               // from user input
    userId: req.user.id,           // from your auth system
    timestamp: new Date().toISOString(),
  }),
});
const data = await response.json();
return res.json(data.result);     // send result to frontend
```

**Step 2 — When user picks a route:**
```js
const confirm = await fetch("http://localhost:3001/confirm-choice", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId: req.user.id,
    chosenRouteId: req.body.routeId,  // which route user tapped
  }),
});
const { pointsEarned } = await confirm.json();
await db.users.addPoints(req.user.id, pointsEarned);  // save to your DB
```

**On deployment:** Replace `localhost:3001` with the EC2 URL where this service is hosted.

---

##  Frontend 

Receive `data.result` from the backend. what to render:

```
Show nudgeMessage above the route list

For each route in routeOptions[]:
  Show routeName as the card title
  Show estimatedDuration — e.g. "61 min"
  If timeDiffMinutes > 0 — show "+4 min vs fastest"
  Show congestionStatus as a color badge:
    HIGH   → red
    MEDIUM → yellow
    LOW    → green
  If congestionReduction > 0 — show "28% less congestion"
  Show pointsEarned as a badge — e.g. "🏆 95 pts"
  Use tag to style the card:
    RECOMMENDED → highlighted border or star
    FASTEST     → lightning bolt icon
    ECO_FRIENDLY → green leaf icon
    BLOCKED     → grayed out, not tappable, show blockReason
    PENALIZED   → warning icon, show penalizedReason

Highlight the card where routeId === recommendedRouteId

When user taps a card:
  Send { userId, chosenRouteId } to your backend
  Backend calls /confirm-choice
  Show the returned pointsEarned as a toast/animation
```

**For drawing routes on a map (optional):**
Use `routeGeometries[]` — each item has a `geometry` object (GeoJSON LineString) you can pass directly to Mapbox GL JS `addSource` to draw the route line on the map.

---

## How Everything Connects

```
User types origin + destination in the app
              ↓
         Frontend
              ↓  sends { from, to, userId }
         Backend (your teammate)
              ↓  POST /optimize
     LAMO Agent Server (this code)
              ↓  calls internally:
         Mapbox API → real routes + live traffic
         Event APIs → Ticketmaster, Eventbrite etc
         Claude AI  → policy + recommendation + points
              ↓  returns routeOptions[], nudgeMessage, routeGeometries
         Backend
              ↓  passes result to frontend
         Frontend renders route cards
              ↓
         User picks a route
              ↓
         Frontend → Backend → POST /confirm-choice
              ↓
         Backend saves pointsEarned to database
              ↓
         User sees their points update
```

---

## File Structure

```
lamo-agents/
├── agents/
│   ├── demandAgent.js              ← events + congestion scoring
│   ├── routingAgent.js             ← Mapbox geocoding + directions
│   └── policyAndBalancingAgent.js  ← AI decisions + load balancing + points
├── config/
│   ├── data.js                     ← simulation fallback data
│   └── llmClient.js                ← Anthropic Claude connection
├── orchestrator.js                 ← runs 3 agents in sequence
├── server.js                       ← HTTP API server
├── test.js                         ← run all agent tests
├── package.json
└── .env.example
```
