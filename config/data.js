// ============================================================
// LAMO SIMULATION DATA
// Each route has a base congestion weight — freeways attract
// more traffic so they congest faster than surface streets.
// Surface streets stay cleaner but have lower capacity.
// ============================================================

const ROUTES = [
  {
    id: "A",
    name: "I-10 Freeway",
    from: "Downtown LA",
    to: "Santa Monica",
    baseDuration: 35,
    distance: 16,
    type: "freeway",
    throughResidential: false,
    emissionScore: 8,
    // Freeways attract the most traffic — highest base congestion
    congestionWeight: 1.0,
  },
  {
    id: "B",
    name: "Olympic Blvd",
    from: "Downtown LA",
    to: "Santa Monica",
    baseDuration: 40,
    distance: 15,
    type: "surface",
    throughResidential: false,
    emissionScore: 5,
    // Surface arterial — moderate congestion
    congestionWeight: 0.6,
  },
  {
    id: "C",
    name: "Venice Blvd",
    from: "Downtown LA",
    to: "Santa Monica",
    baseDuration: 42,
    distance: 14,
    type: "surface",
    throughResidential: true,
    emissionScore: 4,
    // Residential — least congested but limited capacity
    congestionWeight: 0.4,
  },
  {
    id: "D",
    name: "Pico Blvd",
    from: "Downtown LA",
    to: "Santa Monica",
    baseDuration: 44,
    distance: 14,
    type: "surface",
    throughResidential: true,
    emissionScore: 4,
    congestionWeight: 0.4,
  },
  {
    id: "E",
    name: "I-405 Loop",
    from: "Downtown LA",
    to: "Santa Monica",
    baseDuration: 50,
    distance: 22,
    type: "freeway",
    throughResidential: false,
    emissionScore: 9,
    // Slightly less congested than I-10 because it's longer/less direct
    congestionWeight: 0.8,
  },
];

const EVENTS = [
  { name: "Lakers Game",         location: "Crypto.com Arena", time: "19:30", daysOfWeek: [1, 3, 5], impactZones: ["A", "B"] },
  { name: "SoFi Stadium Concert",location: "Inglewood",        time: "20:00", daysOfWeek: [5, 6],    impactZones: ["C", "D", "E"] },
  { name: "Venice Beach Weekend", location: "Venice",          time: "10:00", daysOfWeek: [0, 6],    impactZones: ["C", "D"] },
];

const RUSH_HOURS = [
  { label: "Morning Rush", start: 7,  end: 9  },
  { label: "Evening Rush", start: 17, end: 19 },
];

module.exports = { ROUTES, EVENTS, RUSH_HOURS };
