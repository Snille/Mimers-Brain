// Publishes the brain's own vital signs to MQTT, so Home Assistant - and from
// there the TockenTracker on the wall - can show whether the memory is alive and
// how much it is being used.
//
// Only counters and timestamps go out. No memory content, no search queries, no
// client keys. The broker is on the LAN, but "it never leaves the house" is not
// a reason to publish something that did not need publishing.
//
// Configured entirely from .env, deliberately: the broker password would
// otherwise live in the vault database and therefore in every nightly dump, and
// the one place secrets already belong on this box is .env.

import mqtt from "mqtt";
import * as db from "./lib.mjs";

const URL_ = process.env.MQTT_URL || "";
const PREFIX = (process.env.MQTT_PREFIX || "mimersbrain").replace(/\/+$/, "");
const DISCOVERY = (process.env.MQTT_DISCOVERY_PREFIX || "homeassistant").replace(/\/+$/, "");
const INTERVAL = Math.max(10, Number(process.env.MQTT_INTERVAL_S || 60)) * 1000;

const T_STATE = `${PREFIX}/state`;
const T_STATUS = `${PREFIX}/status`;

// Home Assistant builds the entity_id from the DEVICE name plus the sensor name -
// not from object_id, whatever the docs imply. So `sensor.mimers_brain_calls_today`
// is a consequence of DEVICE_NAME and the `name` fields below, and renaming
// either one renames the entity and silently breaks anything subscribing to it.
// The ESPHome display subscribes by entity_id, so treat these names as the
// contract they are.
const DEVICE_NAME = "Mimers Brain";
const DEVICE = {
  identifiers: ["mimers_brain"],
  name: DEVICE_NAME,
  manufacturer: "Snille",
  model: "Mimers Brain MCP memory",
};

const AVAILABILITY = {
  availability_topic: T_STATUS,
  payload_available: "online",
  payload_not_available: "offline",
};

// name, json key, and the optional extras HA needs to render it properly.
const SENSORS = [
  ["Memories Total", "memories_total", { icon: "mdi:brain", unit_of_measurement: "memories", state_class: "measurement" }],
  ["Memories Open", "memories_open", { icon: "mdi:earth", unit_of_measurement: "memories", state_class: "measurement" }],
  ["Memories Vault", "memories_vault", { icon: "mdi:safe", unit_of_measurement: "memories", state_class: "measurement" }],
  ["Memories Unembedded", "memories_unembedded", { icon: "mdi:alert-circle-outline", unit_of_measurement: "memories", state_class: "measurement" }],
  ["Memories Today", "memories_today", { icon: "mdi:calendar-today", unit_of_measurement: "memories", state_class: "total_increasing" }],
  ["Memories Week", "memories_week", { icon: "mdi:calendar-week", unit_of_measurement: "memories", state_class: "total_increasing" }],
  ["Memories Month", "memories_month", { icon: "mdi:calendar-month", unit_of_measurement: "memories", state_class: "total_increasing" }],
  ["Memories Year", "memories_year", { icon: "mdi:calendar", unit_of_measurement: "memories", state_class: "total_increasing" }],
  ["Calls Today", "calls_today", { icon: "mdi:swap-horizontal", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Calls Week", "calls_week", { icon: "mdi:swap-horizontal", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Calls Month", "calls_month", { icon: "mdi:swap-horizontal", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Calls Year", "calls_year", { icon: "mdi:swap-horizontal", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Calls Total", "calls_total", { icon: "mdi:swap-horizontal", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Reads Today", "reads_today", { icon: "mdi:book-open-variant", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Writes Today", "writes_today", { icon: "mdi:pencil", unit_of_measurement: "calls", state_class: "total_increasing" }],
  ["Clients Week", "clients_week", { icon: "mdi:account-multiple", unit_of_measurement: "clients", state_class: "measurement" }],
  ["Top Client", "top_client", { icon: "mdi:account-star" }],
  ["Last Memory", "last_memory", { device_class: "timestamp", icon: "mdi:clock-outline" }],
  ["Last Call", "last_call", { device_class: "timestamp", icon: "mdi:clock-outline" }],
  ["Status", "status", { icon: "mdi:heart-pulse" }],
  ["Problem", "problem", { icon: "mdi:alert" }],
  ["Uptime", "uptime_s", { unit_of_measurement: "s", device_class: "duration", state_class: "total_increasing", icon: "mdi:timer-outline" }],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const state = {
  configured: Boolean(URL_),
  connected: false,
  broker: URL_ ? URL_.replace(/\/\/[^@/]*@/, "//") : null, // strip any user:pass
  prefix: PREFIX,
  intervalS: INTERVAL / 1000,
  lastPublish: null,
  lastError: null,
  discoverySent: false,
};

let client = null;
let timer = null;
let debounce = null;
const startedAt = Date.now();

export function mqttStatus() {
  return { ...state };
}

function publishDiscovery() {
  for (const [name, key, extra] of SENSORS) {
    const object_id = `mimers_brain_${slug(name)}`;
    client.publish(
      `${DISCOVERY}/sensor/mimers_brain/${slug(name)}/config`,
      JSON.stringify({
        name,
        unique_id: object_id,
        object_id,
        state_topic: T_STATE,
        // A single retained JSON payload feeds every sensor, so HA repopulates
        // all of them from one message after a restart instead of showing
        // "unknown" until the next publish.
        value_template: `{{ value_json.${key} }}`,
        device: DEVICE,
        ...AVAILABILITY,
        ...extra,
      }),
      { retain: true },
    );
  }

  // Not given an availability block on purpose. With one it would go
  // "unavailable" when the brain dies, which reads as a broken sensor; without
  // one the last will lands as a plain "off" and the wall display can say so.
  client.publish(
    `${DISCOVERY}/binary_sensor/mimers_brain/online/config`,
    JSON.stringify({
      name: "Online",
      unique_id: "mimers_brain_online",
      object_id: "mimers_brain_online",
      state_topic: T_STATUS,
      payload_on: "online",
      payload_off: "offline",
      device_class: "connectivity",
      device: DEVICE,
    }),
    { retain: true },
  );

  state.discoverySent = true;
}

export async function publishNow() {
  if (!client?.connected) return false;
  let payload;
  try {
    const counters = await db.liveCounters();
    const problems = [];
    if (!process.env.OPENROUTER_API_KEY)
      problems.push("No OPENROUTER_API_KEY: semantic search is off");
    if (counters.memories_unembedded)
      problems.push(`${counters.memories_unembedded} memories have no embedding`);
    payload = {
      ...counters,
      status: problems.length ? "degraded" : "ok",
      // Names the action where it can, same as the Tokentracker sensors: a
      // problem line that only states the symptom gets read once and ignored.
      problem: problems.join(" | ").slice(0, 255) || "OK",
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
  } catch (e) {
    payload = {
      status: "error",
      problem: `Database unreachable: ${String(e.message).slice(0, 200)}`,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
    state.lastError = e.message;
  }

  client.publish(T_STATE, JSON.stringify(payload), { retain: true });
  state.lastPublish = new Date().toISOString();
  return true;
}

// Called after a write so the wall display reacts within seconds rather than at
// the next tick. Debounced: an import loop must not turn into an MQTT flood.
export function publishSoon() {
  if (!client?.connected || debounce) return;
  debounce = setTimeout(() => { debounce = null; publishNow(); }, 5000);
}

export function startMqtt() {
  if (!URL_) {
    console.log("MQTT_URL not set - no publishing to Home Assistant.");
    return;
  }

  client = mqtt.connect(URL_, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: process.env.MQTT_CLIENT_ID || `mimers-brain-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 10000,
    // The whole point of the availability topic: if this process dies, the
    // broker itself publishes "offline" on our behalf. Without a will, a dead
    // brain looks exactly like a healthy one that has nothing new to say.
    will: { topic: T_STATUS, payload: "offline", retain: true, qos: 1 },
  });

  client.on("connect", async () => {
    state.connected = true;
    state.lastError = null;
    console.log(`MQTT connected -> ${state.broker} (prefix ${PREFIX})`);
    client.publish(T_STATUS, "online", { retain: true, qos: 1 });
    publishDiscovery();
    await publishNow();
    clearInterval(timer);
    timer = setInterval(publishNow, INTERVAL);
  });

  client.on("error", (e) => {
    state.lastError = e.message;
    console.error("MQTT:", e.message);
  });
  client.on("close", () => { state.connected = false; });
  client.on("offline", () => { state.connected = false; });
}

// Say goodbye properly on a planned stop, so HA shows offline immediately rather
// than waiting for the broker to notice the dropped socket.
export async function stopMqtt() {
  clearInterval(timer);
  if (!client?.connected) return;
  await new Promise((r) => client.publish(T_STATUS, "offline", { retain: true, qos: 1 }, r));
  await new Promise((r) => client.end(false, {}, r));
}
