# Home Assistant over MQTT

Set `MQTT_URL` (and `MQTT_USERNAME` / `MQTT_PASSWORD`) in `.env` and run
`docker compose up -d`. The brain announces itself through MQTT discovery as the
device **Mimers Brain** and publishes its counters every `MQTT_INTERVAL_S`
seconds (60) and right after every write. Leave `MQTT_URL` empty to publish
nothing.

Only counts and timestamps go on the broker: never memory content, search
queries or answers. The vault *count* is published, which matters if the broker
is shared.

## Entities

Entity ids come from the device name plus each sensor name (not from
`object_id`), so treat them as a contract:

| Entity | What |
| --- | --- |
| `binary_sensor.mimers_brain_online` | connectivity, driven by the last will |
| `sensor.mimers_brain_memories_total` / `_open` / `_vault` | size of the memory |
| `sensor.mimers_brain_memories_pending_review` / `_evidence_only` / `_stale` | review queue (current memories only) |
| `sensor.mimers_brain_memories_today` / `_week` / `_month` / `_year` | growth |
| `sensor.mimers_brain_calls_today` / `_week` / `_month` / `_year` / `_total` | traffic |
| `sensor.mimers_brain_reads_today`, `_writes_today` | traffic split |
| `sensor.mimers_brain_clients_week`, `_top_client` | who uses it |
| `sensor.mimers_brain_recall_searches_today`, `_reports_today`, `_unreported` | recall receipt coverage |
| `sensor.mimers_brain_recall_memories_returned_today`, `_used_today` | recall usefulness |
| `sensor.mimers_brain_recall_reporting_percent_today`, `_use_percent_today` | receipt and use rates |
| `sensor.mimers_brain_last_memory`, `_last_recall`, `_last_call` | timestamps |
| `sensor.mimers_brain_status`, `_problem` | `ok` / `degraded` / `error`, and why |
| `sensor.mimers_brain_uptime` | seconds since start |
| `number.mimers_brain_unreported_fault` | unreported recalls per day before the status degrades |

All sensors read one retained JSON payload on `<MQTT_PREFIX>/state`, so Home
Assistant fills every sensor from a single message after a restart.

## Details worth knowing

- **State classes.** Growth counters are `measurement`: deleting a memory makes
  them fall, and a falling `total_increasing` counter reads as a reset and
  corrupts long-term statistics. Traffic counters are `total_increasing`, since a
  call cannot be un-made.
- **Unreported recalls.** `_recall_unreported` counts searches from the last 24
  hours with no receipt after ten minutes. A few are normal (a session closed
  early) and leave the status `ok`. At the threshold the status degrades, since
  that many means a client that never reports. The threshold is the slider
  `number.mimers_brain_unreported_fault` (1–50); `MQTT_UNREPORTED_FAULT` is only
  its first value, and the slider's choice is kept as a retained message.
- **Last will.** If the process dies, the broker publishes `offline` for it. A
  planned stop says `offline` itself, so a restart shows as a short blip.
- **Display glyphs.** `_problem` is shown on an ESPHome display whose font has a
  fixed glyph list, so the text is filtered to that list (faults are separated by
  `/`, not `|`). If the device YAML's `glyphs:` line changes, update
  `DISPLAY_GLYPHS` in `server/mqtt.mjs`.
- **Credentials.** The broker password stays in `.env`, not in the database, so
  it is not in the nightly dumps.
