/**
 * File summarization and symbol extraction.
 *
 * Summaries are DETERMINISTIC and local: they do not call a model. They extract
 * a structural outline (top-of-file comment, exported/public symbols, and a
 * truncated head) which is cheap and reproducible. A model-backed summarizer
 * could later implement the same `summarizeFile` signature.
 */

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
};

export function detectLanguage(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
}

/** Patterns extracting declared symbol names per language family. */
const SYMBOL_PATTERNS: Array<{ langs: string[]; re: RegExp }> = [
  {
    langs: ["typescript", "javascript"],
    re: /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  },
  { langs: ["python"], re: /^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm },
  { langs: ["go"], re: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g },
  { langs: ["rust"], re: /\b(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/g },
  { langs: ["java", "csharp", "kotlin", "scala", "swift"], re: /\b(?:class|interface|enum|fun|func|def)\s+([A-Za-z_]\w*)/g },
  { langs: ["ruby"], re: /^\s*(?:def|class|module)\s+([A-Za-z_]\w*)/gm },
];

/** Import-hint patterns per language family. Regex only; not semantic. */
const IMPORT_PATTERNS: Array<{ langs: string[]; re: RegExp }> = [
  { langs: ["typescript", "javascript"], re: /\b(?:import\b[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g },
  { langs: ["python"], re: /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm },
  { langs: ["go"], re: /(?:^|\s)"([\w./-]+)"/gm },
  { langs: ["rust"], re: /\buse\s+([A-Za-z_][\w:]*)/g },
  { langs: ["ruby"], re: /\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g },
];

/** Normalize a raw import specifier: relative specifiers are resolved relative to
 * the importing file's directory into a project-relative path; package/module
 * specifiers are kept verbatim. Never returns an absolute or escaping path. */
export function normalizeImport(spec: string, fromRel: string): string {
  const s = spec.trim();
  if (!s) return "";
  if (!(s.startsWith("./") || s.startsWith("../"))) return s.slice(0, 200);
  const segs = fromRel.split("/").slice(0, -1);
  for (const part of s.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") { if (segs.length) segs.pop(); else return ""; }
    else segs.push(part);
  }
  const joined = segs.join("/");
  return joined.startsWith("..") ? "" : joined.slice(0, 500);
}

export function extractImports(content: string, language: string | undefined, fromRel: string): string[] {
  const out = new Set<string>();
  const applicable = IMPORT_PATTERNS.filter((p) => !language || p.langs.includes(language));
  for (const { re } of applicable) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(content)) !== null && guard < 2000) {
      guard++;
      const raw = m[1] ?? m[2];
      if (!raw) continue;
      const norm = normalizeImport(raw, fromRel);
      if (norm) out.add(norm);
    }
  }
  return Array.from(out).slice(0, 100);
}

export function extractSymbols(content: string, language?: string): string[] {
  const symbols = new Set<string>();
  const applicable = SYMBOL_PATTERNS.filter(
    (p) => !language || p.langs.includes(language),
  );
  const patterns = applicable.length ? applicable : SYMBOL_PATTERNS;
  for (const { re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(content)) !== null && guard < 2000) {
      guard++;
      if (m[1]) symbols.add(m[1]);
    }
  }
  return Array.from(symbols).slice(0, 200);
}

export interface SummaryInput {
  path: string;
  content: string;
  language?: string;
  maxChars?: number;
}

/**
 * Produce a deterministic structural summary of a file. Not a model summary.
 */
export function summarizeFile(input: SummaryInput): string {
  const maxChars = input.maxChars ?? 1200;
  const lines = input.content.split("\n");
  const header: string[] = [];

  // Leading comment block / docstring.
  for (const line of lines.slice(0, 20)) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith('"""')) {
      header.push(t.replace(/^\/\*+|\*+\/$/g, "").replace(/^[/#*"\s]+/, "").trim());
    } else if (t.length && header.length) {
      break;
    }
    if (header.length >= 5) break;
  }

  const symbols = extractSymbols(input.content, input.language);
  const parts: string[] = [];
  parts.push(`File: ${input.path}${input.language ? ` (${input.language})` : ""}`);
  parts.push(`Lines: ${lines.length}`);
  if (header.filter(Boolean).length) {
    parts.push(`Purpose: ${header.filter(Boolean).join(" ").slice(0, 200)}`);
  }
  if (symbols.length) {
    parts.push(`Symbols: ${symbols.slice(0, 30).join(", ")}`);
  }
  const summary = parts.join("\n");
  return summary.length > maxChars ? summary.slice(0, maxChars) + "…" : summary;
}
