require("dotenv").config();
const { callLLM } = require("../config/llmClient");
const { ROUTES, RUSH_HOURS } = require("../config/data");
const axios = require("axios");

const TOMTOM_KEY = process.env.TOMTOM_API_KEY || null;
const TM_KEY = process.env.TICKETMASTER_API_KEY || null;

// LA bounding box for Ticketmaster event search
const LA_LATLONG = "34.0522,-118.2437";

function parseTime(input) {
  if (!input) {
    const n = new Date();
    return { hour: n.getHours(), minute: n.getMinutes(), dayOfWeek: n.getDay(), date: n };
  }
  if (typeof input === "string" && input.includes("T")) {
    const d = new Date(input);
    return { hour: d.getHours(), minute: d.getMinutes(), dayOfWeek: d.getDay(), date: d };
  }
  const n = new Date();
  return { hour: Number(input), minute: 0, dayOfWeek: n.getDay(), date: n };
}

function isRushHour(hour, minute) {
  const frac = hour + minute / 60;
  return RUSH_HOURS.find((rh) => frac >= rh.start && frac < rh.end) || null;
}

// ── Event Sources ─────────────────────────────────────────
// Multiple sources run in parallel — add API keys to .env to activate each

async function fetchTicketmaster(startDateTime, endDateTime) {
  if (!TM_KEY) return [];
  try {
    const res = await axios.get("https://app.ticketmaster.com/discovery/v2/events.json", {
      params: { apikey: TM_KEY, latlong: LA_LATLONG, radius: 20, unit: "miles", startDateTime, endDateTime, size: 5 },
    });
    return (res.data?._embedded?.events || []).map((e) => ({ name: e.name, source: "ticketmaster", impactZones: ["A", "B"] }));
  } catch (err) {
    console.warn("[DemandAgent] Ticketmaster failed:", err.message);
    return [];
  }
}

// PredictHQ — covers sports, concerts, community, expos, conferences
// Free tier at predicthq.com
async function fetchPredictHQ(startDateTime) {
  const key = process.env.PREDICTHQ_API_KEY || null;
  if (!key) return [];
  try {
    const res = await axios.get("https://api.predicthq.com/v1/events/", {
      headers: { Authorization: `Bearer ${key}` },
      params: { location_around: "34.0522,-118.2437", location_around_radius: "20mi", start_gte: startDateTime, limit: 5, country: "US", category: "concerts,sports,community,expos,conferences" },
    });
    return (res.data?.results || []).map((e) => ({ name: e.title, source: "predicthq", impactZones: ["A", "B"] }));
  } catch (err) {
    console.warn("[DemandAgent] PredictHQ failed:", err.message);
    return [];
  }
}

// SeatGeek — concerts, sports, theater
// Free public API at seatgeek.com/api
async function fetchSeatGeek(startDateTime, endDateTime) {
  const clientId = process.env.SEATGEEK_CLIENT_ID || null;
  if (!clientId) return [];
  try {
    const res = await axios.get("https://api.seatgeek.com/2/events", {
      params: { client_id: clientId, lat: 34.0522, lon: -118.2437, range: "20mi", datetime_utc_gte: startDateTime, datetime_utc_lte: endDateTime, per_page: 5 },
    });
    return (res.data?.events || []).map((e) => ({ name: e.title, source: "seatgeek", impactZones: ["A", "B"] }));
  } catch (err) {
    console.warn("[DemandAgent] SeatGeek failed:", err.message);
    return [];
  }
}

// Aggregate from all sources in parallel
async function fetchEvents(date) {
  const startDateTime = date.toISOString().slice(0, 19) + "Z";
  const endDate = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  const endDateTime = endDate.toISOString().slice(0, 19) + "Z";

  const [tmEvents, phqEvents, sgEvents] = await Promise.all([
    fetchTicketmaster(startDateTime, endDateTime),
    fetchPredictHQ(startDateTime),
    fetchSeatGeek(startDateTime, endDateTime),
  ]);

  const all = [...tmEvents, ...phqEvents, ...sgEvents];
  console.log(`[DemandAgent] Events: ${all.length} total (TM:${tmEvents.length} PHQ:${phqEvents.length} SG:${sgEvents.length})`);
  return all;
}

// Fetch live congestion from TomTom Traffic Flow for each route's key coordinate
async function fetchTomTomCongestion(routes) {
  if (!TOMTOM_KEY) return null;

  // Key coordinates per route (midpoint of each road segment)
  const ROUTE_COORDS = {
    A: "34.0522,-118.3500",  // I-10 midpoint
    B: "34.0300,-118.3800",  // Olympic Blvd midpoint
    C: "34.0000,-118.4200",  // Venice Blvd midpoint
    D: "34.0100,-118.4000",  // Pico Blvd midpoint
    E: "33.9800,-118.4000",  // I-405 midpoint
  };

  const scores = {};
  await Promise.all(
    routes.map(async (route) => {
      const coords = ROUTE_COORDS[route.id];
      if (!coords) return;
      try {
        const res = await axios.get(
          `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json`,
          { params: { point: coords, key: TOMTOM_KEY } }
        );
        const flow = res.data?.flowSegmentData;
        if (!flow) return;
        // currentSpeed vs freeFlowSpeed gives congestion ratio
        const ratio = flow.currentSpeed / flow.freeFlowSpeed;
        // ratio 1.0 = free flow (score 0), ratio 0.0 = gridlock (score 100)
        scores[route.id] = Math.round((1 - ratio) * 100);
      } catch (err) {
        console.warn(`[DemandAgent] TomTom failed for route ${route.id}:`, err.message);
      }
    })
  );
  return Object.keys(scores).length > 0 ? scores : null;
}

function scoreCongestion(routes, rushHour, activeEvents, tomtomScores) {
  return routes.map((route) => {
    let score;

    if (tomtomScores && tomtomScores[route.id] !== undefined) {
      // Real TomTom data — use directly
      score = tomtomScores[route.id];
    } else {
      // Simulation fallback
      const weight = route.congestionWeight || 0.5;
      score = 10 + weight * 20;
      if (rushHour) score += weight * 55;
      activeEvents.forEach((e) => {
        if (e.impactZones?.includes(route.id)) score += 20;
      });
      score = Math.round(Math.min(score, 100));
    }

    return {
      routeId: route.id,
      routeName: route.name,
      congestionScore: score,
      status: score >= 70 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW",
      source: tomtomScores ? "tomtom" : "simulation",
    };
  });
}

async function demandAgent({ timestamp, hour, dayOfWeek } = {}) {
  const time = parseTime(timestamp || hour);
  const resolvedDay = dayOfWeek ?? time.dayOfWeek;
  const rushHour = isRushHour(time.hour, time.minute);

  const [activeEvents, tomtomScores] = await Promise.all([
    fetchEvents(time.date),
    fetchTomTomCongestion(ROUTES),
  ]);

  const forecast = scoreCongestion(ROUTES, rushHour, activeEvents, tomtomScores);
  const highRoutes = forecast.filter((r) => r.status === "HIGH").map((r) => r.routeName).join(", ");
  const dataSource = tomtomScores ? "live TomTom traffic data" : "simulation";

  const prompt = `LA traffic analyst. Time: ${time.hour}:${String(time.minute).padStart(2,"0")}. 
${rushHour ? rushHour.label + " in effect." : "No rush hour."}
${activeEvents.length ? "Events: " + activeEvents.map((e) => e.name).join(", ") + "." : "No events."}
High congestion: ${highRoutes || "none"}.
Write 1 sentence traffic alert.`;

  const mockSummary = rushHour
    ? `${rushHour.label} in effect — expect heavy congestion on ${highRoutes || "major routes"}.`
    : "Traffic is moderate — good time to travel.";

  const summary = await callLLM(prompt, mockSummary);

  return {
    agent: "DemandAgent",
    timestamp: new Date().toISOString(),
    dataSource,
    context: { hour: time.hour, minute: time.minute, dayOfWeek: resolvedDay, rushHour: rushHour?.label || null, activeEvents: activeEvents.map((e) => e.name) },
    forecast,
    summary,
  };
}

module.exports = { demandAgent };
