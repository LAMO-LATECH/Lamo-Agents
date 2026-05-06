require("dotenv").config();
const { callLLM } = require("../config/llmClient");
const { ROUTES } = require("../config/data");

const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || null;
const USE_REAL_ROUTING = !!MAPBOX_TOKEN;

// Geocode any address string to [lng, lat] using Mapbox Geocoding API
async function geocodeAddress(address) {
  const axios = require("axios");
  try {
    const encoded = encodeURIComponent(address);
    const res = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json`,
      {
        params: {
          access_token: MAPBOX_TOKEN,
          country: "US",
          proximity: "-118.2437,34.0522", // bias toward LA
          limit: 1,
        },
      }
    );
    const feature = res.data?.features?.[0];
    if (!feature) throw new Error(`No results for: ${address}`);
    return feature.center; // [lng, lat]
  } catch (err) {
    console.warn(`[RoutingAgent] Geocoding failed for "${address}":`, err.message);
    return null;
  }
}

async function fetchRealRoutes(from, to, congestionForecast) {
  const mbxDirections = require("@mapbox/mapbox-sdk/services/directions");
  const directionsClient = mbxDirections({ accessToken: MAPBOX_TOKEN });

  // Geocode both addresses dynamically — no hardcoded coordinates
  const [fromCoords, toCoords] = await Promise.all([
    geocodeAddress(from),
    geocodeAddress(to),
  ]);

  if (!fromCoords || !toCoords) {
    console.warn("[RoutingAgent] Geocoding failed, falling back to simulation.");
    return fetchSimulatedRoutes(congestionForecast);
  }

  const response = await directionsClient.getDirections({
    profile: "driving-traffic",
    waypoints: [
      { coordinates: fromCoords },
      { coordinates: toCoords },
    ],
    alternatives: true,
    annotations: ["congestion", "speed"],
    overview: "full",
    geometries: "geojson",
  }).send();

  const routes = response.body.routes;

  return routes.map((route, i) => {
    const routeId = String.fromCharCode(65 + i);
    const durationMin = Math.round(route.duration / 60);
    const distanceMiles = (route.legs[0].distance / 1609.34).toFixed(1);
    const routeName = route.legs[0]?.summary || `Route ${routeId}`;

    // Derive congestion score from speed ratio (currentSpeed vs freeflow)
    const annotations = route.legs[0]?.annotation;
    let congestionScore = 20;
    if (annotations?.congestion) {
      const levels = annotations.congestion;
      const severeCount = levels.filter((l) => l === "severe" || l === "heavy").length;
      congestionScore = Math.min(Math.round((severeCount / levels.length) * 100), 100);
    }

    const status = congestionScore >= 70 ? "HIGH" : congestionScore >= 45 ? "MEDIUM" : "LOW";
    const isFreeway = /I-\d|Highway|Hwy|Fwy/.test(routeName);
    const isResidential = /Blvd|Ave|St|Dr/.test(routeName) && !isFreeway;

    return {
      routeId,
      routeName,
      from,
      to,
      distance: parseFloat(distanceMiles),
      baseDuration: durationMin,
      estimatedDuration: durationMin,
      congestionScore,
      congestionStatus: status,
      type: isFreeway ? "freeway" : "surface",
      throughResidential: isResidential,
      emissionScore: isFreeway ? 8 : 5,
      _geometry: route.geometry,
    };
  });
}

function fetchSimulatedRoutes(congestionForecast) {
  return ROUTES.map((route) => {
    const congestionData = congestionForecast.find((c) => c.routeId === route.id);
    const congestionScore = congestionData?.congestionScore ?? 20;
    const estimatedDuration = Math.round(route.baseDuration * (1 + congestionScore / 100));
    return {
      routeId: route.id,
      routeName: route.name,
      from: route.from,
      to: route.to,
      distance: route.distance,
      baseDuration: route.baseDuration,
      estimatedDuration,
      congestionScore,
      congestionStatus: congestionData?.status ?? "LOW",
      type: route.type,
      throughResidential: route.throughResidential,
      emissionScore: route.emissionScore,
    };
  });
}

async function routingAgent({ from, to, congestionForecast }) {
  let routes;
  if (USE_REAL_ROUTING) {
    console.log("[RoutingAgent] Geocoding addresses and fetching Mapbox routes...");
    try {
      routes = await fetchRealRoutes(from, to, congestionForecast);
    } catch (err) {
      console.warn("[RoutingAgent] Mapbox failed, using simulation:", err.message);
      routes = fetchSimulatedRoutes(congestionForecast);
    }
  } else {
    console.log("[RoutingAgent] No Mapbox token — using simulation.");
    routes = fetchSimulatedRoutes(congestionForecast);
  }

  const ranked = [...routes].sort((a, b) => a.estimatedDuration - b.estimatedDuration);
  const fastest = ranked[0];

  const prompt = `User traveling from ${from} to ${to} in LA.
Fastest option: ${fastest.routeName} (${fastest.estimatedDuration} min, ${fastest.congestionStatus} congestion).
${ranked.length} routes available. Write 1 sentence describing the situation.`;

  const mockSummary = `${ranked.length} routes found — fastest is ${fastest.routeName} at ~${fastest.estimatedDuration} min (${fastest.congestionStatus} congestion).`;
  const summary = await callLLM(prompt, mockSummary);

  return { agent: "RoutingAgent", from, to, routes: ranked, summary };
}

module.exports = { routingAgent };
