// Shared set-up for the tests that need a real Postgres. Each test file gets a
// database of its own, built from db/init.sql exactly as a fresh install would
// be, so files that count rows can run side by side without seeing each
// other's fixtures. TEST_DATABASE_URL must name a role allowed to create
// databases; a throwaway pgvector container is the intended target:
//
//   docker run -d --name mimers-test-db -e POSTGRES_USER=mimer -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=valv -p 55432:5432 pgvector/pgvector:pg17
//   TEST_DATABASE_URL=postgres://mimer:test@localhost:55432/valv npm test

import pg from "pg";
import { readFile } from "node:fs/promises";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const skipWithoutDatabase = !testDatabaseUrl && "set TEST_DATABASE_URL to a disposable Postgres";

export async function freshDatabase(name) {
  const admin = new pg.Client({ connectionString: testDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(await readFile(new URL("../../db/init.sql", import.meta.url), "utf8"));
  } finally {
    await client.end();
  }
  return url.toString();
}

// A unit vector at `degrees` in the first two dimensions. The cosine similarity
// of two of them is cos(a - b), which lets a test place memories at exactly the
// similarity it needs.
export function vectorAt(degrees) {
  const radians = (degrees * Math.PI) / 180;
  const out = new Array(1536).fill(0);
  out[0] = Math.cos(radians);
  out[1] = Math.sin(radians);
  return out;
}

export const degreesFor = (similarity) => (Math.acos(similarity) * 180) / Math.PI;
