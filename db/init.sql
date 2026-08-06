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
    -- 'vault' = tokens, keys, passwords. Served ONLY on the LAN-only port.
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

CREATE OR REPLACE FUNCTION update_updated_at() RETURNS trigger AS $$
BEGIN
    new.updated_at = now();
    RETURN new;
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
