import path from "path";
import fs from "fs";
import { getDataDir } from "./paths";
import {
  dbExists,
  listSessionsSqlite,
  listMessagesSqlite,
  listPartsSqlite,
  type ProjectFilter,
} from "./storage-sqlite";
import {
  listSessions as listSessionsJSON,
  listMessages as listMessagesJSON,
  listParts as listPartsJSON,
  getStorageDir,
} from "./storage";
import type { Session, Message, Part } from "./storage";

// Evaluated per call (not at module load) so a database created after the
// plugin loaded is picked up without a restart.
function useSqlite(): boolean {
  return dbExists();
}

/** True when the legacy JSON storage directory has any content at all. */
export function jsonStorageExists(): boolean {
  const dir = path.join(getDataDir(), "storage");
  for (const sub of ["session", "message", "part"]) {
    try {
      if (fs.readdirSync(path.join(dir, sub)).length > 0) return true;
    } catch {
      // absent or unreadable, keep looking
    }
  }
  return false;
}

export async function* listSessions(
  projectID: ProjectFilter,
): AsyncGenerator<Session> {
  if (useSqlite()) {
    yield* listSessionsSqlite(projectID);
  } else {
    // JSON fallback only understands a single project id.
    yield* listSessionsJSON(Array.isArray(projectID) ? projectID[0] : projectID);
  }
}

export async function* listMessages(
  sessionID: string,
  role?: "user" | "assistant",
): AsyncGenerator<Message> {
  if (useSqlite()) {
    yield* listMessagesSqlite(sessionID, role);
  } else {
    yield* listMessagesJSON(sessionID, role);
  }
}

export async function* listParts(messageID: string): AsyncGenerator<Part> {
  if (useSqlite()) {
    yield* listPartsSqlite(messageID);
  } else {
    yield* listPartsJSON(messageID);
  }
}

export { getStorageDir };
export type { Session, Message, Part };
export type { ProjectFilter };
