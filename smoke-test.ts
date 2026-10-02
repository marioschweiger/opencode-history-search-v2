/**
 * Local smoke test: load the plugin, mock the V2 plugin context, and run the
 * real execute() against the live OpenCode database.
 * Run: bun run smoke-test.ts
 * The context below is a mock; adjust the search terms to sessions on your
 * machine to see real results.
 */
import plugin from "./index";

const captured: { tool: any } = {};

const ctx: any = {
  location: {
    directory: "/home/user",
    project: {
      id: "0000000000000000000000000000000000000000",
      directory: "/home/user",
      canonical: "/home/user",
    },
  },
  tool: {
    transform: async (cb: any) => {
      cb({
        add: (t: any) => {
          captured.tool = t;
        },
        list: () => [],
        get: () => undefined,
        namespace: () => {},
        update: () => {},
        remove: () => {},
      });
      return { dispose: async () => {} };
    },
  },
};

const start = Date.now();
await plugin.setup(ctx);
console.log(`setup ok in ${Date.now() - start}ms; tool = ${captured.tool?.name}`);

const tool = captured.tool;
const context = {
  signal: new AbortController().signal,
  progress: async () => {},
  sessionID: "smoke",
  agent: "build",
  messageID: "smoke",
  id: "smoke",
};

async function run(label: string, input: any) {
  const t0 = Date.now();
  try {
    const result = await tool.execute(input, context);
    const text: string = result.content ?? "";
    console.log(`\n===== ${label} (${Date.now() - t0}ms, ${text.length} chars)`);
    console.log(text.slice(0, 700));
  } catch (e: any) {
    console.log(`\n===== ${label} (${Date.now() - t0}ms) ERROR: ${e?.message ?? e}`);
  }
}

// 1. Keyword, all projects
await run("keyword all-projects (kernel)", {
  query: "kernel",
  searchAllProjects: true,
  limit: 4,
});

// 2. Keyword, current non-git project (must cover legacy "global" sessions)
await run("keyword current-project legacy (config)", { query: "config", limit: 4 });

// 3. Multi-term AND
await run(
  "multiterm (opencode + history)",
  { terms: ["opencode", "history"], searchAllProjects: true, limit: 4 },
);

// 4. Single-term fallback
await run("single-term fallback (terms=[example])", {
  terms: ["example"],
  searchAllProjects: true,
  limit: 3,
});

// 5. File trace (path touched by write/edit tools in past sessions)
await run("file trace (src/example.ts)", { filePath: "src/example.ts", limit: 5 });

// 6. Fuzzy
await run("fuzzy (refactur)", { query: "refactur", mode: "fuzzy", limit: 3 });

// 7. Date filter
await run(
  "date filter (last 3 days)",
  { query: "opencode", searchAllProjects: true, date: "last 3 days", limit: 3 },
);

// 8. Error case
await run("error (no args)", {});

console.log("\ndone");
process.exit(0);
