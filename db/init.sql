-- Mimers Valv - schema.
--
-- Same shape as the OB1 "thoughts" table so knowledge migrates across unchanged,
-- plus a `tier` column that decides whether a row may leave the house.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    content             text NOT NULL,
    embedding           vector(1536),
    metadata            jsonb DEFAULT '{}'::jsonb,
    -- 'open'  = topology, workflows, project knowledge. Served on both ports.
    -- 'vault' = sensitive context and SECRET_REF pointers. Raw secret values
    --           are never stored. Served ONLY on the LAN-only port.
    tier                text NOT NULL DEFAULT 'open' CHECK (tier IN ('open', 'vault')),
    content_fingerprint text,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thoughts_created_at_idx ON thoughts (created_at DESC);
CREATE INDEX IF NOT EXISTS thoughts_metadata_idx   ON thoughts USING gin (metadata);
CREATE INDEX IF NOT EXISTS thoughts_tier_idx       ON thoughts (tier);
CREATE INDEX IF NOT EXISTS thoughts_embedding_idx  ON thoughts USING hnsw (embedding vector_cosine_ops);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thoughts_fingerprint
    ON thoughts (content_fingerprint)
    WHERE content_fingerprint IS NOT NULL;

-- Navigable history. A replacement points to every older memory it supersedes;
-- the older rows stay readable but are hidden from current-only searches.
CREATE TABLE IF NOT EXISTS thought_relations (
    from_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    to_id      uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    relation   text NOT NULL CHECK (relation IN (
        'supersedes', 'related_to', 'derived_from', 'conflicts_with', 'merged_into', 'source_of'
    )),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);

CREATE INDEX IF NOT EXISTS thought_relations_to_idx ON thought_relations (to_id, relation);

-- Human review and duplicate decisions remain auditable without putting notes
-- into the memory itself or exposing them through ordinary recall.
CREATE TABLE IF NOT EXISTS memory_review_events (
    id         bigserial PRIMARY KEY,
    thought_id uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    reviewed_at timestamptz NOT NULL DEFAULT now(),
    action     text NOT NULL,
    actor      text NOT NULL DEFAULT 'user',
    detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS duplicate_resolutions (
    left_id     uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    right_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    resolution  text NOT NULL,
    actor       text NOT NULL DEFAULT 'user',
    result      jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (left_id, right_id),
    CHECK (left_id::text < right_id::text)
);

-- Privacy-preserving recall receipts: ids and client identity only. There is
-- deliberately no column for the query, response, or memory content.
CREATE TABLE IF NOT EXISTS recall_traces (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    listener       text NOT NULL CHECK (listener IN ('full', 'open')),
    client         text NOT NULL,
    client_version text,
    result_ids     uuid[] NOT NULL DEFAULT '{}',
    used_ids       uuid[] NOT NULL DEFAULT '{}',
    ignored_ids    uuid[] NOT NULL DEFAULT '{}',
    reported_at    timestamptz
);
CREATE INDEX IF NOT EXISTS recall_traces_created_idx ON recall_traces (created_at DESC);

-- Only a real change moves updated_at; a new embedding does not. Kept identical
-- to UPDATED_AT_SQL in server/lib.mjs.
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS trigger AS $$
BEGIN
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.tier IS DISTINCT FROM OLD.tier THEN
        NEW.updated_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Usage log. One row per meaningful call, so the dashboard can answer "who reads
-- and writes this, and how often". Deliberately holds no content: not the search
-- query, not the memory text, not the result. A row is a fact about traffic, and
-- a traffic log that quotes vault searches back would undo the tier split.
--
-- `listener` is the port the call arrived on, so the open listener can report on
-- itself without revealing that the vault exists at all.
CREATE TABLE IF NOT EXISTS usage_events (
    id             bigserial PRIMARY KEY,
    at             timestamptz NOT NULL DEFAULT now(),
    tool           text NOT NULL,   -- search_thoughts, capture_thought, ui.edit, ...
    action         text NOT NULL,   -- connect | read | write | delete
    listener       text NOT NULL CHECK (listener IN ('full', 'open')),
    client         text NOT NULL,   -- MCP clientInfo.name, else the user agent
    client_version text,
    auth           text,            -- bearer | cookie | url-key | authelia | none
    tier           text,            -- which tier a write landed in
    results        integer,
    ok             boolean NOT NULL DEFAULT true,
    ms             integer
);

CREATE INDEX IF NOT EXISTS usage_events_at_idx     ON usage_events (at DESC);
CREATE INDEX IF NOT EXISTS usage_events_client_idx ON usage_events (client, at DESC);

-- Small things the server works out for itself and should not forget on
-- restart. Currently just lan_url: the LAN address, learned from the Host header
-- of visits to the LAN listener, because asking the OS from inside a container
-- returns Docker's bridge address instead.
CREATE TABLE IF NOT EXISTS app_settings (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Semantic search. p_tiers is always supplied by the server from the port the
-- request arrived on - never from anything the caller controls.
CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector,
    match_threshold double precision DEFAULT 0.5,
    match_count     integer DEFAULT 10,
    filter          jsonb DEFAULT '{}'::jsonb,
    p_tiers         text[] DEFAULT ARRAY['open']
)
RETURNS TABLE (
    id uuid, content text, metadata jsonb, tier text,
    similarity double precision, created_at timestamptz
) AS $$
BEGIN
    RETURN QUERY
    SELECT t.id, t.content, t.metadata, t.tier,
           1 - (t.embedding <=> query_embedding) AS similarity,
           t.created_at
    FROM thoughts t
    WHERE t.tier = ANY(p_tiers)
      AND t.embedding IS NOT NULL
      AND 1 - (t.embedding <=> query_embedding) > match_threshold
      AND (filter = '{}'::jsonb OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Insert, or merge metadata when the same content is captured twice.
CREATE OR REPLACE FUNCTION upsert_thought(
    p_content TEXT,
    p_payload JSONB DEFAULT '{}',
    p_tier    TEXT  DEFAULT 'open'
)
RETURNS JSONB AS $$
DECLARE
    v_fingerprint TEXT;
    v_id          UUID;
BEGIN
    v_fingerprint := encode(sha256(convert_to(
        lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8')), 'hex');

    INSERT INTO thoughts (content, content_fingerprint, metadata, tier)
    VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb), p_tier)
    ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
    SET updated_at = now(),
        metadata   = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
        -- a thought can be promoted to vault, never silently demoted out of it
        tier       = CASE WHEN thoughts.tier = 'vault' THEN 'vault' ELSE EXCLUDED.tier END
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;

-- Change log. A trigger writes one row per create, edit and delete, with the
-- fields as they were before, so an edit can be undone and a deleted memory
-- restored. Kept identical to CHANGE_LOG_SQL in server/lib.mjs, which upgrades
-- an existing brain on boot. thought_id has no foreign key on purpose: the
-- record of a delete has to outlive the row.
CREATE TABLE IF NOT EXISTS thought_changes (
    id         bigserial PRIMARY KEY,
    thought_id uuid NOT NULL,
    tier       text NOT NULL CHECK (tier IN ('open', 'vault')),
    at         timestamptz NOT NULL DEFAULT now(),
    action     text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    actor      text NOT NULL,
    fields     text[] NOT NULL DEFAULT '{}',
    before     jsonb
);
CREATE INDEX IF NOT EXISTS thought_changes_thought_idx ON thought_changes (thought_id, at DESC);
CREATE INDEX IF NOT EXISTS thought_changes_at_idx ON thought_changes (at DESC);

CREATE OR REPLACE FUNCTION log_thought_change() RETURNS trigger AS $$
DECLARE
    v_actor  text := coalesce(nullif(current_setting('mimers.actor', true), ''), 'sql:' || current_user);
    v_fields text[] := '{}';
    v_before jsonb := '{}'::jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO thought_changes (thought_id, tier, action, actor, fields)
        VALUES (NEW.id, NEW.tier, 'create', v_actor, ARRAY['content', 'metadata', 'tier']);
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO thought_changes (thought_id, tier, action, actor, fields, before)
        VALUES (OLD.id, OLD.tier, 'delete', v_actor, ARRAY['content', 'metadata', 'tier'],
                jsonb_build_object(
                    'content', OLD.content, 'metadata', OLD.metadata, 'tier', OLD.tier,
                    'created_at', OLD.created_at,
                    'relations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                    'from_id', r.from_id, 'to_id', r.to_id,
                                    'relation', r.relation, 'created_at', r.created_at)), '[]'::jsonb)
                                    FROM thought_relations r
                                   WHERE r.from_id = OLD.id OR r.to_id = OLD.id)));
        RETURN OLD;
    END IF;

    -- A new embedding or a touched updated_at is not a change anyone reads.
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        v_fields := v_fields || 'content'::text;
        v_before := v_before || jsonb_build_object('content', OLD.content);
    END IF;
    IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
        v_fields := v_fields || 'metadata'::text;
        v_before := v_before || jsonb_build_object('metadata', OLD.metadata);
    END IF;
    IF OLD.tier IS DISTINCT FROM NEW.tier THEN
        v_fields := v_fields || 'tier'::text;
        v_before := v_before || jsonb_build_object('tier', OLD.tier);
    END IF;
    IF cardinality(v_fields) = 0 THEN RETURN NEW; END IF;

    INSERT INTO thought_changes (thought_id, tier, action, actor, fields, before)
    VALUES (NEW.id, CASE WHEN 'vault' IN (OLD.tier, NEW.tier) THEN 'vault' ELSE 'open' END,
            'update', v_actor, v_fields, v_before);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE DELETE, so the relations are still there to be copied: the
-- cascade removes them before any AFTER trigger would run.
DROP TRIGGER IF EXISTS thoughts_change_log ON thoughts;
CREATE TRIGGER thoughts_change_log AFTER INSERT OR UPDATE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION log_thought_change();
DROP TRIGGER IF EXISTS thoughts_delete_log ON thoughts;
CREATE TRIGGER thoughts_delete_log BEFORE DELETE ON thoughts
    FOR EACH ROW EXECUTE FUNCTION log_thought_change();

-- Contradiction verdicts from the metadata model, one per memory pair, kept
-- until either memory changes. Kept identical to CONTRADICTION_SQL in lib.mjs.
CREATE TABLE IF NOT EXISTS contradiction_checks (
    left_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    right_id   uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
    verdict    text NOT NULL CHECK (verdict IN ('conflict', 'consistent', 'dismissed')),
    reason     text,
    model      text,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (left_id, right_id),
    CHECK (left_id::text < right_id::text)
);
