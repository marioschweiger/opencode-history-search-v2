import { getDbPath, projectFilterParts, type ProjectFilter } from "../storage-sqlite";

export interface FileTraceResult {
  sessionID: string;
  sessionTitle: string;
  timestamp: number;
  firstTouch: boolean;
  userPrompt: string | null;
  toolName: string | null;
  filePath: string;
}

export interface TraceFileOptions {
  limit?: number;
}

interface Candidate {
  sessionID: string;
  sessionTitle: string;
  messageID: string;
  timestamp: number;
  toolName: string | null;
  filePath: string;
}

/**
 * Trace which sessions created or modified a file.
 *
 * V2 schema: parts are embedded in `session_message.data`. Assistant tool
 * parts live in `data.content[]` as { type:"tool", name, state:{input} }.
 * New V2 write/edit inputs use `input.path`; migrated legacy parts may keep
 * `input.filePath`. Patch parts carry `files: string[]`.
 */
export async function traceFile(
  projectID: ProjectFilter,
  filePath: string,
  options?: TraceFileOptions,
): Promise<FileTraceResult[]> {
  const { Database } = await import("bun:sqlite");
  const dbPath = getDbPath();
  const db = new Database(dbPath, { readonly: true });
  try {
    const normalizedQuery = filePath.replace(/\\/g, "/");
    const isExactPath = normalizedQuery.includes("/");
    const likePattern = `%${normalizedQuery}%`;

    const { clause, binds } = projectFilterParts(projectID);

    // Broad SQL pre-filter: assistant messages whose JSON payload mentions the
    // path, then exact/basename matching is refined in TypeScript.
    const sql = `
      SELECT
        s.id AS session_id,
        s.title AS session_title,
        m.id AS message_id,
        m.time_created AS message_time,
        m.data AS message_data
      FROM session_v2 s
      JOIN session_message m ON m.session_id = s.id
      WHERE m.type = 'assistant'
        AND m.data LIKE ? ESCAPE '\\'
        ${clause}
      ORDER BY m.time_created DESC
    `;

    const rows = db.query(sql).all(...[likePattern, ...binds]) as Array<{
      session_id: string;
      session_title: string | null;
      message_id: string;
      message_time: number;
      message_data: string;
    }>;

    const candidates: Candidate[] = [];

    for (const row of rows) {
      let data: any;
      try {
        data = JSON.parse(row.message_data);
      } catch {
        continue;
      }

      const content = Array.isArray(data.content) ? data.content : [];
      for (const p of content) {
        if (!p || typeof p !== "object") continue;

        if (p.type === "tool" && (p.name === "write" || p.name === "edit")) {
          const input = p.state?.input || {};
          const touched =
            typeof input.path === "string"
              ? input.path
              : typeof input.filePath === "string"
                ? input.filePath
                : null;
          if (touched && isMatch(touched, normalizedQuery, isExactPath)) {
            candidates.push({
              sessionID: row.session_id,
              sessionTitle: row.session_title || "",
              messageID: row.message_id,
              timestamp: row.message_time,
              toolName: typeof p.name === "string" ? p.name : null,
              filePath: touched,
            });
          }
        } else if (p.type === "patch" && Array.isArray(p.files)) {
          for (const f of p.files) {
            if (typeof f === "string" && isMatch(f, normalizedQuery, isExactPath)) {
              candidates.push({
                sessionID: row.session_id,
                sessionTitle: row.session_title || "",
                messageID: row.message_id,
                timestamp: row.message_time,
                toolName: null,
                filePath: f,
              });
              break;
            }
          }
        }
      }
    }

    // Deduplicate by sessionID + messageID + filePath. SQL is ordered by
    // message_time DESC, so the first occurrence per key wins.
    const seen = new Set<string>();
    const deduped: Candidate[] = [];
    for (const c of candidates) {
      const key = `${c.sessionID}|${c.messageID}|${c.filePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(c);
      }
    }

    // firstTouch = the earliest touch overall.
    let earliestTime = Infinity;
    let earliestIndex = -1;
    for (let i = 0; i < deduped.length; i++) {
      const candidate = deduped[i];
      if (candidate.timestamp < earliestTime) {
        earliestTime = candidate.timestamp;
        earliestIndex = i;
      }
    }

    const findUserPrompt = db.query(
      `SELECT data FROM session_message
       WHERE session_id = ? AND type = 'user' AND time_created < ?
       ORDER BY seq DESC
       LIMIT 1`,
    );

    const limit = options?.limit ?? 50;

    return deduped.slice(0, limit).map((c, idx) => {
      const promptRow = findUserPrompt.get(
        c.sessionID,
        c.timestamp,
      ) as { data: string } | undefined;
      let userPrompt: string | null = null;
      if (promptRow) {
        try {
          userPrompt = JSON.parse(promptRow.data).text || null;
        } catch {
          userPrompt = null;
        }
      }
      return {
        sessionID: c.sessionID,
        sessionTitle: c.sessionTitle,
        timestamp: c.timestamp,
        firstTouch: idx === earliestIndex,
        userPrompt,
        toolName: c.toolName,
        filePath: c.filePath,
      };
    });
  } finally {
    db.close();
  }
}

function isMatch(path: string, query: string, isExact: boolean): boolean {
  if (isExact) {
    return path === query;
  }
  return path === query || path.endsWith(`/${query}`);
}
