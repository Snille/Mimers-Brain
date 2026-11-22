// The SQL that decides what is in the base digest and in each context; see
// contexts.mjs for the rules. A file of its own with no imports, because
// lib.mjs needs it at load time and contexts.mjs needs lib.mjs.

export const CONTEXTS_KEY = "digest_contexts";

// Trusted enough to be read as an instruction: the same bar as the digest.
export const TRUSTED_SQL = `coalesce(metadata->>'lifecycle', 'current') = 'current'
        AND coalesce(metadata->>'review_status', 'confirmed') = 'confirmed'
        AND coalesce(metadata->>'can_use_as_instruction', 'true') = 'true'`;

const BY_PIN_OR_KIND = `(metadata->>'pinned' = 'true'
             OR (metadata->>'kind' IN ('preference', 'profile') AND coalesce(metadata->>'pinned', '') <> 'false'))`;

const NAMES_CONTEXT = (idSql) =>
  `(jsonb_typeof(metadata->'contexts') = 'array' AND metadata->'contexts' ? ${idSql})`;

// In a context: named in `contexts`, or a standing memory of one of its projects.
export const CONTEXT_MEMBER_SQL = (idArg, projectsArg) => `${TRUSTED_SQL}
        AND (${NAMES_CONTEXT(`$${idArg}`)}
             OR (metadata->>'project' = ANY($${projectsArg}::text[]) AND ${BY_PIN_OR_KIND}))`;

// Held by some confirmed context, and so not in the base. Read from
// app_settings in the query itself, so every place that filters on the digest
// (the digest, the Memories filter, the statistics count) agrees without each
// having to load the contexts first.
export const SCOPED_SQL = `EXISTS (
          SELECT 1 FROM app_settings s, jsonb_each(s.value::jsonb) c
           WHERE s.key = '${CONTEXTS_KEY}' AND c.value->>'status' = 'confirmed'
             AND (${NAMES_CONTEXT("c.key")}
                  OR (jsonb_typeof(c.value->'projects') = 'array'
                      AND c.value->'projects' ? coalesce(metadata->>'project', ''))))`;

export const BASE_DIGEST_SQL = `${TRUSTED_SQL}
        AND ${BY_PIN_OR_KIND}
        AND NOT ${SCOPED_SQL}`;
