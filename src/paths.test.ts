import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { getDataDir, resolveDbFile } from "./paths";

describe("getDataDir", () => {
  test("XDG_DATA_HOME wins on every platform", () => {
    expect(getDataDir("linux", { XDG_DATA_HOME: "/xdg" })).toBe(
      path.join("/xdg", "opencode"),
    );
    expect(getDataDir("darwin", { XDG_DATA_HOME: "/xdg" })).toBe(
      path.join("/xdg", "opencode"),
    );
    expect(getDataDir("win32", { XDG_DATA_HOME: "C:\\xdg" })).toBe(
      path.join("C:\\xdg", "opencode"),
    );
  });

  test("linux default is ~/.local/share/opencode", () => {
    expect(getDataDir("linux", {})).toBe(
      path.join(os.homedir(), ".local", "share", "opencode"),
    );
  });

  test("darwin default is ~/Library/Application Support/opencode", () => {
    expect(getDataDir("darwin", {})).toBe(
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "opencode",
      ),
    );
  });

  test("win32 uses %LOCALAPPDATA%\\opencode", () => {
    expect(
      getDataDir("win32", { LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local" }),
    ).toBe(path.join("C:\\Users\\m\\AppData\\Local", "opencode"));
  });

  test("win32 without LOCALAPPDATA falls back to homedir", () => {
    expect(getDataDir("win32", {})).toBe(
      path.join(os.homedir(), "AppData", "Local", "opencode"),
    );
  });

  test("unknown platform falls back to the XDG-style path", () => {
    expect(getDataDir("freebsd", {})).toBe(
      path.join(os.homedir(), ".local", "share", "opencode"),
    );
  });
});

describe("resolveDbFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hs-paths-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("prefers opencode.db when present", () => {
    const stable = path.join(dir, "opencode.db");
    fs.writeFileSync(stable, "x");
    const channel = path.join(dir, "opencode-2.0.21.db");
    fs.writeFileSync(channel, "x");
    expect(resolveDbFile(dir, {})).toBe(stable);
  });

  test("picks the newest opencode-*.db by mtime when stable is absent", () => {
    const older = path.join(dir, "opencode-2.0.10.db");
    const newer = path.join(dir, "opencode-2.0.21.db");
    fs.writeFileSync(older, "x");
    fs.writeFileSync(newer, "x");
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(older, past, past);
    expect(resolveDbFile(dir, {})).toBe(newer);
  });

  test("OPENCODE_DB override with absolute path", () => {
    expect(resolveDbFile(dir, { OPENCODE_DB: "/elsewhere/custom.db" })).toBe(
      "/elsewhere/custom.db",
    );
  });

  test("OPENCODE_DB override with bare file name resolves inside data dir", () => {
    expect(resolveDbFile(dir, { OPENCODE_DB: "custom.db" })).toBe(
      path.join(dir, "custom.db"),
    );
  });

  test("missing data dir falls back to the stable name", () => {
    const missing = path.join(os.tmpdir(), "hs-does-not-exist-xyz");
    expect(resolveDbFile(missing, {})).toBe(
      path.join(missing, "opencode.db"),
    );
  });

  test("ignores files that are not channel DBs", () => {
    fs.writeFileSync(path.join(dir, "opencode.db-journal"), "x");
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    fs.writeFileSync(path.join(dir, "opencode-foo.db.bak"), "x");
    expect(resolveDbFile(dir, {})).toBe(path.join(dir, "opencode.db"));
  });
});
