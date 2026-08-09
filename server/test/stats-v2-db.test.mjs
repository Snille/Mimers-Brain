import test from "node:test";
import assert from "node:assert/strict";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("statistics v2 separates active records and reported recall usefulness", {
  skip: !databaseUrl && "set TEST_DATABASE_URL to an isolated schema",
}, async () => {
  process.env.DATABASE_URL = databaseUrl;
  const db = await import(new URL(`../lib.mjs?stats-v2=${Date.now()}`, import.meta.url));
  const complete = (extra = {}) => JSON.stringify({
    title: "Test memory", summary: "Statistics fixture", kind: "fact",
    lifecycle: "current", origin: "agent", provenance: "user_confirmed",
    review_status: "confirmed", ...extra,
  });

  try {
    await db.ensureSchema();
    const { rows } = await db.pool.query(
      `INSERT INTO thoughts (content, tier, metadata) VALUES
         ('active', 'open', $1::jsonb),
         ('pending', 'open', $2::jsonb),
         ('restricted', 'open', $3::jsonb),
         ('source', 'open', $4::jsonb),
         ('old', 'vault', $5::jsonb)
       RETURNING id, content`,
      [
        complete(),
        complete({ review_status: "pending", provenance: "inferred" }),
        complete({ review_status: "evidence_only", can_use_as_evidence: false, reviewed_at: "2026-08-09T10:00:00Z" }),
        complete({ lifecycle: "archived" }),
        complete({ lifecycle: "superseded", review_status: "pending", provenance: "inferred" }),
      ],
    );
    const ids = Object.fromEntries(rows.map((row) => [row.content, row.id]));
    await db.pool.query(
      `INSERT INTO thought_relations (from_id, to_id, relation) VALUES ($1, $2, 'derived_from')`,
      [ids.active, ids.source],
    );
    await db.pool.query(
      `INSERT INTO memory_review_events (thought_id, action) VALUES ($1, 'confirm')`,
      [ids.pending],
    );
    await db.pool.query(
      `INSERT INTO recall_traces
         (listener, client, result_ids, used_ids, ignored_ids, reported_at, created_at) VALUES
         ('open', 'client-a', ARRAY[$1::uuid,$2::uuid], ARRAY[$1::uuid], ARRAY[$2::uuid], now(), now()),
         ('open', 'client-a', ARRAY[$1::uuid], '{}', '{}', NULL, now() - interval '15 minutes'),
         ('full', 'client-b', '{}', '{}', '{}', now(), now()),
         ('open', 'client-a', ARRAY[$1::uuid], '{}', '{}', NULL, now() - interval '2 days')`,
      [ids.active, ids.pending],
    );
    await db.pool.query(
      `INSERT INTO usage_events (tool, action, listener, client, ok, ms) VALUES
         ('search_thoughts', 'read', 'open', 'client-a', true, 10),
         ('search_thoughts', 'read', 'open', 'client-a', true, 30),
         ('search_thoughts', 'read', 'open', 'client-a', false, 50)`,
    );

    const stats = await db.usageStats(["open", "vault"]);
    assert.deepEqual(
      {
        records: stats.memoryHealth.records,
        active: stats.memoryHealth.active,
        inactive: stats.memoryHealth.inactive,
        pending: stats.memoryHealth.pendingReview,
        archivedSources: stats.memoryHealth.archivedSources,
        unembedded: stats.memoryHealth.unembedded,
      },
      { records: 5, active: 3, inactive: 2, pending: 1, archivedSources: 1, unembedded: 3 },
    );
    assert.equal(stats.memoryHealth.reviewStatuses.restricted, 1);
    assert.equal(stats.memoryHealth.reviewsTotal, 1);
    const queue = await db.reviewQueue(["open", "vault"]);
    assert.deepEqual(queue.map((row) => row.id), [ids.pending]);
    assert.equal(stats.memoryDaily.reduce((sum, row) => sum + row.active, 0), 3);
    assert.equal(stats.memoryDaily.reduce((sum, row) => sum + row.inactive, 0), 2);

    assert.equal(stats.recall.searches, 4);
    assert.equal(stats.recall.reports, 2);
    assert.equal(stats.recall.overdue, 2);
    assert.equal(stats.recall.returned, 4);
    assert.equal(stats.recall.reportedReturned, 2);
    assert.equal(stats.recall.used, 1);
    assert.equal(stats.recall.reportingPercent, 50);
    assert.equal(stats.recall.usePercent, 50);
    assert.equal(stats.recall.byClient.find((row) => row.client === "client-a").overdue, 2);

    const tool = stats.byTool.find((row) => row.tool === "search_thoughts");
    assert.equal(tool.errors, 1);
    assert.equal(tool.avg_ms, 30);
    assert.ok(tool.p95_ms >= tool.avg_ms);

    const open = await db.usageStats(["open"]);
    assert.equal(open.memoryHealth.records, 4);
    assert.equal(open.memoryHealth.superseded, 0);
    assert.equal(open.recall.searches, 3);
    assert.equal(open.recall.reports, 1);
    assert.equal(open.recall.byClient.some((row) => row.client === "client-b"), false);

    const live = await db.liveCounters();
    assert.equal(live.memories_pending_review, 1);
    assert.equal(live.memories_evidence_only, 1);
    assert.equal(live.memories_stale, 0);
    assert.equal(live.recall_searches_today, 3);
    assert.equal(live.recall_reports_today, 2);
    assert.equal(live.recall_unreported, 2);
    assert.equal(live.recall_use_percent_today, 50);
  } finally {
    await db.pool.end();
  }
});
