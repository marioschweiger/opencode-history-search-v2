import path from "path";
import os from "os";
import fs from "fs";

/**
 * Cross-platform resolution of OpenCode's data directory and session
 * database file. Mirrors the logic in the OpenCode binary itself:
 *
 *   data dir:  $XDG_DATA_HOME (any platform)
 *              darwin:  ~/Library/Application Support
 *              linux:   ~/.local/share
 *              win32:   %LOCALAPPDATA%
 *   then the "opencode" subdirectory.
 *
 *   db file:   $OPENCODE_DB (absolute path or file name, overrides)
 *              else `opencode.db`
 *              else the newest `opencode-<channel>.db` in the data dir
 *              (OpenCode names the DB per channel on versioned installs)
 *              else `opencode.db` (may not exist yet; callers handle it)
 */

export function getDataDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "opencode");
  switch (platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "opencode",
      );
    case "win32": {
      const local =
        env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      return path.join(local, "opencode");
    }
    default:
      return path.join(os.homedir(), ".local", "share", "opencode");
  }
}

export function resolveDbFile(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.OPENCODE_DB;
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.join(dataDir, override);
  }

  const stable = path.join(dataDir, "opencode.db");
  if (fs.existsSync(stable)) return stable;

  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return stable;
  }

  let best: string | null = null;
  let bestMtime = 0;
  for (const name of entries) {
    if (!/^opencode-[^/\\]+\.db$/.test(name)) continue;
    const full = path.join(dataDir, name);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = full;
      }
    } catch {
      // unreadable entry, skip
    }
  }
  return best ?? stable;
}

export function getDbPath(): string {
  return resolveDbFile(getDataDir());
}
