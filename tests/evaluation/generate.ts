/**
 * Deterministic evaluation corpus generator.
 *
 * Produces two files under tests/evaluation/:
 *   corpus-<version>.json           — entries + tuning queries
 *   corpus-<version>-holdout.json   — holdout queries only
 *
 * Seeded PRNG, fixed timestamps, no Math.random / Date.now.
 * Run: node tests/evaluation/generate.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pickN<T>(rng: () => number, arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rng() * copy.length);
    result.push(copy[idx]!);
    copy.splice(idx, 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const FIXED_NUM = new Date(FIXED_NOW).getTime();

/** Unique id counter. */
let _counter = 0;
function nextId(prefix = "e"): string {
  _counter++;
  return `${prefix}-${String(_counter).padStart(4, "0")}`;
}
function resetCounter() {
  _counter = 0;
}

interface CorpusEntry {
  id: string;
  kind: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  confidence: number;
  status: string;
  sourceReferences: Array<{ kind: string; value: string; hash?: string }>;
  relatedFiles: string[];
  relatedSymbols: string[];
  tags: string[];
  invalidationRules: Array<{ kind: string; target?: string; expiresAt?: string }>;
  supersedes?: string[];
  origin?: string;
}

interface LabeledQuery {
  id: string;
  query: string;
  relevantEntryIds: string[];
  /**
   * Records that must NOT be surfaced for this query: non-active entries
   * (candidate, stale, superseded, disputed, forgotten) or genuinely
   * wrong/unsafe content. An active, correct fact that contradicts the user's
   * request is corrective evidence, not harmful — it belongs in
   * relevantEntryIds so correct retrieval is rewarded instead of punished.
   */
  harmfulEntryIds: string[];
  annotator: string;
  rationale: string;
  isHoldout: boolean;
  queryClass: string;
}

interface EvaluationCorpus {
  version: string;
  generatedAt: string;
  totalEntries: number;
  totalQueries: number;
  holdoutQueries: number;
  negativeQueries: number;
  entries: CorpusEntry[];
  queries: LabeledQuery[];
}

// ---------------------------------------------------------------------------
// Template entries (seeded generation fills in details)
// ---------------------------------------------------------------------------
const ALL_KINDS: CorpusEntry["kind"][] = [
  "fact",
  "decision",
  "convention",
  "failure",
  "constraint",
  "task-outcome",
];

const ALL_STATUSES: CorpusEntry["status"][] = [
  "active",
  "superseded",
  "stale",
  "disputed",
  "candidate",
  "forgotten",
];

const CANARY_TOKEN = "FAKE_CANARY_sk-test-eval-token-do-not-use";

// ---------------------------------------------------------------------------
// Entry templates (each function returns a partial entry to be fleshed out)
// ---------------------------------------------------------------------------
interface EntryTemplate {
  kind: CorpusEntry["kind"];
  contentTmpl: string;
  tags: string[];
  relatedFiles: string[];
  relatedSymbols: string[];
  status: CorpusEntry["status"];
  conflictWith?: string; // id of entry this contradicts
}

const ENTRY_TEMPLATES: EntryTemplate[] = [
  // --- Project facts ---
  { kind: "fact", contentTmpl: "Application uses React {libVer} for UI components", tags: ["ui", "frontend"], relatedFiles: ["package.json"], relatedSymbols: ["React"], status: "active" },
  { kind: "fact", contentTmpl: "Primary database is PostgreSQL {dbVer} running on AWS RDS", tags: ["database", "infrastructure"], relatedFiles: ["docker-compose.yml", "terraform/main.tf"], relatedSymbols: ["postgres", "rds"], status: "active" },
  { kind: "fact", contentTmpl: "CI pipeline uses GitHub Actions with {runner} runners", tags: ["ci", "devops"], relatedFiles: [".github/workflows/ci.yml"], relatedSymbols: ["github-actions"], status: "active" },
  { kind: "fact", contentTmpl: "Authentication uses JWT tokens with {jwtExpiry} expiry", tags: ["auth", "security"], relatedFiles: ["src/auth.ts"], relatedSymbols: ["jwt", "verifyToken"], status: "active" },
  { kind: "fact", contentTmpl: "Application is deployed on {cloudProvider} in {region} region", tags: ["infrastructure", "deployment"], relatedFiles: ["deploy/config.yaml"], relatedSymbols: ["deploy"], status: "active" },
  { kind: "fact", contentTmpl: "Node.js version {nodeVer} is required per .nvmrc", tags: ["tooling", "node"], relatedFiles: [".nvmrc"], relatedSymbols: ["node"], status: "active" },
  { kind: "fact", contentTmpl: "Logging uses Winston with {logLevel} as default level", tags: ["logging", "observability"], relatedFiles: ["src/logger.ts"], relatedSymbols: ["winston", "logger"], status: "active" },
  { kind: "fact", contentTmpl: "Package manager is {pkgMgr} with lockfile {lockFile}", tags: ["tooling"], relatedFiles: ["package.json"], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "API gateway is {apiGw} handling rate limiting at {rateLimit} req/s", tags: ["api", "infrastructure"], relatedFiles: ["gateway/config.yaml"], relatedSymbols: ["gateway"], status: "active" },
  { kind: "fact", contentTmpl: "Feature flags managed via {flagProvider} with {flagCount} active flags", tags: ["feature-flags"], relatedFiles: ["src/flags.ts"], relatedSymbols: ["getFlag"], status: "active" },

  // --- Decisions ---
  { kind: "decision", contentTmpl: "Use TypeScript strict mode across all packages", tags: ["typescript", "quality"], relatedFiles: ["tsconfig.json"], relatedSymbols: ["strict"], status: "active" },
  { kind: "decision", contentTmpl: "Adopt pnpm workspaces for monorepo management", tags: ["build", "monorepo"], relatedFiles: ["pnpm-workspace.yaml"], relatedSymbols: ["workspace"], status: "active" },
  { kind: "decision", contentTmpl: "Prefer function components over class components", tags: ["react", "convention"], relatedFiles: [], relatedSymbols: ["component"], status: "active" },
  { kind: "decision", contentTmpl: "Use eslint with prettier for code formatting", tags: ["tooling", "formatting"], relatedFiles: [".eslintrc.js", ".prettierrc"], relatedSymbols: ["eslint"], status: "active" },
  { kind: "decision", contentTmpl: "Store secrets in Vault not in environment files", tags: ["security", "secrets"], relatedFiles: ["infra/vault-policy.hcl"], relatedSymbols: ["vault"], status: "active" },
  { kind: "decision", contentTmpl: "Use a single staging environment shared by all teams", tags: ["infrastructure", "deployment"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "decision", contentTmpl: "Adopt trunk-based development with short-lived branches", tags: ["git", "workflow"], relatedFiles: [], relatedSymbols: ["trunk"], status: "active" },
  { kind: "decision", contentTmpl: "Use date-based versioning (YYYY.MM.MINOR)", tags: ["release", "versioning"], relatedFiles: [], relatedSymbols: ["version"], status: "active" },
  { kind: "decision", contentTmpl: "Prefer webp over PNG for all new image assets", tags: ["performance", "assets"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "decision", contentTmpl: "Enforce 80 char line width in all source files", tags: ["style", "convention"], relatedFiles: [".editorconfig"], relatedSymbols: [], status: "active" },

  // --- Conventions ---
  { kind: "convention", contentTmpl: "Commit messages follow conventional commits format", tags: ["git", "convention"], relatedFiles: [".github/semantic.yml"], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "File names use kebab-case for everything", tags: ["style", "convention"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "Export public API from index.ts barrel files", tags: ["typescript", "convention"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "Always write unit tests for new modules", tags: ["testing", "quality"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "Use named exports not default exports", tags: ["typescript", "convention"], relatedFiles: [], relatedSymbols: ["export"], status: "active" },
  { kind: "convention", contentTmpl: "Document public APIs with JSDoc", tags: ["documentation", "convention"], relatedFiles: [], relatedSymbols: ["JSDoc"], status: "active" },
  { kind: "convention", contentTmpl: "Prefix interface names with I (e.g. IConfig)", tags: ["typescript", "style"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "Use const assertions for literal types", tags: ["typescript", "style"], relatedFiles: [], relatedSymbols: ["as const"], status: "active" },
  { kind: "convention", contentTmpl: "Order imports: node → external → internal", tags: ["style", "imports"], relatedFiles: [".eslintrc.js"], relatedSymbols: [], status: "active" },
  { kind: "convention", contentTmpl: "Environment variables use UPPER_SNAKE_CASE", tags: ["style", "config"], relatedFiles: [".env.example"], relatedSymbols: [], status: "active" },

  // --- Failures ---
  { kind: "failure", contentTmpl: "Memory leak in session manager when events arrive out of order", tags: ["bug", "memory"], relatedFiles: ["src/session.ts"], relatedSymbols: ["SessionManager"], status: "active" },
  { kind: "failure", contentTmpl: "Race condition in file lock acquisition under concurrent access", tags: ["bug", "concurrency"], relatedFiles: ["src/lock.ts"], relatedSymbols: ["acquireFileLock"], status: "active" },
  { kind: "failure", contentTmpl: "Token estimator underestimates code-heavy payloads by 40%", tags: ["bug", "metrics"], relatedFiles: ["src/token-estimator.ts"], relatedSymbols: ["estimateTokens"], status: "active" },
  { kind: "failure", contentTmpl: "JSONL store corrupts entries containing unicode surrogate pairs", tags: ["bug", "storage"], relatedFiles: ["src/jsonl-store.ts"], relatedSymbols: ["appendJsonl"], status: "active" },
  { kind: "failure", contentTmpl: "FTS5 query with special characters throws unhandled exception", tags: ["bug", "search"], relatedFiles: ["src/sqlite-store.ts"], relatedSymbols: ["ftsSearch"], status: "active" },
  { kind: "failure", contentTmpl: "Compact operation drops entries when rewriteAll overlaps kinds", tags: ["bug", "compaction"], relatedFiles: ["src/repository.ts"], relatedSymbols: ["rewriteAll"], status: "active" },
  { kind: "failure", contentTmpl: "MCP tool selection crashes on null description field", tags: ["bug", "mcp"], relatedFiles: ["src/mcp/selector.ts"], relatedSymbols: ["selectMcpTools"], status: "active" },
  { kind: "failure", contentTmpl: "Summary cache invalidation returns stale results for renamed files", tags: ["bug", "cache"], relatedFiles: ["src/cache/invalidation.ts"], relatedSymbols: ["validateCache"], status: "active" },
  { kind: "failure", contentTmpl: "Reverse import resolution circular dependency causes stack overflow", tags: ["bug", "indexer"], relatedFiles: ["src/repository-indexer.ts"], relatedSymbols: ["buildIndex"], status: "active" },
  { kind: "failure", contentTmpl: "SupraSpace sync writes managed blocks into wrong file sections", tags: ["bug", "supraspace"], relatedFiles: ["src/supraspace/projector.ts"], relatedSymbols: ["composeFileContent"], status: "active" },

  // --- Constraints ---
  { kind: "constraint", contentTmpl: "Core package must have zero runtime dependencies on OpenCode", tags: ["architecture", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "All public APIs must be versioned and backward compatible for min 2 releases", tags: ["api", "compatibility"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "No secrets may be logged or persisted in plaintext", tags: ["security", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "Context payload must fit within {budgetTokens} token budget", tags: ["performance", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "File ownership lock must expire after {lockExpiry} seconds", tags: ["concurrency", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "All storage writes must be atomic (no partial file writes)", tags: ["storage", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "Memory retrieval must be deterministic with same inputs", tags: ["retrieval", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "Plugin must support both JSONL and SQLite storage backends", tags: ["storage", "portability"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "Maximum single entry content length is {maxContentLen} characters", tags: ["validation", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "constraint", contentTmpl: "Task plans must detect and warn about duplicate work", tags: ["orchestration", "constraint"], relatedFiles: [], relatedSymbols: [], status: "active" },

  // --- Task outcomes ---
  { kind: "task-outcome", contentTmpl: "Add session heartbeat recovery: all E2E pass (12/12)", tags: ["task", "completed"], relatedFiles: ["src/session.ts"], relatedSymbols: ["heartbeat"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Implement FTS5 BM25 rank blending: recall@5 improved from 0.65 to 0.82", tags: ["task", "completed", "retrieval"], relatedFiles: ["src/retrieval.ts"], relatedSymbols: ["bm25"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Migrate config from v1 to v2 shape: all migrations green", tags: ["task", "completed", "migration"], relatedFiles: ["src/migrations.ts"], relatedSymbols: ["migrate"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Add Unicode support to token estimator: coverage verified on 20 languages", tags: ["task", "completed", "unicode"], relatedFiles: ["src/token-estimator.ts"], relatedSymbols: ["estimateBytesTokens"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Performance audit: reduce context build latency by 35%", tags: ["task", "completed", "performance"], relatedFiles: ["src/context/builder.ts"], relatedSymbols: ["buildContextPacket"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Add stale-evidence sweep: 142 stale entries cleaned in prod", tags: ["task", "completed", "sweep"], relatedFiles: ["src/sweeper.ts"], relatedSymbols: ["Sweeper"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Update README with MCP protocol v2 examples", tags: ["task", "completed", "docs"], relatedFiles: ["README.md"], relatedSymbols: [], status: "active" },
  { kind: "task-outcome", contentTmpl: "Fix regressions in ownership fencing token generation", tags: ["task", "completed", "bugfix"], relatedFiles: ["src/ownership.ts"], relatedSymbols: ["fencingToken"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Add SupraSpace vault projection: 87 memory entries mapped", tags: ["task", "completed", "supraspace"], relatedFiles: ["src/supraspace/projector.ts"], relatedSymbols: ["projected"], status: "active" },
  { kind: "task-outcome", contentTmpl: "Remove deprecated direct-opencode integration path", tags: ["task", "completed", "cleanup"], relatedFiles: ["src/index.ts"], relatedSymbols: [], status: "active" },

  // --- Stale / superseded / forgotten entries ---
  { kind: "fact", contentTmpl: "Docker image is hosted on Docker Hub (migrated to ECR)", tags: ["infrastructure", "docker"], relatedFiles: ["deploy/docker-compose.yml"], relatedSymbols: ["docker"], status: "stale" },
  { kind: "decision", contentTmpl: "Use Webpack for bundling (migrated to esbuild)", tags: ["build", "bundler"], relatedFiles: ["webpack.config.js"], relatedSymbols: ["webpack"], status: "superseded" },
  { kind: "fact", contentTmpl: "Server runs on CentOS 7 (migrated to Ubuntu 24.04)", tags: ["infrastructure", "os"], relatedFiles: ["ansible/hosts.ini"], relatedSymbols: [], status: "stale" },
  { kind: "convention", contentTmpl: "Use mocha + chai for testing (migrated to node:test)", tags: ["testing", "obsolete"], relatedFiles: [], relatedSymbols: ["mocha"], status: "superseded" },
  { kind: "fact", contentTmpl: "Legacy note about using MySQL for analytics cache", tags: ["database", "legacy"], relatedFiles: [], relatedSymbols: ["mysql"], status: "forgotten" },
  { kind: "decision", contentTmpl: "Use jQuery for DOM manipulation (no longer used)", tags: ["frontend", "obsolete"], relatedFiles: [], relatedSymbols: ["jQuery"], status: "forgotten" },
  { kind: "fact", contentTmpl: "API rate limit was 100 req/min (updated to 1000 req/min)", tags: ["api", "obsolete"], relatedFiles: [], relatedSymbols: [], status: "superseded" },
  { kind: "fact", contentTmpl: "Production used t2.micro instances (upgraded to t3.large)", tags: ["infrastructure", "obsolete"], relatedFiles: [], relatedSymbols: [], status: "stale" },
  { kind: "convention", contentTmpl: "Tab indentation was standard (now spaces)", tags: ["style", "obsolete"], relatedFiles: [], relatedSymbols: [], status: "superseded" },
  { kind: "decision", contentTmpl: "Sass for styling (now CSS modules)", tags: ["css", "obsolete"], relatedFiles: [], relatedSymbols: ["sass"], status: "forgotten" },

  // --- Disputed / candidate entries ---
  { kind: "fact", contentTmpl: "System handles 100k concurrent users (disputed: load test shows 50k max)", tags: ["performance", "disputed"], relatedFiles: [], relatedSymbols: [], status: "disputed" },
  { kind: "decision", contentTmpl: "Use Redis for session store (disputed: some services use in-memory)", tags: ["disputed"], relatedFiles: [], relatedSymbols: ["redis"], status: "disputed" },
  { kind: "fact", contentTmpl: "Imported claim about last.fm API integration pending review", tags: ["imported", "pending"], relatedFiles: [], relatedSymbols: [], status: "candidate" },
  { kind: "convention", contentTmpl: "Unreviewed proposal to adopt Biome over eslint+prettier", tags: ["imported", "pending"], relatedFiles: [], relatedSymbols: ["biome"], status: "candidate" },
  { kind: "fact", contentTmpl: "Agent-submitted observation about WebSocket reconnect behavior", tags: ["imported", "pending"], relatedFiles: [], relatedSymbols: [], status: "candidate" },
  { kind: "decision", contentTmpl: "Candidate decision to move from REST to GraphQL", tags: ["imported", "pending", "api"], relatedFiles: [], relatedSymbols: ["graphql"], status: "candidate" },
  { kind: "fact", contentTmpl: "Claim: PostgreSQL 17 uses 30% less memory (unverified)", tags: ["imported"], relatedFiles: [], relatedSymbols: [], status: "candidate" },
  { kind: "convention", contentTmpl: "Proposal: commit messages in Chinese (pending team vote)", tags: ["imported"], relatedFiles: [], relatedSymbols: [], status: "candidate" },

  // --- Evidence-stale entries (stale due to file hash changes) ---
  { kind: "fact", contentTmpl: "Config file sets log level to debug (evidence file changed)", tags: ["config", "evidence-stale"], relatedFiles: ["src/config.ts"], relatedSymbols: ["logLevel"], status: "stale" },
  { kind: "fact", contentTmpl: "CI pipeline runs on push to main (evidence file changed)", tags: ["ci", "evidence-stale"], relatedFiles: [".github/workflows/ci.yml"], relatedSymbols: [], status: "stale" },
  { kind: "fact", contentTmpl: "Dockerfile uses node:18 base image (evidence file changed)", tags: ["docker", "evidence-stale"], relatedFiles: ["Dockerfile"], relatedSymbols: ["node"], status: "stale" },

  // --- Contradiction pair ---
  { kind: "decision", contentTmpl: "API must use REST over GraphQL", tags: ["api", "contradiction"], relatedFiles: [], relatedSymbols: ["rest"], status: "active", conflictWith: "e-c001b" },
  { kind: "decision", contentTmpl: "API must not use REST; GraphQL is preferred", tags: ["api", "contradiction"], relatedFiles: [], relatedSymbols: ["graphql"], status: "active", conflictWith: "e-c001a" },

  // --- Multilingual / Unicode entries ---
  { kind: "fact", contentTmpl: "Application supports 日本語, 中文, 한국어, русский язык, العربية", tags: ["i18n", "unicode"], relatedFiles: ["src/i18n/locales"], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "Día de los Muertos holiday feature uses emoji 🎉 and accented characters", tags: ["i18n", "unicode"], relatedFiles: [], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "Unicode normalization form NFC is used for all user input été vs ete", tags: ["i18n", "unicode"], relatedFiles: ["src/normalize.ts"], relatedSymbols: ["normalize"], status: "active" },
  { kind: "fact", contentTmpl: "Gödel's incompleteness theorem reference in architecture doc", tags: ["knowledge"], relatedFiles: ["docs/architecture.md"], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "Café menu feature uses é, ñ, ü characters throughout", tags: ["i18n", "unicode"], relatedFiles: ["src/menu.ts"], relatedSymbols: [], status: "active" },

  // --- Renamed symbol entries ---
  { kind: "fact", contentTmpl: "Function getUserData was renamed to fetchUserProfile in v2.1", tags: ["refactor", "rename"], relatedFiles: ["src/user.ts"], relatedSymbols: ["fetchUserProfile"], status: "active" },
  { kind: "fact", contentTmpl: "Class DBConnection renamed to DatabaseConnector", tags: ["refactor", "rename"], relatedFiles: ["src/db.ts"], relatedSymbols: ["DatabaseConnector"], status: "active" },
  { kind: "fact", contentTmpl: "File src/utils/helpers.ts moved to src/lib/utilities.ts", tags: ["refactor", "rename"], relatedFiles: ["src/lib/utilities.ts"], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "Config key database.port changed to db.connection.port", tags: ["config", "refactor"], relatedFiles: ["config/default.yaml"], relatedSymbols: [], status: "active" },
  { kind: "fact", contentTmpl: "Environment var DB_HOST renamed to DATABASE_HOST", tags: ["config", "refactor"], relatedFiles: [".env.example"], relatedSymbols: [], status: "active" },
];

// ---------------------------------------------------------------------------
// Build entries from templates
// ---------------------------------------------------------------------------
function fillTmpl(tmpl: string, rng: () => number): string {
  const subs: Record<string, string> = {
    libVer: pick(rng, ["17", "18", "19", "20"]),
    dbVer: pick(rng, ["14", "15", "16", "17"]),
    runner: pick(rng, ["ubuntu-latest", "macos-latest", "windows-latest"]),
    jwtExpiry: String(pick(rng, [15, 30, 60, 120])),
    cloudProvider: pick(rng, ["AWS", "GCP", "Azure", "DigitalOcean"]),
    region: pick(rng, ["us-east-1", "eu-west-1", "ap-southeast-1"]),
    nodeVer: pick(rng, ["18", "20", "22"]),
    logLevel: pick(rng, ["info", "warn", "error"]),
    pkgMgr: pick(rng, ["npm", "pnpm", "yarn"]),
    lockFile: pick(rng, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]),
    apiGw: pick(rng, ["Kong", "AWS API Gateway", "Nginx"]),
    rateLimit: pick(rng, ["100", "500", "1000"]),
    flagProvider: pick(rng, ["LaunchDarkly", "Unleash", "Flagsmith"]),
    flagCount: String(pick(rng, [5, 15, 30])),
    budgetTokens: String(pick(rng, [4000, 8000, 16000])),
    lockExpiry: String(pick(rng, [30, 60, 120])),
    maxContentLen: String(pick(rng, [4000, 8000, 16000])),
  };
  return tmpl.replace(/\{(\w+)\}/g, (_, key) => subs[key] ?? `{${key}}`);
}

function generateEntry(
  tmpl: EntryTemplate,
  rng: () => number,
  fixedNow: string,
): CorpusEntry {
  const id = nextId();
  const kind = tmpl.kind;
  const content = fillTmpl(tmpl.contentTmpl, rng);

  const sources: CorpusEntry["sourceReferences"] = [];
  if (tmpl.relatedFiles.length > 0) {
    for (const file of tmpl.relatedFiles) {
      sources.push({
        kind: "file",
        value: file,
        hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      });
    }
  }

  if (kind === "decision" || kind === "convention" || kind === "constraint") {
    if (sources.length === 0) {
      sources.push({ kind: "session", value: "team-discussion-2026-q1" });
    }
  }

  const entry: CorpusEntry = {
    id,
    kind,
    content,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    confidence: Number((0.6 + rng() * 0.35).toFixed(2)),
    status: tmpl.status,
    sourceReferences: sources,
    relatedFiles: tmpl.relatedFiles,
    relatedSymbols: tmpl.relatedSymbols,
    tags: tmpl.tags,
    invalidationRules: [],
  };

  if (tmpl.status === "stale" && tmpl.tags.includes("evidence-stale")) {
    entry.invalidationRules = [
      { kind: "file-hash-changed", target: tmpl.relatedFiles[0] ?? "unknown" },
    ];
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Build contradiction entries separately (they reference each other)
// ---------------------------------------------------------------------------
function generateContradictionPair(
  rng: () => number,
  fixedNow: string,
): [CorpusEntry, CorpusEntry] {
  const idA = nextId("c");
  const idB = nextId("c");
  const a: CorpusEntry = {
    id: idA,
    kind: "decision",
    content: "API must use REST over GraphQL",
    createdAt: fixedNow,
    updatedAt: fixedNow,
    confidence: 0.85,
    status: "active",
    sourceReferences: [{ kind: "session", value: "arch-discussion-01" }],
    relatedFiles: [],
    relatedSymbols: ["rest"],
    tags: ["api", "contradiction"],
    invalidationRules: [],
  };
  const b: CorpusEntry = {
    id: idB,
    kind: "decision",
    content: "API must not use REST; GraphQL is preferred",
    createdAt: fixedNow,
    updatedAt: fixedNow,
    confidence: 0.8,
    status: "active",
    sourceReferences: [{ kind: "session", value: "arch-discussion-02" }],
    relatedFiles: [],
    relatedSymbols: ["graphql"],
    tags: ["api", "contradiction"],
    invalidationRules: [],
  };
  return [a, b];
}

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------
function generateQueries(
  allEntries: CorpusEntry[],
  rng: () => number,
  fixedNow: string,
): LabeledQuery[] {
  const queries: LabeledQuery[] = [];
  const activeEntries = allEntries.filter((e) => e.status === "active");
  const staleEntries = allEntries.filter((e) => e.status === "stale" || e.status === "superseded" || e.status === "forgotten");
  const candidateEntries = allEntries.filter((e) => e.status === "candidate");

  // Whole-word/phrase match. A trailing plural "s" may follow the keyword so
  // singular labels still find plural entry text ("class component" ->
  // "class components"), while "npm" cannot match inside "pnpm".
  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contentMatches = (content: string, keyword: string): boolean =>
    new RegExp(
      `(?:^|[^a-z0-9_])${escapeRegExp(keyword)}(?:s)?(?=$|[^a-z0-9_])`,
      "i",
    ).test(content);

  // Find *active* entries matching a keyword. Active entries are candidates for
  // relevantEntryIds only: an active corrector is never a harmful label.
  const findRelevant = (keyword: string, max = 2): string[] =>
    activeEntries
      .filter((e) => contentMatches(e.content, keyword))
      .slice(0, max)
      .map((e) => e.id);

  // Find non-active entries matching a keyword. These are the records that
  // harmfulEntryIds is for: content that should not be shown.
  const findNonActive = (
    keyword: string,
    statuses: CorpusEntry["status"][],
    max = 1,
  ): string[] =>
    allEntries
      .filter((e) => statuses.includes(e.status) && contentMatches(e.content, keyword))
      .slice(0, max)
      .map((e) => e.id);

  // 1. Exact symbol/path queries (15)
  const exactTerms: Array<[string, string, number]> = [
    ["TypeScript strict mode", "strict mode", 2],
    ["pnpm workspaces", "pnpm workspaces", 2],
    ["sourceReferences", "sourceReference", 2],
    ["confidence constraint", "confidence", 2],
    ["PostgreSQL RDS AWS", "PostgreSQL", 2],
    ["JWT verification", "JWT", 2],
    ["GitHub Actions CI", "GitHub Actions", 2],
    ["Winston logging", "Winston", 2],
    ["kebab-case filenames", "kebab-case", 1],
    ["named exports convention", "named export", 1],
    ["conventional commits", "conventional commit", 1],
    ["NFC normalization", "normalize", 1],
    ["I prefix interface", "prefix interface", 1],
    ["bound check validation", "validation", 1],
    ["trunk based development", "trunk-based", 1],
  ];
  for (const [query, keyword, max] of exactTerms) {
    queries.push({
      id: `q-exact-${String(queries.length + 1).padStart(3, "0")}`,
      query,
      relevantEntryIds: findRelevant(keyword, max),
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: `exact symbol match for ${keyword}`,
      isHoldout: false,
      queryClass: "exact-symbol",
    });
  }

  // 2. Paraphrase queries
  queries.push({
    id: "q-para-001",
    query: "how do we bundle our frontend code",
    relevantEntryIds: findRelevant("React", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "paraphrase of React UI fact",
    isHoldout: false,
    queryClass: "paraphrase",
  });
  queries.push({
    id: "q-para-002",
    query: "what database system are we running",
    relevantEntryIds: findRelevant("PostgreSQL", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "paraphrase of database fact",
    isHoldout: false,
    queryClass: "paraphrase",
  });
  queries.push({
    id: "q-para-003",
    query: "tell me about the CI pipeline setup",
    relevantEntryIds: findRelevant("CI", 2).concat(findRelevant("GitHub Actions", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "paraphrase of CI pipeline fact",
    isHoldout: false,
    queryClass: "paraphrase",
  });
  queries.push({
    id: "q-para-004",
    query: "which node version do we target",
    relevantEntryIds: findRelevant("Node.js", 2).concat(findRelevant(".nvmrc", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "paraphrase of Node version fact",
    isHoldout: false,
    queryClass: "paraphrase",
  });
  queries.push({
    id: "q-para-005",
    query: "where are we hosting the app servers",
    relevantEntryIds: findRelevant("deployed", 1).concat(findRelevant("AWS", 2)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "paraphrase of deployment fact",
    isHoldout: false,
    queryClass: "paraphrase",
  });

  // 3. Contradictory requests with an active corrective fact. These are
  // answerable: the stored active fact corrects the user's premise. An active
  // corrector is never harmful, so it is labeled relevant instead.
  const correctiveNegatives: Array<{
    id: string;
    query: string;
    relevant: string[];
    rationale: string;
  }> = [
    {
      id: "q-neg-001",
      query: "use MySQL for main database",
      relevant: findRelevant("PostgreSQL", 2),
      rationale: "MySQL is not used; PostgreSQL is the active corrective fact",
    },
    {
      id: "q-neg-002",
      query: "class components in React",
      relevant: findRelevant("class component", 1),
      rationale:
        "class components are not preferred; the active convention is function components",
    },
    {
      id: "q-neg-003",
      query: "deploy to Heroku",
      relevant: findRelevant("deployed", 1),
      rationale: "not deployed on Heroku; the active Azure deployment fact is corrective evidence",
    },
    {
      id: "q-neg-004",
      query: "use MongoDB as primary datastore",
      relevant: findRelevant("PostgreSQL", 2),
      rationale: "MongoDB is not the datastore; PostgreSQL is the active corrective fact",
    },
  ];
  for (const n of correctiveNegatives) {
    queries.push({
      id: n.id,
      query: n.query,
      relevantEntryIds: n.relevant,
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: n.rationale,
      isHoldout: false,
      queryClass: "contradiction",
    });
  }
  // q-neg-005 asks about a superseded practice. There is no active corrector
  // entry, so the superseded record is the harmful label.
  queries.push({
    id: "q-neg-005",
    query: "webpack configuration for production build",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("webpack", ["superseded"]),
    annotator: "eval-system",
    rationale: "webpack is superseded by esbuild",
    isHoldout: false,
    queryClass: "ambiguous-negative",
  });

  // 4. Renamed symbols
  queries.push({
    id: "q-ren-001",
    query: "getUserData function",
    relevantEntryIds: findRelevant("getUserData", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "renamed symbol query — should still find the rename fact",
    isHoldout: false,
    queryClass: "renamed-symbol",
  });
  queries.push({
    id: "q-ren-002",
    query: "DB_HOST env var location",
    relevantEntryIds: findRelevant("DB_HOST", 1).concat(findRelevant("DATABASE_HOST", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "should find both old and new env var names",
    isHoldout: false,
    queryClass: "renamed-symbol",
  });
  queries.push({
    id: "q-ren-003",
    query: "database port configuration key",
    relevantEntryIds: findRelevant("database.port", 1),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "renamed config key",
    isHoldout: false,
    queryClass: "renamed-symbol",
  });

  // 5. Changed files
  queries.push({
    id: "q-chg-001",
    query: "what is the logging configuration",
    relevantEntryIds: findRelevant("Winston", 1).concat(findRelevant("logging", 2)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "query about logging config which has evidence-stale entry",
    isHoldout: false,
    queryClass: "changed-file",
  });
  queries.push({
    id: "q-chg-002",
    query: "Docker base image version",
    relevantEntryIds: findRelevant("Dockerfile", 1).concat(findRelevant("docker", 2)),
    harmfulEntryIds: findNonActive("Dockerfile", ["stale"]),
    annotator: "eval-system",
    rationale: "query about docker image which may have stale evidence",
    isHoldout: false,
    queryClass: "changed-file",
  });
  queries.push({
    id: "q-chg-003",
    query: "config file settings for log level",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("log level", ["stale"]),
    annotator: "eval-system",
    rationale: "stale evidence entry about log level should not be returned",
    isHoldout: false,
    queryClass: "changed-file",
  });

  // 6. Stale evidence (queries where stale-status entries should NOT appear)
  queries.push({
    id: "q-stale-001",
    query: "Docker Hub registry",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("Docker Hub", ["stale"]),
    annotator: "eval-system",
    rationale: "Docker Hub is stale; migrated to ECR",
    isHoldout: false,
    queryClass: "stale-evidence",
  });
  queries.push({
    id: "q-stale-002",
    query: "CentOS server version",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("CentOS", ["stale"]),
    annotator: "eval-system",
    rationale: "CentOS is stale; migrated to Ubuntu",
    isHoldout: false,
    queryClass: "stale-evidence",
  });
  queries.push({
    id: "q-stale-003",
    query: "t2.micro instance type",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("t2.micro", ["stale"]),
    annotator: "eval-system",
    rationale: "t2.micro is stale; upgraded to t3.large",
    isHoldout: false,
    queryClass: "stale-evidence",
  });

  // 7. Contradictions
  queries.push({
    id: "q-contr-001",
    query: "REST vs GraphQL which one do we use",
    relevantEntryIds: allEntries.filter((e) => e.tags.includes("contradiction")).map((e) => e.id),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "contradiction pair should identify both sides",
    isHoldout: false,
    queryClass: "contradiction",
  });
  queries.push({
    id: "q-contr-002",
    query: "our API architecture decision",
    relevantEntryIds: allEntries.filter((e) => e.tags.includes("contradiction")).map((e) => e.id),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "API architecture query surfaces contradiction",
    isHoldout: false,
    queryClass: "contradiction",
  });

  // 8. Multilingual / Unicode
  queries.push({
    id: "q-i18n-001",
    query: "日本語対応はいつから",
    relevantEntryIds: findRelevant("日本語"),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "Japanese text query should match i18n entry",
    isHoldout: false,
    queryClass: "multilingual",
  });
  queries.push({
    id: "q-i18n-002",
    query: "Día de los Muertos feature",
    relevantEntryIds: findRelevant("Día"),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "accented character query",
    isHoldout: false,
    queryClass: "multilingual",
  });
  queries.push({
    id: "q-i18n-003",
    query: "unicode normalization NFC été",
    relevantEntryIds: findRelevant("Unicode"),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "Unicode normalization query",
    isHoldout: false,
    queryClass: "multilingual",
  });
  queries.push({
    id: "q-i18n-004",
    query: "café menu characters",
    relevantEntryIds: findRelevant("Café"),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "café with accented characters",
    isHoldout: false,
    queryClass: "multilingual",
  });
  queries.push({
    id: "q-i18n-005",
    query: "Gödel incompleteness reference",
    relevantEntryIds: findRelevant("Gödel"),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "umlaut characters in query",
    isHoldout: false,
    queryClass: "multilingual",
  });

  // 9. Typo-like input
  queries.push({
    id: "q-typo-001",
    query: "postgress databse",
    relevantEntryIds: findRelevant("PostgreSQL", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "typo for PostgreSQL database",
    isHoldout: false,
    queryClass: "typo",
  });
  queries.push({
    id: "q-typo-002",
    query: "typescritp strict",
    relevantEntryIds: findRelevant("strict mode", 1),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "typo for TypeScript strict",
    isHoldout: false,
    queryClass: "typo",
  });
  queries.push({
    id: "q-typo-003",
    query: "authentication JWT tokns",
    relevantEntryIds: findRelevant("JWT", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "typo for JWT tokens",
    isHoldout: false,
    queryClass: "typo",
  });
  queries.push({
    id: "q-typo-004",
    query: "koncurrent users limit",
    relevantEntryIds: [],
    harmfulEntryIds: findNonActive("concurrent users", ["disputed"], 1),
    annotator: "eval-system",
    rationale: "typo for concurrent users (disputed entry should not match)",
    isHoldout: false,
    queryClass: "typo",
  });
  queries.push({
    id: "q-typo-005",
    query: "enviroment variables naming",
    relevantEntryIds: findRelevant("UPPER_SNAKE_CASE", 1).concat(findRelevant("Environment", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "typo for environment variables",
    isHoldout: false,
    queryClass: "typo",
  });

  // 10. Short queries (1-2 words)
  queries.push({
    id: "q-short-001",
    query: "database",
    relevantEntryIds: findRelevant("database", 3),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "single word query on database topic",
    isHoldout: false,
    queryClass: "short",
  });
  queries.push({
    id: "q-short-002",
    query: "security",
    relevantEntryIds: findRelevant("security", 3),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "single word query on security topic",
    isHoldout: false,
    queryClass: "short",
  });
  queries.push({
    id: "q-short-003",
    query: "deployment",
    relevantEntryIds: findRelevant("deployed", 3),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "short query on deployment",
    isHoldout: false,
    queryClass: "short",
  });
  queries.push({
    id: "q-short-004",
    query: "performance",
    relevantEntryIds: findRelevant("performance", 3),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "short query on performance",
    isHoldout: false,
    queryClass: "short",
  });
  queries.push({
    id: "q-short-005",
    query: "testing",
    relevantEntryIds: findRelevant("testing", 3),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "short query on testing",
    isHoldout: false,
    queryClass: "short",
  });

  // 11. Long queries
  queries.push({
    id: "q-long-001",
    query: "I need to understand what database system we are using for our primary application data store and how it is configured for high availability across multiple availability zones",
    relevantEntryIds: findRelevant("PostgreSQL", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "verbose query about database",
    isHoldout: false,
    queryClass: "long",
  });
  queries.push({
    id: "q-long-002",
    query: "Can you tell me about the decisions the team has made regarding TypeScript configuration including strict mode, linting setup, and the reasoning behind those choices",
    relevantEntryIds: findRelevant("strict", 1).concat(findRelevant("eslint", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "verbose query about TypeScript decisions",
    isHoldout: false,
    queryClass: "long",
  });
  queries.push({
    id: "q-long-003",
    query: "What is our current approach to authentication, specifically how we handle JWT token generation, verification, expiry, and any middleware that enforces these checks across our API endpoints",
    relevantEntryIds: findRelevant("JWT", 2),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "verbose query about authentication",
    isHoldout: false,
    queryClass: "long",
  });
  queries.push({
    id: "q-long-004",
    query: "Please provide a summary of all infrastructure-related decisions including cloud provider, deployment regions, CI pipeline setup, container registry, monitoring tools, and incident response procedures",
    relevantEntryIds: findRelevant("AWS", 2).concat(findRelevant("CI", 2)).concat(findRelevant("deployed", 1)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "verbose query about infrastructure",
    isHoldout: false,
    queryClass: "long",
  });
  queries.push({
    id: "q-long-005",
    query: "I recall there was some discussion about switching from REST to GraphQL and also discussions about function components versus class components in React. Can you summarize both decisions and note whether either is still actively debated",
    relevantEntryIds: findRelevant("REST", 2).concat(findRelevant("function component", 1)).concat(findRelevant("GraphQL", 2)),
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "verbose query combining multiple decision topics",
    isHoldout: false,
    queryClass: "long",
  });

  // 12. Injection canaries.
  // These queries assert that the canary text itself is never echoed or treated
  // as stored content. A lexical match on words like "token", "secret", or
  // "AWS" is not a safety failure. This corpus contains no non-active or
  // genuinely secret-shaped records, so canary queries carry no harmful labels;
  // if one existed, only that record would be labeled harmful.
  queries.push({
    id: "q-canary-001",
    query: "FAKE_CANARY_secret_token_abc123",
    relevantEntryIds: [],
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "injection canary — should not expose anything secret-like",
    isHoldout: false,
    queryClass: "injection-canary",
  });
  queries.push({
    id: "q-canary-002",
    query: "FAKE_CANARY_api_key_xyz789 what keys do we use",
    relevantEntryIds: [],
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "injection canary with query about secrets",
    isHoldout: false,
    queryClass: "injection-canary",
  });
  queries.push({
    id: "q-canary-003",
    query: "SELECT * FROM memory WHERE content LIKE '%token%' FAKE_CANARY_sql_inject",
    relevantEntryIds: [],
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "injection canary with SQL-like syntax",
    isHoldout: false,
    queryClass: "injection-canary",
  });
  queries.push({
    id: "q-canary-004",
    query: "FAKE_CANARY_ignore; drop table memory_fts; --",
    relevantEntryIds: [],
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "injection canary with SQL injection attempt",
    isHoldout: false,
    queryClass: "injection-canary",
  });
  queries.push({
    id: "q-canary-005",
    query: "FAKE_CANARY_${process.env.AWS_SECRET_ACCESS_KEY}",
    relevantEntryIds: [],
    harmfulEntryIds: [],
    annotator: "eval-system",
    rationale: "injection canary with template injection",
    isHoldout: false,
    queryClass: "injection-canary",
  });

  // 13. Negative poisoning queries (more of them to reach 100+)
  for (let i = 0; i < 20; i++) {
    const idx = Math.floor(rng() * staleEntries.length);
    const se = staleEntries[idx];
    if (!se) continue;
    const snippet = se.content.split(" ").slice(0, 4).join(" ");
    queries.push({
      id: `q-poison-${String(i + 1).padStart(3, "0")}`,
      query: `${snippet}`,
      relevantEntryIds: [],
      harmfulEntryIds: [se.id],
      annotator: "eval-system",
      rationale: "poisoning query — stale/superseded entry should not be returned",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // More negative queries using candidate entries
  for (let i = 0; i < 15; i++) {
    const idx = Math.floor(rng() * candidateEntries.length);
    const ce = candidateEntries[idx];
    if (!ce) continue;
    const snippet = ce.content.split(" ").slice(0, 4).join(" ");
    queries.push({
      id: `q-poison-${String(i + 21).padStart(3, "0")}`,
      query: `${snippet}`,
      relevantEntryIds: [],
      harmfulEntryIds: [ce.id],
      annotator: "eval-system",
      rationale: "poisoning query — candidate entry should not be returned",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // More negative queries looking at disputed entries
  const disputedEntries = allEntries.filter((e) => e.status === "disputed");
  for (let i = 0; i < 10; i++) {
    const idx = Math.floor(rng() * disputedEntries.length);
    const de = disputedEntries[idx];
    if (!de) continue;
    const snippet = de.content.split(" ").slice(0, 4).join(" ");
    queries.push({
      id: `q-poison-${String(i + 36).padStart(3, "0")}`,
      query: `${snippet}`,
      relevantEntryIds: [],
      harmfulEntryIds: [de.id],
      annotator: "eval-system",
      rationale: "poisoning query — disputed entry should have low score",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // Poisoning queries looking for forgotten entries
  const forgottenEntries = allEntries.filter((e) => e.status === "forgotten");
  for (let i = 0; i < 10; i++) {
    const idx = Math.floor(rng() * forgottenEntries.length);
    const fe = forgottenEntries[idx];
    if (!fe) continue;
    const snippet = fe.content.split(" ").slice(0, 4).join(" ");
    queries.push({
      id: `q-poison-${String(i + 46).padStart(3, "0")}`,
      query: `${snippet}`,
      relevantEntryIds: [],
      harmfulEntryIds: [fe.id],
      annotator: "eval-system",
      rationale: "poisoning query — forgotten entry should not be returned",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // More poisoning: active entries that overlap with stale/superseded topics — should NOT
  // return the stale variant even though it matches. This sets harmful=stale entry id.
  const activeContentWords = activeEntries.map((e) => e.content.split(/\s+/).slice(0, 3).join(" "));
  for (let i = 0; i < 20; i++) {
    const wordSet = pick(rng, activeContentWords);
    // Find a stale entry whose content contains these words
    const matchedStale = staleEntries.find((se) =>
      wordSet.split(" ").some((w) => w.length > 3 && se.content.toLowerCase().includes(w.toLowerCase())),
    );
    if (!matchedStale) continue;
    queries.push({
      id: `q-poison-${String(i + 56).padStart(3, "0")}`,
      query: wordSet,
      relevantEntryIds: [],
      harmfulEntryIds: [matchedStale.id],
      annotator: "eval-system",
      rationale: "poisoning — active topic should not surface stale entry",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // Additional broad poisoning queries using entry content snippets
  const allNotActive = [...staleEntries, ...candidateEntries, ...forgottenEntries, ...disputedEntries];
  for (let i = 0; i < 30; i++) {
    const target = pick(rng, allNotActive);
    if (!target) continue;
    const snippet = target.content.split(" ").slice(0, 3).join(" ");
    queries.push({
      id: `q-poison-${String(i + 76).padStart(3, "0")}`,
      query: snippet,
      relevantEntryIds: [],
      harmfulEntryIds: [target.id],
      annotator: "eval-system",
      rationale: "broad poisoning — non-active entry should not be returned",
      isHoldout: false,
      queryClass: "poisoning",
    });
  }

  // Additional paraphrase queries for coverage
  const moreParaphrases: Array<[string, string]> = [
    ["feature flag system", "feature flag"],
    ["code formatting configuration", "prettier"],
    ["image format for web assets", "webp"],
    ["line width standard in source", "line width"],
    ["version numbering scheme", "versioning"],
    ["staging environment details", "staging"],
    ["how are secrets managed", "Vault"],
    ["what testing frameworks do we use", "testing"],
    ["JSDoc documentation requirement", "JSDoc"],
    ["import ordering convention", "import"],
  ];
  for (const [query, keyword] of moreParaphrases) {
    queries.push({
      id: `q-para-${String(queries.length + 1).padStart(3, "0")}`,
      query,
      relevantEntryIds: findRelevant(keyword, 2),
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: `paraphrased query for ${keyword}`,
      isHoldout: false,
      queryClass: "paraphrase",
    });
  }

  // Additional negative queries. When an active corrective fact exists, the
  // query is answerable and the corrector is relevant. Otherwise the obsolete
  // non-active record is the harmful label.
  const moreNegatives: Array<{ query: string; keyword: string; corrective?: string }> = [
    { query: "using npm as package manager", keyword: "npm", corrective: "pnpm" },
    { query: "yarn workspace setup", keyword: "yarn" },
    {
      query: "use class component for new views",
      keyword: "class component",
      corrective: "class component",
    },
    { query: "sass stylesheets", keyword: "sass" },
    { query: "mocha test runner", keyword: "mocha" },
    { query: "jQuery DOM manipulation", keyword: "jQuery" },
    { query: "CentOS server provisioning", keyword: "CentOS" },
  ];
  for (const n of moreNegatives) {
    const relevant = n.corrective ? findRelevant(n.corrective, 1) : [];
    const isCorrective = relevant.length > 0;
    queries.push({
      id: `q-neg-${String(queries.length + 1).padStart(3, "0")}`,
      query: n.query,
      relevantEntryIds: relevant,
      harmfulEntryIds: isCorrective
        ? []
        : findNonActive(n.keyword, ["superseded", "stale", "forgotten", "candidate", "disputed"], 2),
      annotator: "eval-system",
      rationale: isCorrective
        ? `corrective query — the active ${n.corrective} fact corrects the user's premise`
        : `negative query — ${n.keyword} is not current practice`,
      isHoldout: false,
      queryClass: isCorrective ? "contradiction" : "ambiguous-negative",
    });
  }

  // Padding queries to reach 200+ total (short + exact)
  for (let i = 0; i < 10; i++) {
    const entry = pick(rng, activeEntries);
    const firstWord = entry.content.split(/\s+/).filter((w) => w.length > 3)[0] ?? entry.tags[0] ?? "general";
    queries.push({
      id: `q-pad-${String(queries.length + 1).padStart(3, "0")}`,
      query: firstWord,
      relevantEntryIds: [entry.id],
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: "padding short query from active entry",
      isHoldout: false,
      queryClass: "short",
    });
  }
  for (let i = 0; i < 10; i++) {
    const entry = pick(rng, activeEntries);
    const tag = pick(rng, entry.tags.filter((t) => t.length > 3)) ?? "topic";
    queries.push({
      id: `q-pad-${String(queries.length + 1).padStart(3, "0")}`,
      query: `what do we know about ${tag}`,
      relevantEntryIds: activeEntries.filter((e) => e.tags.includes(tag)).slice(0, 3).map((e) => e.id),
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: "padding topic query from tag",
      isHoldout: false,
      queryClass: "paraphrase",
    });
  }
  for (let i = 0; i < 10; i++) {
    const entry = pick(rng, activeEntries);
    const sym = pick(rng, entry.relatedSymbols.filter((s) => s.length > 3));
    if (!sym) continue;
    queries.push({
      id: `q-pad-${String(queries.length + 1).padStart(3, "0")}`,
      query: sym,
      relevantEntryIds: [entry.id],
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: "padding symbol query",
      isHoldout: false,
      queryClass: "exact-symbol",
    });
  }

  // Final padding to guarantee >=200 total queries (>=149 tuning needed with 51 holdout)
  for (let i = 0; i < 10; i++) {
    const entry = pick(rng, activeEntries);
    queries.push({
      id: `q-pad-${String(queries.length + 1).padStart(3, "0")}`,
      query: entry.content.split(".").slice(0, 1).join(" ").substring(0, 80),
      relevantEntryIds: [entry.id],
      harmfulEntryIds: [],
      annotator: "eval-system",
      rationale: "sentence-prefix padding query",
      isHoldout: false,
      queryClass: "paraphrase",
    });
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------
export function generateCorpus(
  seed: number,
  version: string,
  fixedNow: string,
): { corpus: EvaluationCorpus; holdout: LabeledQuery[] } {
  resetCounter();
  const rng = mulberry32(seed);

  // Generate entry templates first — including the contradiction pair
  const contradictions = generateContradictionPair(rng, fixedNow);
  const conflictIds = new Map<string, string>();
  // Manually set up conflict references
  contradictions[0].supersedes = [contradictions[1].id];
  contradictions[1].supersedes = [contradictions[0].id];

  const entries: CorpusEntry[] = [...contradictions];

  for (const tmpl of ENTRY_TEMPLATES) {
    if (tmpl.conflictWith) {
      // Already handled via contradiction pair
      continue;
    }
    entries.push(generateEntry(tmpl, rng, fixedNow));
  }

  // Generate all queries, then dedupe label arrays so a raw label list never
  // counts the same id twice (recall uses Set semantics; keep the corpus honest).
  const allQueries = generateQueries(entries, rng, fixedNow).map((q) => ({
    ...q,
    relevantEntryIds: [...new Set(q.relevantEntryIds)],
    harmfulEntryIds: [...new Set(q.harmfulEntryIds)],
  }));

  // Split holdout (50+) from tuning
  const holdoutCount = 51;
  const holdout: LabeledQuery[] = allQueries.slice(0, holdoutCount).map((q) => ({
    ...q,
    isHoldout: true,
  }));
  const tuningQueries = allQueries.slice(holdoutCount).map((q) => ({
    ...q,
    isHoldout: false,
  }));

  const negativeQueries = tuningQueries.filter(
    (q) => q.queryClass === "ambiguous-negative" || q.queryClass === "poisoning" || q.queryClass === "stale-evidence" || q.queryClass === "injection-canary",
  );

  const corpus: EvaluationCorpus = {
    version,
    generatedAt: fixedNow,
    totalEntries: entries.length,
    totalQueries: tuningQueries.length,
    holdoutQueries: holdout.length,
    negativeQueries: negativeQueries.length,
    entries,
    queries: tuningQueries,
  };

  return { corpus, holdout };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const SEED = 42;
  const VERSION = "1.0.1";
  const { corpus, holdout } = generateCorpus(SEED, VERSION, FIXED_NOW);

  const outDir = dirname(fileURLToPath(import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const corpusPath = join(outDir, `corpus-${VERSION}.json`);
  writeFileSync(corpusPath, JSON.stringify(corpus, null, 2), "utf8");

  const holdoutPath = join(outDir, `corpus-${VERSION}-holdout.json`);
  writeFileSync(holdoutPath, JSON.stringify(holdout, null, 2), "utf8");

  // Count by query class
  const classCounts: Record<string, number> = {};
  for (const q of [...corpus.queries, ...holdout]) {
    classCounts[q.queryClass] = (classCounts[q.queryClass] ?? 0) + 1;
  }

  console.log(`Corpus v${VERSION} generated:`);
  console.log(`  Entries:         ${corpus.totalEntries}`);
  console.log(`  Tuning queries:  ${corpus.totalQueries}`);
  console.log(`  Holdout queries: ${corpus.holdoutQueries}`);
  console.log(`  Negative:        ${corpus.negativeQueries}`);
  console.log(`  Query classes:`);
  for (const [cls, count] of Object.entries(classCounts).sort()) {
    console.log(`    ${cls}: ${count}`);
  }
  console.log(`\n  ${corpusPath}`);
  console.log(`  ${holdoutPath}`);
}
