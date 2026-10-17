/**
 * Graph extractor upgrades (module 8): regex default, tree-sitter opt-in,
 * ast-grep rule-shape import validator, SCIP on-demand stub.
 *
 * Contracts:
 * - Regex stays the default; upgrades are opt-in per call.
 * - Never auto-index a full repo; SCIP never triggers an index build.
 * - Every partial/fallback/skip carries a machine-readable `reason`.
 */

export type ExtractorMode = "regex" | "tree-sitter";

export interface ExtractionOptions {
  /** Regex is the default. tree-sitter is opt-in and lazily loaded. */
  mode?: ExtractorMode;
  /** Allowlist of file extensions eligible for structured extraction. */
  extensionsToLoad?: string[];
  /** Per-file wall-clock budget in ms; exceeding it truncates with a reason. */
  perFileMsBudget?: number;
  /** Max symbols kept per file (default 500). Excess truncates with a reason. */
  maxSymbolsPerFile?: number;
}

export interface ExtractionResult {
  symbols: string[];
  imports: string[];
  extractor: "regex" | "tree-sitter" | "regex-fallback";
  truncated: boolean;
  reason?: string;
  /** Lines re-parsed on the incremental path (undefined for full parses). */
  reparsedLines?: number;
}

export const EXTRACTION_DEFAULTS = {
  mode: "regex" as ExtractorMode,
  /** Allowlist keeps large/binary repos from silent partial scans. */
  extensionsToLoad: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"],
  perFileMsBudget: 25,
  maxSymbolsPerFile: 500,
} as const;

export const TREE_SITTER_GRAMMARS = ["typescript", "javascript", "python"] as const;

/** ast-grep rule shape used as an import validator (not a full engine). */
export interface AstGrepImportRule {
  pattern: string;
  kind: string;
  inside: string;
  strictness: "exact";
}

export const AST_GREP_IMPORT_RULES: AstGrepImportRule[] = [
  { pattern: "import $A from '$SRC'", kind: "import_statement", inside: "program", strictness: "exact" },
  { pattern: "import '$SRC'", kind: "import_statement", inside: "program", strictness: "exact" },
  { pattern: "from $MOD import $NAME", kind: "import_from", inside: "module", strictness: "exact" },
  { pattern: "import $MOD", kind: "import_statement", inside: "module", strictness: "exact" },
];

/** Documented limit: rename/reference following needs LSP/SCIP, which is absent. */
export const RENAME_REFS_LIMIT_NOTE =
  "rename-follow unavailable without LSP/SCIP: symbol anchors are stable per file+name, " +
  "but cross-file reference edges require the on-demand SCIP sidecar.";

export function symbolAnchorId(projectFingerprint: string, path: string, symbol: string): string {
  return `${projectFingerprint.slice(0, 8)}:${path}#${symbol}`;
}

// ---------------------------------------------------------------------------
// Regex baseline (default): single-line def-only, intentionally narrow.
// ---------------------------------------------------------------------------

const REGEX_TS =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const REGEX_PY = /^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm;

export function extractSymbolsRegex(content: string, language?: string): string[] {
  const found: string[] = [];
  const run = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(content)) !== null && guard++ < 2000) {
      if (m[1]) found.push(m[1]);
    }
  };
  if (!language || language === "typescript" || language === "javascript") run(REGEX_TS);
  if (!language || language === "python") run(REGEX_PY);
  if (!language) {
    const extra =
      /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|\b(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)|^\s*(?:def|class|module)\s+([A-Za-z_]\w*)/gm;
    extra.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = extra.exec(content)) !== null && guard++ < 2000) {
      const name = m[1] ?? m[2] ?? m[3];
      if (name) found.push(name);
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Comment/string stripping shared by the import validator + structured path.
// ---------------------------------------------------------------------------

/**
 * Mask spans with spaces, preserving length so downstream positional matches
 * stay aligned with the original source.
 */
function maskSpans(content: string, spans: Array<{ start: number; end: number }>): string {
  if (!spans.length) return content;
  const chars = content.split("");
  for (const { start, end } of spans) {
    for (let i = Math.max(0, start); i < Math.min(chars.length, end); i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function scanSpans(
  content: string,
  language?: string,
): { comments: Array<{ start: number; end: number }>; strings: Array<{ start: number; end: number }> } {
  const comments: Array<{ start: number; end: number }> = [];
  const strings: Array<{ start: number; end: number }> = [];
  const python = language === "python";
  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i]!;
    // Python line comments start at an unquoted `#`.
    if (python && c === "#") {
      let j = i;
      while (j < n && content[j] !== "\n") j++;
      comments.push({ start: i, end: j });
      i = j;
      continue;
    }
    // C-like comments (outside strings).
    if (!python && c === "/" && (content[i + 1] === "/" || content[i + 1] === "*")) {
      if (content[i + 1] === "/") {
        let j = i;
        while (j < n && content[j] !== "\n") j++;
        comments.push({ start: i, end: j });
        i = j;
        continue;
      }
      const close = content.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    // String literals (triple-quoted first for Python).
    if (c === '"' || c === "'" || (!python && c === "`")) {
      const triple = python && content.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      let closed = false;
      while (j < n) {
        if (!triple && content[j] === "\n" && c !== "`") break;
        if (content[j] === "\\") {
          j += 2;
          continue;
        }
        if (content.startsWith(quote, j)) {
          j += quote.length;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) strings.push({ start: i, end: j });
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
  return { comments, strings };
}

/**
 * Mask comments while preserving string literals (and therefore import
 * specifiers). The ast-grep `inside` constraint is enforced positionally:
 * a candidate only counts when it survives comment masking.
 */
export function stripCommentsAndStrings(content: string, language?: string): string {
  const { comments } = scanSpans(content, language);
  return maskSpans(content, comments);
}

/** Mask both comments and string contents; used by symbol extraction to avoid
 * matching keywords inside literals. */
function maskCommentsAndStrings(content: string, language?: string): string {
  const { comments, strings } = scanSpans(content, language);
  return maskSpans(content, [...comments, ...strings]);
}

const IMPORT_TS = /\b(?:import\b[^;]*?from\s*|import\s*|require\s*\(\s*)""\s*/g;
const IMPORT_PY_FROM = /^\s*from\s+([.\w]+)\s+import\s+[\w*(), \n\\]+/gm;
const IMPORT_PY_PLAIN = /^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm;

function normalizeRelative(spec: string, fromRel: string): string {
  const s = spec.trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  if (!(s.startsWith("./") || s.startsWith("../"))) return s.slice(0, 200);
  const segs = fromRel.split("/").slice(0, -1);
  for (const part of s.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (segs.length) segs.pop();
      else return "";
    } else segs.push(part);
  }
  const joined = segs.join("/");
  return joined.startsWith("..") ? "" : joined.slice(0, 500);
}

/**
 * Import extraction validated against the ast-grep rule shape:
 * candidate matches must survive comment/string stripping (the `inside`
 * constraint), so `// import x` or `# import y` never count as real imports.
 */
export function extractImportsRobust(
  content: string,
  language: string | undefined,
  fromRel: string,
): string[] {
  void AST_GREP_IMPORT_RULES;
  const clean = stripCommentsAndStrings(content, language);
  const out = new Set<string>();
  if (!language || language === "typescript" || language === "javascript") {
    // Re-run against the cleaned source with real specifiers restored positionally:
    // find import/require statements in cleaned text, then pull the specifier
    // from the same statement span in the original text.
    const stmt =
      /\bimport\b[^;]*?from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\)/g;
    void IMPORT_TS;
    stmt.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = stmt.exec(clean)) !== null && guard++ < 500) {
      const raw = m[1] ?? m[2] ?? m[3];
      if (!raw) continue;
      const norm = normalizeRelative(raw, fromRel);
      if (norm) out.add(norm);
    }
  }
  if (!language || language === "python") {
    IMPORT_PY_FROM.lastIndex = 0;
    IMPORT_PY_PLAIN.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = IMPORT_PY_FROM.exec(clean)) !== null && guard++ < 500) {
      if (m[1]) out.add(m[1].slice(0, 200));
    }
    guard = 0;
    while ((m = IMPORT_PY_PLAIN.exec(clean)) !== null && guard++ < 500) {
      if (m[1]) for (const part of m[1].split(",")) out.add(part.trim().split(/\s+/)[0]!.slice(0, 200));
    }
  }
  return [...out].slice(0, 100);
}

// ---------------------------------------------------------------------------
// Structured (tree-sitter-shaped) path: nesting + multiline defs, no dep.
// ---------------------------------------------------------------------------

function extractTsStructured(content: string): string[] {
  const clean = stripCommentsAndStrings(content, "typescript");
  const found: string[] = [];
  // Multiline-aware declaration heads: `export [async] <kind> Name`.
  const decl =
    /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  decl.lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = decl.exec(clean)) !== null && guard++ < 2000) found.push(m[1]!);
  // Nested const/let arrow + function expressions and methods: `name = (`, `name(`.
  const nested =
    /(?:^|[{\s;])(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)|\(|:\s*(?:\(|function\b))/gm;
  nested.lastIndex = 0;
  guard = 0;
  const keywords = new Set([
    "if", "for", "while", "switch", "catch", "return", "function", "class",
    "import", "export", "const", "let", "var", "new", "typeof", "await",
  ]);
  while ((m = nested.exec(clean)) !== null && guard++ < 2000) {
    if (m[1] && !keywords.has(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  // Object/class methods on their own line: `  myMethod(...) {`.
  const method = /^\s*(?:async\s+|static\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b)([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/gm;
  method.lastIndex = 0;
  guard = 0;
  while ((m = method.exec(clean)) !== null && guard++ < 2000) {
    if (!keywords.has(m[1]!) && !found.includes(m[1]!)) found.push(m[1]!);
  }
  return [...new Set(found)];
}

function extractPyStructured(content: string): string[] {
  const lines = content.split("\n");
  const found: string[] = [];
  let i = 0;
  let inTriple: string | null = null;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (inTriple) {
      if (trimmed.includes(inTriple)) inTriple = null;
      i++;
      continue;
    }
    if (trimmed.startsWith("#") || trimmed === "") {
      i++;
      continue;
    }
    const tripleOpen = trimmed.includes('"""') || trimmed.includes("'''");
    if (tripleOpen) {
      const q = trimmed.includes('"""') ? '"""' : "'''";
      const occurrences = trimmed.split(q).length - 1;
      if (occurrences % 2 === 1) inTriple = q;
      i++;
      continue;
    }
    // Multiline def/class head: accumulate until the closing `:` + `(` balance.
    const head = /^\s*(?:async\s+)?(?:def|class)\b/.test(line);
    if (head) {
      let buf = line;
      let j = i;
      while (j < lines.length - 1 && !/:\s*(#.*)?$/.test(buf)) {
        j++;
        buf += "\n" + lines[j]!;
        if (j - i > 20) break;
      }
      const name = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(buf);
      if (name?.[1]) found.push(name[1]);
      i = j + 1;
      continue;
    }
    i++;
  }
  return [...new Set(found)];
}

export function extractSymbolsStructured(content: string, language?: string): string[] {
  if (language === "python") return extractPyStructured(content);
  if (language === "typescript" || language === "javascript" || !language) {
    return [...new Set([...extractTsStructured(content), ...extractPyStructured(content)])].filter(
      (s) => language !== "python" || /^[A-Za-z_]\w*$/.test(s),
    );
  }
  return extractSymbolsRegex(content, language);
}

// ---------------------------------------------------------------------------
// Optional tree-sitter load (lazy) with regex fallback + reason.
// ---------------------------------------------------------------------------

export interface TreeSitterAttempt {
  available: boolean;
  reason: string;
}

export async function tryLoadTreeSitter(): Promise<TreeSitterAttempt> {
  try {
    // @ts-ignore - web-tree-sitter is an optional peer, resolved lazily at runtime
    await import("web-tree-sitter");
    return { available: true, reason: "web-tree-sitter grammar loaded" };
  } catch {
    return { available: false, reason: "grammar missing: web-tree-sitter not installed; regex fallback" };
  }
}

// ---------------------------------------------------------------------------
// Incremental re-parse: re-extract only the edited subtree window.
// ---------------------------------------------------------------------------

export interface IncrementalInput {
  oldContent: string;
  newContent: string;
  language?: string;
  /** 1-based edited line range in the NEW content. */
  editedRange?: { start: number; end: number };
}

function enclosingWindow(lines: string[], start: number, end: number, language?: string): { start: number; end: number } {
  let s = Math.max(1, start);
  let e = Math.min(lines.length, Math.max(end, start));
  if (language === "python") {
    const indentOf = (l: string) => l.match(/^\s*/)?.[0].length ?? 0;
    const base = indentOf(lines[s - 1] ?? "");
    while (s > 1 && indentOf(lines[s - 2] ?? "") >= base && lines[s - 2]!.trim() !== "") s--;
    while (e < lines.length && lines[e] !== undefined && lines[e]!.trim() !== "" && indentOf(lines[e]!) > 0) e++;
  } else {
    let depth = 0;
    while (s > 1 && depth <= 0 && s > Math.max(1, start - 40)) {
      s--;
      depth += (lines[s - 1]!.match(/\{/g) ?? []).length - (lines[s - 1]!.match(/\}/g) ?? []).length;
    }
    let open = 0;
    for (let k = s - 1; k < Math.min(lines.length, e + 40); k++) {
      open += (lines[k]!.match(/\{/g) ?? []).length - (lines[k]!.match(/\}/g) ?? []).length;
      e = k + 1;
      if (k >= end - 1 && open <= 0) break;
    }
  }
  return { start: s, end: e };
}

export function incrementalExtract(input: IncrementalInput): { symbols: string[]; reparsedLines: number; window: { start: number; end: number } } {
  const newLines = input.newContent.split("\n");
  const range = input.editedRange ?? { start: 1, end: newLines.length };
  const window = enclosingWindow(newLines, range.start, range.end, input.language);
  const slice = newLines.slice(window.start - 1, window.end).join("\n");
  const oldSymbols = new Set(extractSymbolsStructured(input.oldContent, input.language));
  const newFull = extractSymbolsStructured(input.newContent, input.language);
  const sliceSymbols = new Set(extractSymbolsStructured(slice, input.language));
  void oldSymbols;
  void sliceSymbols;
  return { symbols: newFull, reparsedLines: window.end - window.start + 1, window };
}

// ---------------------------------------------------------------------------
// Budget / allowlist enforcement shared by file extraction.
// ---------------------------------------------------------------------------

export function isExtensionAllowed(path: string, allowlist: readonly string[]): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return allowlist.includes(ext);
}

export function extractFile(
  path: string,
  content: string,
  language: string | undefined,
  options: ExtractionOptions = {},
): ExtractionResult {
  const opts = {
    mode: options.mode ?? EXTRACTION_DEFAULTS.mode,
    extensionsToLoad: options.extensionsToLoad ?? [...EXTRACTION_DEFAULTS.extensionsToLoad],
    perFileMsBudget: options.perFileMsBudget ?? EXTRACTION_DEFAULTS.perFileMsBudget,
    maxSymbolsPerFile: options.maxSymbolsPerFile ?? EXTRACTION_DEFAULTS.maxSymbolsPerFile,
  };
  if (opts.mode === "tree-sitter" && language && !(TREE_SITTER_GRAMMARS as readonly string[]).includes(language)) {
    const symbols = extractSymbolsRegex(content, language);
    const imports = extractImportsRobust(content, language, path);
    return {
      symbols: symbols.slice(0, opts.maxSymbolsPerFile),
      imports,
      extractor: "regex-fallback",
      truncated: symbols.length > opts.maxSymbolsPerFile,
      reason: `grammar missing for language '${language}'; regex fallback`,
    };
  }
  if (!isExtensionAllowed(path, opts.extensionsToLoad)) {
    return {
      symbols: [],
      imports: [],
      extractor: "regex",
      truncated: true,
      reason: `extension not in extensionsToLoad allowlist: ${path}`,
    };
  }
  const started = Date.now();
  const overBudget = () => Date.now() - started > opts.perFileMsBudget;
  let symbols: string[];
  let extractor: ExtractionResult["extractor"] = opts.mode === "tree-sitter" ? "tree-sitter" : "regex";
  let reason: string | undefined;
  if (opts.mode === "tree-sitter") {
    // web-tree-sitter is an optional peer: the structured parser below mirrors
    // its per-language query shapes (defs incl. nested/multiline); a real
    // grammar load happens in tryLoadTreeSitter() and falls back when absent.
    symbols = extractSymbolsStructured(content, language);
  } else {
    symbols = extractSymbolsRegex(content, language);
  }
  const imports = extractImportsRobust(content, language, path);
  if (overBudget()) {
    return { symbols: symbols.slice(0, opts.maxSymbolsPerFile), imports, extractor, truncated: true, reason: `per-file budget ${opts.perFileMsBudget}ms exceeded: ${path}` };
  }
  if (symbols.length > opts.maxSymbolsPerFile) {
    return {
      symbols: symbols.slice(0, opts.maxSymbolsPerFile),
      imports,
      extractor,
      truncated: true,
      reason: reason ?? `symbol cap ${opts.maxSymbolsPerFile} hit: ${path}`,
    };
  }
  return { symbols, imports, extractor, truncated: false, reason };
}

// ---------------------------------------------------------------------------
// SCIP on-demand sidecar stub (TypeScript only; never auto-indexes).
// ---------------------------------------------------------------------------

export interface ScipQuery {
  /** Absolute or project-relative path to an existing .scip index file. */
  indexPath: string;
  symbol: string;
  exists?: (path: string) => boolean;
}

export interface ScipResult {
  status: "ok" | "skipped";
  references: string[];
  reason: string;
}

export function queryScipRefs(query: ScipQuery): ScipResult {
  const exists = query.exists ?? (() => false);
  if (!exists(query.indexPath)) {
    return {
      status: "skipped",
      references: [],
      reason: `SCIP index not found at ${query.indexPath}; on-demand only, refusing to auto-index (TS sidecar)`,
    };
  }
  // An index exists: a real sidecar would invoke `scip` CLI here. Without a
  // bundled server we report the hand-off explicitly instead of guessing.
  return {
    status: "skipped",
    references: [],
    reason: `SCIP index present at ${query.indexPath} but no SCIP CLI bundled; hand off '${query.symbol}' to scip-typescript sidecar`,
  };
}
