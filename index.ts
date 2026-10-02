import path from "path";
import fs from "fs";
import { Plugin } from "@opencode/plugin";
import { searchKeyword } from "./src/search/keyword";
import { searchFuzzy } from "./src/search/fuzzy";
import { parseDateFilter, filterByDate } from "./src/search/date-filter";
import { traceFile } from "./src/search/file-trace";
import { searchMultiterm } from "./src/search/multiterm-sql";
import { dbExists, getDbPath } from "./src/storage-sqlite";
import { jsonStorageExists } from "./src/storage-provider";
import {
  formatResults,
  formatTraceResults,
  formatMultitermResults,
} from "./src/format";
import type { ProjectFilter } from "./src/storage-sqlite";

interface HistorySearchArgs {
  query?: string;
  terms?: string[];
  filePath?: string;
  searchAllProjects?: boolean;
  mode?: "keyword" | "fuzzy";
  regex?: boolean;
  caseSensitive?: boolean;
  fuzzyThreshold?: number;
  date?: string;
  limit?: number;
  role?: "user" | "assistant";
}

/**
 * Walk up from `dir` looking for a `.git` entry (directory or file).
 * Mirrors how V2 derives project ids: git worktrees get the repo's root
 * commit hash, non-git directories get their own project id.
 */
function hasGitRoot(dir: string): boolean {
  let d = dir;
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(d, ".git"))) return true;
    } catch {
      return false;
    }
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  return false;
}

/**
 * Cap for searches that must run unbounded before a date filter is applied.
 * Bounding the scan keeps worst-case cost finite while guaranteeing the date
 * filter sees enough candidates that `limit` + `date` cannot starve it.
 */
const PRE_FILTER_LIMIT = 10_000;

/**
 * Apply the user's limit AFTER date filtering, so date + limit returns the
 * newest `limit` results within the date range.
 */
function applyLimit<T>(results: T[], limit?: number): T[] {
  return limit && limit > 0 ? results.slice(0, limit) : results;
}

export default Plugin.define({
  id: "opencode-history-search-v2",

  async setup(ctx) {
    const locationProjectID: string = ctx.location.project.id;
    const inGit = hasGitRoot(ctx.location.directory);

    // Non-git locations: V2-era sessions live under the location's own
    // project id, but every pre-migration session (V1 era, and early V2
    // before per-directory projects existed) lives under the legacy
    // "global" project. Search both so "current project only" covers the
    // full history, matching what the V1 plugin searched.
    const resolveProject = (allProjects: boolean): ProjectFilter => {
      if (allProjects) return null;
      return inGit ? [locationProjectID] : [locationProjectID, "global"];
    };

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "history_search",
        description: `Search through past conversation histories. Use searchAllProjects=true to search ALL projects on this machine. Searches session titles, message content, tool invocations, and file paths.

THREE SEARCH MODES:
1. SINGLE-TERM (query): Pass query for one search term. Returns per-part matches. Use mode: "fuzzy" for typos, regex: true for patterns.
2. MULTI-TERM AND (terms): Pass terms: ["term1", "term2", ...] to find sessions containing ALL terms anywhere in the session (across title, messages, tools, file paths). Returns one result per session with per-term excerpts. Use when the user remembers multiple concepts (e.g., "find sessions about truck, vertex, and gemini"). Requires 2+ terms.
3. FILE TRACE (filePath): Pass filePath to find which sessions created or modified a specific file.

Supports keyword search, regex patterns, fuzzy search, multi-term AND search, date filtering, and role filtering.`,

        input: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search query (keyword, regex pattern, or fuzzy search term). Required unless filePath or terms is provided.",
            },
            terms: {
              type: "array",
              items: { type: "string" },
              description:
                'Array of terms for multi-term AND search. Returns sessions containing ALL terms anywhere in the session (title, messages, tools, file paths). Use when the user wants sessions matching multiple concepts (e.g., ["truck", "vertex", "gemini"]). Requires 2+ terms for multi-term path; 1 term falls back to single-term query. Case-insensitive substring matching.',
            },
            filePath: {
              type: "string",
              description:
                "File path to trace touch history (e.g., 'src/auth.ts'). If provided, query, mode, regex, caseSensitive, fuzzyThreshold, and role are ignored.",
            },
            searchAllProjects: {
              type: "boolean",
              description:
                "Set to true to search ALL projects on this machine across all repositories, not just the current one. Default: false (current repo only). Use when user asks to search globally, across all projects, machine-wide, or everywhere.",
            },
            mode: {
              type: "string",
              enum: ["keyword", "fuzzy"],
              description:
                "Search mode: 'keyword' for exact matches, 'fuzzy' for typo-tolerant matching (default: keyword)",
            },
            regex: {
              type: "boolean",
              description:
                "Treat query as regex pattern (keyword mode only, default: false)",
            },
            caseSensitive: {
              type: "boolean",
              description:
                "Case-sensitive search (keyword mode only, default: false)",
            },
            fuzzyThreshold: {
              type: "number",
              description:
                "Fuzzy match threshold 0.0-1.0 (fuzzy mode only, default: 0.4, lower = stricter)",
            },
            date: {
              type: "string",
              description:
                "Filter by date: 'today', 'yesterday', 'last N days/weeks/months', 'YYYY-MM-DD', 'YYYY-MM', 'YYYY-MM-DD to YYYY-MM-DD'",
            },
            limit: {
              type: "number",
              description:
                "Maximum number of results (default: 50). Applied after date filtering, so date + limit returns the newest results within the date range.",
            },
            role: {
              type: "string",
              enum: ["user", "assistant"],
              description:
                "Filter by message role: 'user' for your messages only, 'assistant' for AI responses only. Ignored if filePath is provided.",
            },
          },
          additionalProperties: false,
        },

        options: { codemode: true },

        execute: async (rawArgs: unknown) => {
          const args: HistorySearchArgs = {
            ...((rawArgs as HistorySearchArgs) ?? {}),
          };

          if (!args.query && !args.filePath && !args.terms) {
            throw new Error(
              "Either 'query', 'terms', or 'filePath' must be provided.",
            );
          }

          // Fresh install / empty history: answer cleanly instead of
          // opening a database that does not exist yet.
          if (!dbExists() && !jsonStorageExists()) {
            return {
              content: `No OpenCode history found yet (no session database at ${getDbPath()} and no legacy JSON storage detected). Once OpenCode has recorded sessions in this data directory, they will be searchable here.`,
            };
          }

          if (args.terms !== undefined) {
            if (!Array.isArray(args.terms) || args.terms.length === 0) {
              throw new Error(
                "'terms' must be a non-empty array of strings.",
              );
            }
            if (args.terms.length === 1) {
              args.query = args.terms[0];
            } else {
              const project = resolveProject(!!args.searchAllProjects);
              let matches = await searchMultiterm(project, args.terms, {
                limit: args.date ? PRE_FILTER_LIMIT : args.limit,
              });
              if (args.date) {
                matches = filterByDate(matches, parseDateFilter(args.date));
                matches = applyLimit(matches, args.limit);
              }
              return { content: formatMultitermResults(matches) };
            }
          }

          const project = resolveProject(!!args.searchAllProjects);

          if (args.filePath) {
            let matches = await traceFile(project, args.filePath, {
              limit: args.date ? PRE_FILTER_LIMIT : args.limit,
            });

            if (args.date) {
              matches = filterByDate(matches, parseDateFilter(args.date));
              matches = applyLimit(matches, args.limit);
            }

            return { content: formatTraceResults(matches) };
          }

          if (!args.query) {
            throw new Error(
              "'query' is required when 'filePath' is not provided.",
            );
          }

          let matches =
            args.mode === "fuzzy"
              ? await searchFuzzy(project, args.query, {
                  threshold: args.fuzzyThreshold,
                  limit: args.date ? PRE_FILTER_LIMIT : args.limit,
                  role: args.role,
                })
              : await searchKeyword(project, args.query, {
                  regex: args.regex,
                  caseSensitive: args.caseSensitive,
                  limit: args.date ? PRE_FILTER_LIMIT : args.limit,
                  role: args.role,
                });

          if (args.date) {
            matches = filterByDate(matches, parseDateFilter(args.date));
            matches = applyLimit(matches, args.limit);
          }

          return { content: formatResults(matches) };
        },
      });
    });
  },
});
