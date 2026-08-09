import test from "node:test";
import assert from "node:assert/strict";

import { MQTT_SENSORS } from "../mqtt.mjs";

test("MQTT discovery keeps the Home Assistant governance contract", () => {
  const sensors = new Map(MQTT_SENSORS.map(([name, key, extra]) => [key, { name, extra }]));

  const expected = {
    memories_pending_review: "Memories Pending Review",
    memories_evidence_only: "Memories Evidence Only",
    memories_stale: "Memories Stale",
    recall_searches_today: "Recall Searches Today",
    recall_reports_today: "Recall Reports Today",
    recall_memories_returned_today: "Recall Memories Returned Today",
    recall_memories_used_today: "Recall Memories Used Today",
    recall_unreported: "Recall Unreported",
    recall_reporting_percent_today: "Recall Reporting Percent Today",
    recall_use_percent_today: "Recall Use Percent Today",
    last_recall: "Last Recall",
  };

  for (const [key, name] of Object.entries(expected)) {
    assert.equal(sensors.get(key)?.name, name, `missing or renamed MQTT sensor: ${key}`);
  }
  assert.equal(sensors.get("memories_pending_review").extra.state_class, "measurement");
  assert.equal(sensors.get("recall_unreported").extra.state_class, "measurement");
  assert.equal(sensors.get("last_recall").extra.device_class, "timestamp");
});
