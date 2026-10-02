import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  listSessionsSqlite,
  listMessagesSqlite,
  listPartsSqlite,
  projectFilterParts,
} from "./storage-sqlite";

const now = 1750000000000;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

function seed(db: Database) {
  db.run(
    `INSERT INTO session_v2 VALUES
      ('ses_a', 'proj_git', '/repo', 'Git session', ${now}, ${now}),
      ('ses_b', 'global', '/home', 'Legacy session', ${now - 1000}, ${now - 1000}),
      ('ses_c', 'proj_other', '/other', 'Other session', ${now - 2000}, ${now - 2000})`,
  );
  db.run(`
    INSERT INTO session_message VALUES
      ('msg_u', 'ses_a', 'user', 0, ${now}, '{"text":"hello world","time":{"created":${now}}}'),
      ('msg_idle', 'ses_a', 'idle', 1, ${now}, '{}'),
      ('msg_compact', 'ses_a', 'compaction', 2, ${now}, '{}'),
      ('msg_asst', 'ses_a', 'assistant', 3, ${now}, '{"agent":"build","model":{"id":"m"},"content":[
        {"type":"text","text":"the answer"},
        {"type":"reasoning","text":"thinking about it"},
        {"type":"tool","id":"tool_1","name":"write","state":{"status":"completed","input":{"path":"/tmp/x.txt"},"content":"ok"}},
        {"type":"tool","id":"tool_2","name":"shell","state":{"status":"error","input":{"command":"ls"},"error":{"type":"unknown","message":"boom"}}},
        {"type":"patch","files":["/a.ts",123]}
      ]}'),
      ('msg_u2', 'ses_b', 'user', 0, ${now}, '{"text":"legacy text"}')
  `);
}

describe("projectFilterParts", () => {
  test("null filter produces no clause", () => {
    expect(projectFilterParts(null)).toEqual({ clause: "", binds: [] });
  });

  test("single id produces IN with one placeholder", () => {
    expect(projectFilterParts("abc")).toEqual({
      clause: "AND s.project_id IN (?)",
      binds: ["abc"],
    });
  });

  test("id list produces IN with one placeholder per id", () => {
    expect(projectFilterParts(["a", "b"], "t")).toEqual({
      clause: "AND t.project_id IN (?, ?)",
      binds: ["a", "b"],
    });
  });
});

describe("listSessionsSqlite", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seed(db);
  });
  afterEach(() => db.close());

  async function collect(filter: string | string[] | null) {
    const out: string[] = [];
    for await (const s of listSessionsSqlite(filter, db)) out.push(s.id);
    return out;
  }

  test("no filter returns all sessions ordered by time_updated desc", async () => {
    expect(await collect(null)).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  test("single project id filters", async () => {
    expect(await collect("global")).toEqual(["ses_b"]);
  });

  test("id list filters (current + legacy global)", async () => {
    expect(await collect(["proj_git", "global"])).toEqual(["ses_a", "ses_b"]);
  });

  test("unknown project id returns nothing", async () => {
    expect(await collect("missing")).toEqual([]);
  });
});

describe("listMessagesSqlite", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seed(db);
  });
  afterEach(() => db.close());

  async function collect(sessionID: string, role?: "user" | "assistant") {
    const out: Array<{ id: string; role: string; agent: string }> = [];
    for await (const m of listMessagesSqlite(sessionID, role, db)) {
      out.push({ id: m.id, role: m.role, agent: m.agent });
    }
    return out;
  }

  test("returns user and assistant messages in seq order, skips non-conversation types", async () => {
    expect(await collect("ses_a")).toEqual([
      { id: "msg_u", role: "user", agent: "" },
      { id: "msg_asst", role: "assistant", agent: "build" },
    ]);
  });

  test("role filter", async () => {
    expect((await collect("ses_a", "user")).map((m) => m.id)).toEqual([
      "msg_u",
    ]);
  });

  test("missing session returns nothing", async () => {
    expect(await collect("ses_none")).toEqual([]);
  });
});

describe("listPartsSqlite", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seed(db);
  });
  afterEach(() => db.close());

  async function collect(messageID: string) {
    const out: any[] = [];
    for await (const p of listPartsSqlite(messageID, db)) out.push(p);
    return out;
  }

  test("user message yields a single text part with the real session id", async () => {
    const parts = await collect("msg_u");
    expect(parts).toEqual([
      {
        id: "msg_u#text",
        messageID: "msg_u",
        sessionID: "ses_a",
        type: "text",
        text: "hello world",
      },
    ]);
  });

  test("assistant message yields text, tools and patch parts; skips reasoning", async () => {
    const parts = await collect("msg_asst");
    expect(parts.map((p) => p.type)).toEqual(["text", "tool", "tool", "patch"]);
    expect(parts[0].text).toBe("the answer");
    expect(parts[0].sessionID).toBe("ses_a");
  });

  test("completed tool part normalises state.content to output string", async () => {
    const parts = await collect("msg_asst");
    const write = parts.find((p: any) => p.tool === "write");
    expect(write.id).toBe("tool_1");
    expect(write.state.output).toBe("ok");
    expect(write.state.input).toEqual({ path: "/tmp/x.txt" });
  });

  test("errored tool part appends error message to output", async () => {
    const parts = await collect("msg_asst");
    const shell = parts.find((p: any) => p.tool === "shell");
    expect(shell.state.output).toBe("\nboom");
  });

  test("patch part keeps only string file entries", async () => {
    const parts = await collect("msg_asst");
    const patch = parts.find((p: any) => p.type === "patch");
    expect(patch.files).toEqual(["/a.ts"]);
  });

  test("unknown message id yields nothing", async () => {
    expect(await collect("msg_none")).toEqual([]);
  });
});
