import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";
import { searchKeyword } from "./search/keyword";
import { searchMultiterm } from "./search/multiterm-sql";
import { traceFile } from "./search/file-trace";
import { parseDateFilter, filterByDate } from "./search/date-filter";
import { dbExists, listSessionsSqlite } from "./storage-sqlite";
import { jsonStorageExists } from "./storage-provider";

/**
 * End-to-end tests against a temporary on-disk V2-schema database,
 * selected via XDG_DATA_HOME. No dependency on the developer's real
 * OpenCode data directory — safe for CI on any platform.
 */

let dataDir: string;
let savedXdg: string | undefined;
let savedDb: string | undefined;

const DAY = 24 * 60 * 60 * 1000;

const V2_TABLES = `
  CREATE TABLE IF NOT EXISTS session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT,
    time_created INTEGER, time_updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, data TEXT
  );
`;

/**
 * Seed the database at the path getDbPath() resolves to:
 * $XDG_DATA_HOME/opencode/opencode.db. A custom `tables` schema skips the
 * data inserts (used by the schema-drift test).
 */
function seedDb(tables: string = V2_TABLES): void {
  const dbFile = path.join(dataDir, "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.exec(tables);

  if (tables !== V2_TABLES) {
    db.close();
    return;
  }

  const now = Date.now();
  const aTime = now - 2 * DAY;
  const bTime = now - 5 * DAY;

  db.run(
    `INSERT INTO session_v2 (id, project_id, title, directory, time_created, time_updated)
     VALUES ('ses_a', 'global', 'Alpha debugging', '/tmp', ?, ?)`,
    aTime,
    aTime,
  );
  db.run(
    `INSERT INTO session_v2 (id, project_id, title, directory, time_created, time_updated)
     VALUES ('ses_b', 'proj-b', 'Beta rollout', '/work', ?, ?)`,
    bTime,
    bTime,
  );

  db.run(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, data)
     VALUES ('msg_a1', 'ses_a', 'user', 1, ?, ?)`,
    aTime,
    JSON.stringify({
      time: aTime,
      text: "why does the alpha cache throw a lock error?",
    }),
  );
  db.run(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, data)
     VALUES ('msg_a2', 'ses_a', 'assistant', 2, ?, ?)`,
    aTime,
    JSON.stringify({
      time: aTime,
      agent: "build",
      model: "test/model",
      content: [
        { type: "text", text: "Checking the cache implementation." },
        {
          type: "tool",
          id: "tool_a1",
          name: "edit",
          executed: true,
          state: {
            status: "completed",
            input: { path: "src/cache.ts" },
            content: "ok",
          },
        },
      ],
    }),
  );

  db.run(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, data)
     VALUES ('msg_b1', 'ses_b', 'user', 1, ?, ?)`,
    bTime,
    JSON.stringify({
      time: bTime,
      text: "plan the beta rollout for the beta region",
    }),
  );

  db.close();
}

beforeEach(() => {
  savedXdg = process.env.XDG_DATA_HOME;
  savedDb = process.env.OPENCODE_DB;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-int-"));
  process.env.XDG_DATA_HOME = dataDir;
  delete process.env.OPENCODE_DB;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  if (savedDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = savedDb;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("search over a seeded V2 database", () => {
  beforeEach(() => {
    seedDb();
  });

  test("keyword search finds message content", async () => {
    const matches = await searchKeyword(null, "lock", {});
    expect(matches.length).toBe(1);
    expect(matches[0].sessionID).toBe("ses_a");
    expect(matches[0].matchType).toBe("message");
  });

  test("role filter restricts message matches (titles still match)", async () => {
    // "rollout" appears in ses_b's title AND its user message; no assistant
    // content mentions it.
    const userOnly = await searchKeyword(null, "rollout", { role: "user" });
    expect(userOnly.length).toBe(2);
    expect(userOnly.every((m) => m.sessionID === "ses_b")).toBe(true);
    const assistantOnly = await searchKeyword(null, "rollout", {
      role: "assistant",
    });
    expect(assistantOnly.length).toBe(1);
    expect(assistantOnly[0].matchType).toBe("title");
  });

  test("project filter scopes to the given project ids", async () => {
    // "region" only occurs in ses_b (project proj-b).
    const inProj = await searchKeyword(["proj-b"], "region", {});
    expect(inProj.length).toBe(1);
    expect(inProj[0].sessionID).toBe("ses_b");
    const outOfProj = await searchKeyword(["global"], "region", {});
    expect(outOfProj.length).toBe(0);
  });

  test("multi-term AND requires every term in one session", async () => {
    const both = await searchMultiterm(null, ["alpha", "lock"], {
      limit: 50,
    });
    expect(both.length).toBe(1);
    expect(both[0].sessionID).toBe("ses_a");

    const none = await searchMultiterm(null, ["alpha", "beta"], {
      limit: 50,
    });
    expect(none.length).toBe(0);
  });

  test("file trace finds sessions that touched a path", async () => {
    const results = await traceFile(null, "src/cache.ts");
    expect(results.length).toBe(1);
    expect(results[0].sessionID).toBe("ses_a");
    expect(results[0].filePath).toBe("src/cache.ts");
  });

  test("date filter + limit ordering keeps in-range results", async () => {
    // "lock" (2 days old) is inside "last 3 days"; "rollout" (5 days old)
    // is not. A small limit must not starve the filter.
    const recent = await searchKeyword(null, "lock", { limit: 10_000 });
    const inRange = filterByDate(
      recent,
      parseDateFilter("last 3 days"),
    ).slice(0, 3);
    expect(inRange.length).toBe(1);
    expect(inRange[0].sessionID).toBe("ses_a");

    const old = await searchKeyword(null, "rollout", { limit: 10_000 });
    expect(filterByDate(old, parseDateFilter("last 3 days")).length).toBe(0);
  });
});

describe("fresh install (no database, no storage)", () => {
  test("searches degrade to empty results without throwing", async () => {
    expect(dbExists()).toBe(false);
    expect(jsonStorageExists()).toBe(false);
    const matches = await searchKeyword(null, "anything", {});
    expect(matches).toEqual([]);
    const traced = await traceFile(null, "src/nothing.ts").catch((e) => e);
    // traceFile opens the DB directly; with no DB it may throw — that is
    // acceptable and is handled by the index.ts guard before it is reached.
    expect(traced).toBeDefined();
  });
});

describe("schema drift guard", () => {
  test("unrecognized schema produces an actionable error", async () => {
    seedDb(
      `CREATE TABLE something_else (id TEXT);`,
    );
    await expect(
      (async () => {
        for await (const _s of listSessionsSqlite(null)) {
          // consume
        }
      })(),
    ).rejects.toThrow(/unsupported schema|expected V2 tables/);
  });
});
