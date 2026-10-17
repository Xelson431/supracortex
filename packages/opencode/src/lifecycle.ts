/**
 * Lifecycle: builds the Engine for a session and provides adapters that feed
 * OpenCode-derived data (git changes, skills, MCP servers) into the core.
 *
 * All OpenCode interactions are wrapped in try/catch and fail open: if any data
 * source is unavailable, the engine still works with what it has, and the main
 * coding task is never blocked.
 */

import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  Engine,
  JsonlStore,
  createSqliteStore,
  ensureRuntimeGitignore,
  type Config,
  type GatherInputs,
  type GitChangeSummary,
  type McpServerMetadata,
  type SkillMetadata,
  type StorageAdapter,
  resolveProjectStorageDirectory,
} from "@local/supracortex-core";
import { discoverSkills } from "./skills-discovery.ts";
import { discoverMcpServers } from "./mcp-discovery.ts";

/** Minimal shape of the OpenCode client we rely on. Kept loose on purpose so we
 * never hard-depend on a specific SDK version's exact typings. */
export interface OpencodeClientLike {
  vcs?: {
    status?: (opts?: unknown) => Promise<{ data?: unknown }>;
  };
  find?: {
    files?: (opts: { query: unknown }) => Promise<{ data?: unknown }>;
  };
  mcp?: {
    status?: () => Promise<{ data?: unknown }>;
  };
}

export interface LifecycleContext {
  config: Config;
  projectRoot: string;
  worktree: string;
  pluginVersion: string;
  client?: OpencodeClientLike;
  shell?: (strings: TemplateStringsArray, ...args: unknown[]) => Promise<{ stdout?: string }>;
  /** See `createEngine`: diagnostics-only mode that performs no storage writes. */
  handshakeOnly?: boolean;
}

export async function createStore(config: Config, projectRoot: string): Promise<StorageAdapter> {
  const root = resolveProjectStorageDirectory(projectRoot, config.storage.directory);
  if (config.storage.driver === "sqlite") {
    try {
      return await createSqliteStore(root);
    } catch (cause) {
      // A configured backend is part of the store identity. Falling back after
      // it fails can create an apparently-empty second store and lose writes.
      throw new Error(`Configured SQLite storage could not open: ${cause instanceof Error ? cause.message : "unknown error"}`);
    }
  }
  return new JsonlStore(root);
}

/**
 * Open the configured store without creating or mutating anything on disk.
 *
 * Returns `null` when there is no store to read: the storage root is absent, or
 * SQLite is configured but `state/store.sqlite` is missing. Diagnostics must
 * use this instead of `createStore`, which creates the root/schema.
 *
 * May throw for real I/O or driver errors (permission denied, corrupt or
 * unreadable database, no SQLite runtime); callers decide how to degrade.
 */
export async function createReadOnlyStore(
  config: Config,
  projectRoot: string,
): Promise<StorageAdapter | null> {
  const root = resolveProjectStorageDirectory(projectRoot, config.storage.directory);
  try {
    await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }

  if (config.storage.driver === "sqlite") {
    try {
      await stat(join(root, "state", "store.sqlite"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    return createSqliteStore(root, { readOnly: true });
  }
  // The JSONL constructor is a pure path resolve; it never writes.
  return new JsonlStore(root);
}

export async function createEngine(ctx: LifecycleContext): Promise<Engine> {
  if (ctx.handshakeOnly === true) {
    // Handshake-only exists solely so diagnostics can measure protocol startup
    // without creating storage (no runtime .gitignore, no SQLite root/WAL/DDL).
    // It must never be used for real sessions: the engine is constructed on a
    // pure path-resolved JSONL store and skips the gitignore matcher entirely.
    const store = new JsonlStore(resolveProjectStorageDirectory(ctx.projectRoot, ctx.config.storage.directory));
    return new Engine({
      config: ctx.config,
      store,
      pluginVersion: ctx.pluginVersion,
      projectRoot: ctx.projectRoot,
    });
  }
  // Guard before the adapter is created: SQLite DDL otherwise runs before
  // Engine.initialize() ever gets a chance to write the ignore block. This is a
  // write, so diagnostics must use createReadOnlyStore instead. Fail open so an
  // unwritable storage dir never blocks opening the engine.
  try {
    await ensureRuntimeGitignore(resolveProjectStorageDirectory(ctx.projectRoot, ctx.config.storage.directory));
  } catch {
    /* best-effort */
  }
  const store = await createStore(ctx.config, ctx.projectRoot);
  const isGitIgnored = await buildGitignoreMatcher(ctx.projectRoot);
  return new Engine({
    config: ctx.config,
    store,
    pluginVersion: ctx.pluginVersion,
    projectRoot: ctx.projectRoot,
    ...(isGitIgnored ? { isGitIgnored } : {}),
  });
}

/**
 * Gather OpenCode-derived inputs for a context request. Every source is optional
 * and failures degrade gracefully.
 */
export async function gatherInputs(
  ctx: LifecycleContext,
  targetAgent?: string,
  loadedSkills: string[] = [],
): Promise<GatherInputs> {
  const gather: GatherInputs = { loadedSkills };
  if (targetAgent) gather.targetAgent = targetAgent;

  // These inputs are independent snapshots. Resolve them concurrently so
  // filesystem skill discovery and MCP config inspection don't sit behind the
  // git-status child process (or vice versa) on every automatic context turn.
  const [git, skills, mcp] = await Promise.all([
    safeGitChanges(ctx),
    safe<SkillMetadata[]>(() => discoverSkills(ctx.projectRoot)),
    safe<McpServerMetadata[]>(() => discoverMcpServers(ctx.client)),
  ]);
  if (git) gather.git = git;
  if (skills) gather.skills = skills;
  if (mcp) gather.mcpServers = mcp;

  return gather;
}

async function safeGitChanges(ctx: LifecycleContext): Promise<GitChangeSummary | undefined> {
  // Never use OpenCode's `$` shell callback for this background query: its
  // command/output can be rendered near the chat composer. A direct Node child
  // process is silent and keeps context preparation invisible to the user.
  // Probe for `.git` first so we also avoid spawning git outside a repository.
  try {
    const { stat } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let dir = ctx.projectRoot;
    let foundGit = false;
    // Walk up a few levels: a subdirectory of a repo is still "in" the repo.
    for (let i = 0; i < 8 && dir; i++) {
      try {
        await stat(join(dir, ".git"));
        foundGit = true;
        break;
      } catch {
        const parent = join(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }
    }
    if (!foundGit) return undefined; // not a git repo → skip git entirely
    const { stdout } = await promisify(execFile)("git", ["-C", ctx.projectRoot, "status", "--porcelain=v1", "-b"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return parsePorcelain(stdout);
  } catch {
    return undefined;
  }
}

export function parsePorcelain(out: string): GitChangeSummary {
  const lines = out.split("\n").filter(Boolean);
  const changed: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;
  for (const line of lines) {
    if (line.startsWith("##")) {
      const m = line.match(/^##\s+([^\s.]+)/);
      if (m) branch = m[1];
      continue;
    }
    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();
    if (!file) continue;
    if (x === "?" && y === "?") {
      untracked.push(file);
    } else {
      if (x && x !== " ") staged.push(file);
      changed.push(file);
    }
  }
  const summary: GitChangeSummary = {
    changedFiles: changed,
    staged,
    untracked,
  };
  if (branch) summary.branch = branch;
  return summary;
}

/** Build a simple .gitignore matcher from the project root .gitignore. */
async function buildGitignoreMatcher(
  projectRoot: string,
): Promise<((relPath: string) => boolean) | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(projectRoot, ".gitignore"), "utf8");
  } catch {
    return undefined;
  }
  const patterns = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!patterns.length) return undefined;

  // Very small glob-ish matcher: supports leading/trailing slash and *.
  const matchers = patterns.map((p) => {
    const negate = p.startsWith("!");
    const body = negate ? p.slice(1) : p;
    const clean = body.replace(/^\//, "").replace(/\/$/, "");
    const re = new RegExp(
      "^" +
        clean
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*") +
        "(/.*)?$",
    );
    return { negate, re, raw: clean };
  });

  return (relPath: string): boolean => {
    const norm = relPath.replace(/\\/g, "/").replace(/\/$/, "");
    let ignored = false;
    for (const m of matchers) {
      const hit = m.re.test(norm) || norm.split("/").some((seg) => m.re.test(seg));
      if (hit) ignored = !m.negate;
    }
    return ignored;
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
