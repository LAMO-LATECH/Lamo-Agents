// ============================================================
// DEMAND AGENT
// Forecasts congestion per route using:
//   - Mapbox congestion annotations (passed in from routingAgent)
//   - Rush hour simulation fallback
//   - Events from Ticketmaster, PredictHQ, SeatGeek, Eventbrite
//
// Mapbox driving-traffic profile uses
// real-time traffic data. Congestion scores derived directly from
// Mapbox segment annotations for accuracy and speed.
// ============================================================
require("dotenv").config();
const { callLLM } = require("../config/llmClient");
const { ROUTES, RUSH_HOURS } = require("../config/data");
const axios = require("axios");

const TM_KEY = process.env.TICKETMASTER_API_KEY || null;
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

// ── Event Sources ──────────────────────────────────────────

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

async function fetchEventbrite(startDateTime, endDateTime) {
  const key = process.env.EVENTBRITE_API_KEY || null;
  if (!key) return [];
  try {
    const res = await axios.get("https://www.eventbriteapi.com/v3/events/search/", {
      headers: { Authorization: `Bearer ${key}` },
      params: {
        "location.latitude": 34.0522,
        "location.longitude": -118.2437,
        "location.within": "20mi",
        "start_date.range_start": startDateTime,
        "start_date.range_end": endDateTime,
        expand: "venue",
        page_size: 5,
      },
    });
    return (res.data?.events || []).map((e) => ({ name: e.name?.text || "Event", source: "eventbrite", impactZones: ["A", "B"] }));
  } catch (err) {
    console.warn("[DemandAgent] Eventbrite failed:", err.message);
    return [];
  }
}

async function fetchEvents(date) {
  const startDateTime = date.toISOString().slice(0, 19) + "Z";
  const endDate = new Date(date.getTime() + 2 * 60 * 60 * 1000);
  const endDateTime = endDate.toISOString().slice(0, 19) + "Z";

  const [tmEvents, phqEvents, sgEvents, ebEvents] = await Promise.all([
    fetchTicketmaster(startDateTime, endDateTime),
    fetchPredictHQ(startDateTime),
    fetchSeatGeek(startDateTime, endDateTime),
    fetchEventbrite(startDateTime, endDateTime),
  ]);

  const all = [...tmEvents, ...phqEvents, ...sgEvents, ...ebEvents];
  console.log(`[DemandAgent] Events: ${all.length} total (TM:${tmEvents.length} PHQ:${phqEvents.length} SG:${sgEvents.length} EB:${ebEvents.length})`);
  return all;
}

// ── Congestion Scoring ─────────────────────────────────────

function scoreCongestion(routes, rushHour, activeEvents, mapboxScores) {
  return routes.map((route) => {
    const routeId = route.routeId || route.id;
    const routeName = route.routeName || route.name;
    let score;
    let source;

    if (mapboxScores && mapboxScores[routeId] !== undefined) {
      score = mapboxScores[routeId];
      source = "mapbox";
    } else {
      const weight = route.congestionWeight || 0.5;
      score = 10 + weight * 20;
      if (rushHour) score += weight * 55;
      activeEvents.forEach((e) => {
        if (e.impactZones?.includes(routeId)) score += 20;
      });
      score = Math.round(Math.min(score, 100));
      source = "simulation";
    }

    return {
      routeId,
      routeName,
      congestionScore: score,
      status: score >= 70 ? "HIGH" : score >= 45 ? "MEDIUM" : "LOW",
      source,
    };
  });
}

// ── Main Agent ─────────────────────────────────────────────

async function demandAgent({ timestamp, hour, dayOfWeek, mapboxScores } = {}) {
  const time = parseTime(timestamp || hour);
  const resolvedDay = dayOfWeek ?? time.dayOfWeek;
  const rushHour = isRushHour(time.hour, time.minute);

  const activeEvents = await fetchEvents(time.date);

  const routeInputs = mapboxScores
    ? Object.keys(mapboxScores).map((id) => ({ routeId: id, routeName: id, congestionWeight: 0.5 }))
    : ROUTES;

  const forecast = scoreCongestion(routeInputs, rushHour, activeEvents, mapboxScores);
  const highRoutes = forecast.filter((r) => r.status === "HIGH").map((r) => r.routeName).join(", ");
  const dataSource = mapboxScores ? "mapbox" : "simulation";

  const prompt = `LA traffic analyst. Time: ${time.hour}:${String(time.minute).padStart(2, "0")}.
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
    context: {
      hour: time.hour,
      minute: time.minute,
      dayOfWeek: resolvedDay,
      rushHour: rushHour?.label || null,
      activeEvents: activeEvents.map((e) => e.name),
    },
    forecast,
    summary,
  };
}

module.exports = { demandAgent };
