/**
 * Distribution version for this source tree.
 *
 * `scripts/build.ts` and the version-consistency test compare this value with
 * the root package manifest. Keeping the runtime import here avoids each host
 * adapter carrying an independently maintained version string.
 */
export const PACKAGE_VERSION = "0.2.1";

/** SupraCortex operation contract, distinct from the MCP protocol date. */
export const TOOLSET_API_VERSION = "2.0.0";

/** Persisted/configuration namespaces intentionally evolve independently.
 * History: v2 baseline → v3 added memory_fts FTS5 backfill → v5 current. */
export const CONFIG_SCHEMA_VERSION = 2;
export const STORAGE_SCHEMA_VERSION = 5;
export const MEMORY_RECORD_VERSION = 2;
export const CONTEXT_PACKET_VERSION = 2;
export const EVENT_SCHEMA_VERSION = 2;
export const METRICS_EVENT_VERSION = 2;
export const SNAPSHOT_SCHEMA_VERSION = 2;
export const VAULT_MANIFEST_VERSION = 2;
export const HANDOFF_SCHEMA_VERSION = 1;
/** Derived code-graph formats evolve independently from durable memory. */
export const CODE_GRAPH_SCHEMA_VERSION = 1;
export const CODE_GRAPH_EXTRACTOR_VERSION = 1;
