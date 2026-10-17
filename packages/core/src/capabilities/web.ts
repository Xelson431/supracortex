/**
 * Web capability detection over MCP server metadata (pure).
 *
 * SupraCortex does not ship its own HTTP search client; web search/fetch
 * happens through whichever providers the host has configured (Firecrawl,
 * Tavily, Brave Search, Exa, ...). This module recognizes those tools from
 * operational metadata so recommendations and status can say "web search is
 * available via X" instead of silently ignoring the capability.
 *
 * Matching is deliberately conservative: a tool counts as web search only
 * when its NAME suggests querying AND its server/description suggests the
 * web. This keeps filesystem `find`/`grep` out of the web bucket.
 */

import type { McpServerMetadata } from "../types.ts";

const WEB_SERVER_HINTS = [
  "firecrawl",
  "tavily",
  "brave",
  "exa",
  "serper",
  "perplexity",
  "google",
  "bing",
  "duckduckgo",
  "searx",
  "crawl",
  "scrape",
  "fetch",
  "web",
];

const SEARCH_TOOL_HINTS = ["search", "query", "lookup"];
const FETCH_TOOL_HINTS = ["fetch", "crawl", "scrape", "extract", "read_url", "get_url"];

const WEB_CONTEXT_HINTS = ["web", "url", "http", "site", "page", "search engine", "serp"];

function mentions(hay: string, hints: string[]): boolean {
  return hints.some((hint) => hay.includes(hint));
}

export function isWebSearchTool(
  serverName: string,
  toolName: string,
  description?: string,
): boolean {
  const name = toolName.toLowerCase();
  const context = `${serverName} ${description ?? ""}`.toLowerCase();
  if (!mentions(name, SEARCH_TOOL_HINTS)) return false;
  return mentions(context, WEB_SERVER_HINTS) || mentions(context, WEB_CONTEXT_HINTS);
}

export function isWebFetchTool(
  serverName: string,
  toolName: string,
  description?: string,
): boolean {
  const name = toolName.toLowerCase();
  const context = `${serverName} ${description ?? ""}`.toLowerCase();
  if (!mentions(name, FETCH_TOOL_HINTS)) return false;
  // Fetch/crawl/scrape names are web-specific enough on their own; the
  // server context only breaks ties against local file readers.
  if (mentions(name, ["read", "open", "cat"]) && !mentions(context, [...WEB_SERVER_HINTS, ...WEB_CONTEXT_HINTS])) {
    return false;
  }
  return true;
}

export interface WebCapabilities {
  /** Server names offering web search. */
  searchServers: string[];
  /** Server names offering URL fetch/content extraction. */
  fetchServers: string[];
}

export function detectWebCapabilities(servers: McpServerMetadata[]): WebCapabilities {
  const search = new Set<string>();
  const fetch = new Set<string>();
  for (const server of servers) {
    if (!server.enabled) continue;
    for (const tool of server.tools) {
      if (isWebSearchTool(server.name, tool.name, tool.description)) search.add(server.name);
      if (isWebFetchTool(server.name, tool.name, tool.description)) fetch.add(server.name);
    }
  }
  return { searchServers: [...search].sort(), fetchServers: [...fetch].sort() };
}
