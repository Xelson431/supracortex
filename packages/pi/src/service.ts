/**
 * P03 Cortex service: Engine bound to a project root for the Pi CLI.
 *
 * - Constructs Engine directly (never imports the OpenCode plugin).
 * - Jev enrichment follows project config; absent credentials or provider
 *   failures fall back to deterministic context.
 * - All core operations serialize through one promise-chain mutex shared by
 *   the main session and children (concurrency unaudited until proven).
 * - Respects SUPRACORTEX_DISABLE via core resolveConfig (env passthrough).
 */

import {
  DEFAULT_CONFIG,
  Engine,
  JsonlStore,
  createSqliteStore,
  resolveConfig,
  loadConfigLayers,
  resolveProjectStorageDirectory,
  unknownConfigKeys,
  type Config,
  type ContextPacket,
  type GatherInputs,
  type ResolvedConfig,
  type StorageAdapter,
  type TaskInput,
} from "@local/supracortex-core";
import { safeGitChanges } from "./git.ts";
import { logDebug, logError, logInfo } from "./log.ts";

export const PLUGIN_VERSION = "supracortex-pi-p03";

export interface CortexStatus {
  enabled: boolean;
  reason: string;
  jevSuppressed: boolean;
  projectRoot: string;
  storagePath: string;
}

export class CortexService {
  readonly engine: Engine;
  readonly config: Config;
  readonly resolved: ResolvedConfig;
  readonly projectRoot: string;
  readonly storagePath: string;
  readonly jevSuppressed: boolean;

  private constructor(opts: {
    engine: Engine;
    config: Config;
    resolved: ResolvedConfig;
    projectRoot: string;
    storagePath: string;
    jevSuppressed: boolean;
  }) {
    this.engine = opts.engine;
    this.config = opts.config;
    this.resolved = opts.resolved;
    this.projectRoot = opts.projectRoot;
    this.storagePath = opts.storagePath;
    this.jevSuppressed = opts.jevSuppressed;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Serialize core operations; a rejection never breaks the chain. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  static async create(projectRoot: string): Promise<CortexService> {
    // Central config + project-scoped keys, identical to the OpenCode/MCP
    // hosts. Unknown keys in the CENTRAL file are a hard error (a typo there
    // silently changes behavior everywhere); ignored project keys are logged.
    const layers = await loadConfigLayers(projectRoot);
    const unknown = unknownConfigKeys(layers.global ?? {});
    if (unknown.length) {
      const error = `unknown core config keys: ${unknown.join(", ")}`;
      logError("service", "core config rejected", { error, projectRoot });
      throw new Error(error);
    }
    if (layers.ignoredProjectKeys.length) {
      logDebug("service", "project config keys ignored (config is central)", { keys: layers.ignoredProjectKeys, projectRoot });
    }
    const resolved = resolveConfig({
      defaults: DEFAULT_CONFIG,
      global: layers.global,
      project: layers.project,
      env: process.env as Record<string, string | undefined>,
    });
    const config = resolved.config;
    const storagePath = resolveProjectStorageDirectory(projectRoot, config.storage.directory);
    let store: StorageAdapter;
    if (config.storage.driver === "sqlite") {
      try {
        store = await createSqliteStore(storagePath);
      } catch (cause) {
        throw new Error(
          `Configured SQLite storage could not open: ${cause instanceof Error ? cause.message : "unknown error"}`,
        );
      }
    } else {
      store = new JsonlStore(storagePath);
    }
    const engine = new Engine({
      config,
      store,
      pluginVersion: PLUGIN_VERSION,
      projectRoot,
    });
    logInfo("service", "cortex service ready", {
      projectRoot,
      enabled: resolved.config.enabled,
      jev: resolved.config.jev.enabled ? "on" : "off",
    });
    return new CortexService({
      engine,
      config,
      resolved,
      projectRoot,
      storagePath,
      jevSuppressed: !config.jev.enabled,
    });
  }

  status(): CortexStatus {
    return {
      enabled: this.engine.enabled,
      reason: this.resolved.reason,
      jevSuppressed: this.jevSuppressed,
      projectRoot: this.projectRoot,
      storagePath: this.storagePath,
    };
  }

  /** Build a context packet for a query (serialized). Null when disabled. */
  prepare(query: string, hintFiles: string[] = [], targetAgent?: string): Promise<ContextPacket | null> {
    return this.runExclusive(async () => {
      if (!this.engine.enabled) return null;
      const gather: GatherInputs = {};
      if (targetAgent) gather.targetAgent = targetAgent;
      const git = await safeGitChanges(this.projectRoot);
      if (git) gather.git = git;
      const task: TaskInput = { query, ...(hintFiles.length ? { hintFiles } : {}) };
      return this.engine.prepareContext(task, gather);
    });
  }

  searchMemory(query: string, limit = 8): Promise<unknown> {
    return this.runExclusive(async () => (await this.engine.searchMemory(query)).slice(0, Math.max(1, limit)));
  }

  recordMemory(input: {
    kind: "fact" | "decision" | "convention" | "failure" | "constraint" | "task-outcome";
    content: string;
    confidence?: number;
  }): Promise<unknown> {
    return this.runExclusive(() =>
      this.engine.recordMemory({
        kind: input.kind,
        content: input.content,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        sourceReferences: [{ kind: "session", value: "pi-cli" }],
      }),
    );
  }

  async close(): Promise<void> {
    await this.runExclusive(() => this.engine.close());
  }
}
