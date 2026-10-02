import { Database } from "bun:sqlite";
import { getDbPath } from "./paths";
import type { Session, Message, Part } from "./storage";

export { getDbPath } from "./paths";

/**
 * OpenCode V2 SQLite backend.
 *
 * V2 stores live sessions in the `session_v2` and `session_message` tables of
 * `~/.local/share/opencode/opencode.db`. The legacy V1 `session`/`message`/`part`
 * tables are a frozen copy (pre-migration); `session_v2` already contains every
 * legacy session id, so reading the V2 tables covers all eras.
 *
 * Message rows carry their parts inline:
 *   user:      { time, text, files? }
 *   assistant: { time, agent, model, content: [ {type:"text"|"tool"|"reasoning"|...} ] }
 */

/** A single project id, a list of project ids (e.g. current + legacy "global"),
 *  or null for "all projects". */
export type ProjectFilter = string | string[] | null;

export function dbExists(): boolean {
  try {
    return Bun.file(getDbPath()).size > 0;
  } catch {
    return false;
  }
}

function openDb(): Database {
  const db = new Database(getDbPath(), { readonly: true });
  // Schema-drift guard: if a future OpenCode renames the V2 tables, fail
  // with an actionable message instead of a raw SQL error.
  const tables = db
    .query(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('session_v2', 'session_message')`,
    )
    .all() as Array<{ name: string }>;
  if (tables.length < 2) {
    db.close();
    throw new Error(
      `OpenCode history database at ${getDbPath()} does not contain the expected V2 tables (session_v2, session_message). This OpenCode version may use an unsupported schema.`,
    );
  }
  return db;
}

/** Build a SQL project filter fragment plus its bind values. */
export function projectFilterParts(
  filter: ProjectFilter,
  alias = "s",
): { clause: string; binds: string[] } {
  if (filter === null) return { clause: "", binds: [] };
  const ids = Array.isArray(filter) ? filter : [filter];
  const placeholders = ids.map(() => "?").join(", ");
  return { clause: `AND ${alias}.project_id IN (${placeholders})`, binds: ids };
}

export async function* listSessionsSqlite(
  projectID: ProjectFilter,
  db?: Database,
): AsyncGenerator<Session> {
  const shouldClose = db === undefined;
  const _db = db ?? openDb();
  try {
    const { clause, binds } = projectFilterParts(projectID);
    const rows = _db
      .query(
        `SELECT s.id, s.project_id, s.title, s.directory, s.time_created, s.time_updated
         FROM session_v2 s
         WHERE 1=1 ${clause}
         ORDER BY time_updated DESC`,
      )
      .all(...binds) as Array<{
      id: string;
      project_id: string;
      title: string | null;
      directory: string;
      time_created: number;
      time_updated: number;
    }>;

    for (const row of rows) {
      yield {
        id: row.id,
        projectID: row.project_id,
        title: row.title || "",
        directory: row.directory,
        time: { created: row.time_created, updated: row.time_updated },
      };
    }
  } finally {
    if (shouldClose) _db.close();
  }
}

export async function* listMessagesSqlite(
  sessionID: string,
  role?: "user" | "assistant",
  db?: Database,
): AsyncGenerator<Message> {
  const shouldClose = db === undefined;
  const _db = db ?? openDb();
  try {
    const rows = _db
      .query(
        `SELECT id, session_id, type, seq, time_created, data
         FROM session_message WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionID) as Array<{
      id: string;
      session_id: string;
      type: string;
      seq: number;
      time_created: number;
      data: string;
    }>;

    for (const row of rows) {
      // Only user/assistant messages carry searchable conversation content.
      // (idle, compaction, synthetic, system, agent-switched are skipped.)
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (role && row.type !== role) continue;

      let data: any;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }

      yield {
        id: row.id,
        sessionID: row.session_id,
        role: row.type,
        agent: data.agent || "",
        time: { created: row.time_created },
      };
    }
  } finally {
    if (shouldClose) _db.close();
  }
}

/** Normalize a V2 tool part's `state.content` (string or structured) to text. */
function toolOutputText(state: any): string {
  if (state == null) return "";
  if (typeof state.content === "string") return state.content;
  if (state.content !== undefined) {
    try {
      return JSON.stringify(state.content);
    } catch {
      return "";
    }
  }
  return "";
}

export async function* listPartsSqlite(
  messageID: string,
  db?: Database,
): AsyncGenerator<Part> {
  const shouldClose = db === undefined;
  const _db = db ?? openDb();
  try {
    const row = _db
      .query(
        `SELECT id, session_id, type, data
         FROM session_message WHERE id = ?`,
      )
      .get(messageID) as
      | { id: string; session_id: string; type: string; data: string }
      | null;

    if (!row) return;

    let data: any;
    try {
      data = JSON.parse(row.data);
    } catch {
      return;
    }

    if (row.type === "user") {
      // User content is a flat text field (plus optional file attachments).
      if (typeof data.text === "string" && data.text) {
        yield {
          id: `${row.id}#text`,
          messageID: row.id,
          sessionID: row.session_id,
          type: "text",
          text: data.text,
        };
      }
      return;
    }

    if (row.type !== "assistant") return;

    const content = Array.isArray(data.content) ? data.content : [];
    for (let i = 0; i < content.length; i++) {
      const p = content[i];
      if (!p || typeof p !== "object") continue;

      if (p.type === "text" && typeof p.text === "string" && p.text) {
        yield {
          id: `${row.id}#text${i}`,
          messageID: row.id,
          sessionID: row.session_id,
          type: "text",
          text: p.text,
        };
      } else if (p.type === "tool") {
        const state = p.state || {};
        const errorText =
          state.error && typeof state.error.message === "string"
            ? state.error.message
            : state.error
              ? JSON.stringify(state.error)
              : "";
        yield {
          id: typeof p.id === "string" ? p.id : `${row.id}#tool${i}`,
          messageID: row.id,
          sessionID: row.session_id,
          type: "tool",
          tool: typeof p.name === "string" ? p.name : undefined,
          state: {
            input: state.input,
            output: toolOutputText(state) + (errorText ? `\n${errorText}` : ""),
            title: state.title,
          },
        };
      } else if (p.type === "patch" && Array.isArray(p.files)) {
        yield {
          id: `${row.id}#patch${i}`,
          messageID: row.id,
          sessionID: row.session_id,
          type: "patch",
          files: p.files.filter((f: any) => typeof f === "string"),
        };
      }
      // reasoning, step-start, step-finish, compaction, file, subtask, etc.
      // are not searched (matches V1 behaviour, which skipped reasoning parts).
    }
  } finally {
    if (shouldClose) _db.close();
  }
}
