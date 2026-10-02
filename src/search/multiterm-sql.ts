import { getDbPath, projectFilterParts, type ProjectFilter } from "../storage-sqlite";

export interface MultitermSqlOptions {
  limit: number;
}

export interface MultitermSqlResult {
  sql: string;
  binds: any[];
}

export interface MultitermSearchMatch {
  sessionID: string;
  sessionTitle: string;
  timestamp: number;
  projectDirectory: string;
  termHits: Map<string, { partID: string; matchType: string; excerpt: string }>;
}

/**
 * Multi-term AND search over OpenCode V2 history.
 *
 * V2 schema: sessions in `session_v2`, message content (including tool calls
 * and file paths) embedded in `session_message.data`.
 */

export function buildMultitermSql(
  terms: string[],
  projectID: ProjectFilter,
  options: MultitermSqlOptions,
): MultitermSqlResult {
  if (terms.length === 0) {
    throw new Error("terms array must contain at least one term");
  }

  const conditions = terms
    .map(
      (_, i) =>
        `MAX(CASE WHEN m.data LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS match_${i}`,
    )
    .join(", ");

  const having = terms
    .map((_, i) => `match_${i} = 1`)
    .join(" AND ");

  const { clause, binds: projectBinds } = projectFilterParts(projectID);

  const sql = `
    SELECT s.id AS session_id, s.title, s.directory, s.time_updated, ${conditions}
    FROM session_v2 s
    JOIN session_message m ON m.session_id = s.id
    WHERE 1=1
      ${clause}
    GROUP BY s.id
    HAVING ${having}
    ORDER BY s.time_updated DESC
    LIMIT ${options.limit}
  `.trim();

  const binds: any[] = [];
  for (const term of terms) {
    const escaped = term.replace(/[%_\\]/g, "\\$&");
    binds.push(`%${escaped}%`);
    binds.push(`%${escaped}%`);
  }
  binds.push(...projectBinds);

  return { sql, binds };
}

export async function searchMultiterm(
  projectID: ProjectFilter,
  terms: string[],
  options?: { limit?: number },
): Promise<MultitermSearchMatch[]> {
  const { Database } = await import("bun:sqlite");
  const dbPath = getDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    const { sql, binds } = buildMultitermSql(terms, projectID, {
      limit: options?.limit ?? 50,
    });

    type Row = {
      session_id: string;
      title: string | null;
      directory: string;
      time_updated: number;
    };

    const rows = db.query(sql).all(...binds) as Row[];

    if (rows.length === 0) {
      return [];
    }

    // Phase 2: load the matched sessions' messages once and locate a
    // per-term excerpt (first occurrence, ±50 chars) in JavaScript.
    const sessionIDs = rows.map((r) => r.session_id);
    const placeholders = sessionIDs.map(() => "?").join(",");
    const followRows = db
      .query(
        `SELECT session_id, id AS message_id, data
         FROM session_message
         WHERE session_id IN (${placeholders})
           AND (type = 'user' OR type = 'assistant')
         ORDER BY time_created ASC`,
      )
      .all(...sessionIDs) as Array<{
      session_id: string;
      message_id: string;
      data: string;
    }>;

    const messagesBySession = new Map<string, Array<{ id: string; data: string }>>();
    for (const row of followRows) {
      if (!messagesBySession.has(row.session_id)) {
        messagesBySession.set(row.session_id, []);
      }
      messagesBySession.get(row.session_id)!.push({ id: row.message_id, data: row.data });
    }

    const termHitsBySession = new Map<
      string,
      Map<string, { partID: string; matchType: string; excerpt: string }>
    >();

    for (const sessionID of sessionIDs) {
      const sessionMap = new Map<
        string,
        { partID: string; matchType: string; excerpt: string }
      >();
      termHitsBySession.set(sessionID, sessionMap);

      const messages = messagesBySession.get(sessionID) ?? [];
      for (const message of messages) {
        if (sessionMap.size >= terms.length) break;
        const lower = message.data.toLowerCase();
        for (const term of terms) {
          if (sessionMap.size >= terms.length) break;
          if (sessionMap.has(term)) continue;
          const termLower = term.toLowerCase();
          const idx = lower.indexOf(termLower);
          if (idx === -1) continue;
          const start = Math.max(0, idx - 50);
          const end = Math.min(
            message.data.length,
            idx + termLower.length + 50,
          );
          sessionMap.set(term, {
            partID: message.id,
            matchType: "data",
            excerpt: message.data.slice(start, end),
          });
        }
      }
    }

    return rows.map((row) => ({
      sessionID: row.session_id,
      sessionTitle: row.title || "",
      timestamp: row.time_updated,
      projectDirectory: row.directory,
      termHits: termHitsBySession.get(row.session_id) ?? new Map(),
    }));
  } finally {
    db.close();
  }
}
