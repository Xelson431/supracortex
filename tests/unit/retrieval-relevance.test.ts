import test from "node:test";
import assert from "node:assert";
import {
  buildQueryContext,
  recommendSkills,
  scoreFile,
  selectFiles,
  TokenBudget,
} from "../../packages/core/src/index.ts";
import type { IndexedFile, SkillMetadata } from "../../packages/core/src/index.ts";

function idxFile(path: string, symbols: string[], tokens = 100): IndexedFile {
  return {
    path,
    hash: `h-${path}`,
    sizeBytes: tokens * 4,
    estimatedTokens: tokens,
    symbols,
    imports: [],
    indexedAt: new Date().toISOString(),
    mtimeMs: 1,
  };
}

function skill(name: string, description: string, triggers: string[] = []): SkillMetadata {
  return {
    name,
    description,
    location: `/skills/${name}`,
    scope: "global",
    contentHash: `h-${name}`,
    estimatedTokens: 10,
    triggers,
    compatibleAgents: [],
  };
}

const AUTH_QUERY = "how does authentication work in this app";

test("auth query ranks src/lib/auth.ts above generic app files", () => {
  // Five-file scratch: two generic app-router files, one stylesheet, the auth
  // module, and an unrelated library file.
  const index: Record<string, IndexedFile> = {
    "src/app/layout.tsx": idxFile("src/app/layout.tsx", [], 50),
    "src/app/page.tsx": idxFile("src/app/page.tsx", [], 50),
    "src/app/globals.css": idxFile("src/app/globals.css", [], 20),
    "src/lib/auth.ts": idxFile("src/lib/auth.ts", ["createSession", "verifySession"], 80),
    "src/lib/db.ts": idxFile("src/lib/db.ts", ["connect"], 60),
  };
  const ctx = buildQueryContext(AUTH_QUERY, [], [], []);
  const score = (path: string) =>
    scoreFile({ path, symbols: index[path]?.symbols ?? [] }, ctx, false);
  const auth = score("src/lib/auth.ts");
  const layout = score("src/app/layout.tsx");
  const page = score("src/app/page.tsx");

  assert.ok(auth > layout, `auth ${auth} must outrank layout ${layout}`);
  assert.ok(auth > page, `auth ${auth} must outrank page ${page}`);
  assert.ok(auth >= 0.15, "auth reaches the selector's minimum score");
  // `app` is generic structural noise: it may match, but only weakly.
  assert.ok(layout < 0.2, `generic app score ${layout} must be down-weighted`);
  assert.ok(page < 0.2, `generic app score ${page} must be down-weighted`);

  // Exercise the real selector: the auth module is selected first.
  const selection = selectFiles({
    index,
    summaries: {},
    ctx,
    budget: new TokenBudget(100_000),
    options: {
      maxRecommendedReads: 6,
      summaryThresholdTokens: 3000,
      preferChangedFiles: true,
    },
  });
  assert.equal(selection.files[0]?.path, "src/lib/auth.ts");
});

test("low-signal path tokens contribute 30% of the normal path weight", () => {
  const generic = scoreFile(
    { path: "src/app/page.tsx", symbols: [] },
    buildQueryContext("app", [], [], []),
    false,
  );
  const specific = scoreFile(
    { path: "src/widget.ts", symbols: [] },
    buildQueryContext("widget", [], [], []),
    false,
  );
  assert.ok(specific > generic);
  assert.ok(Math.abs(generic / specific - 0.3) < 1e-9);
});

test("prefix matching bridges inflections without crossing unrelated roots", () => {
  const authCtx = buildQueryContext("authentication", [], [], []);
  // `auth` and `authentication` share the first four characters: 50% weight.
  assert.equal(scoreFile({ path: "src/lib/auth.ts", symbols: [] }, authCtx, false), 0.5);
  // `db` cannot prefix-match `authentication`.
  assert.equal(scoreFile({ path: "src/lib/db.ts", symbols: [] }, authCtx, false), 0);
});

test("skills: stopword-only queries do not recommend unrelated global skills", () => {
  const skills = [
    skill("notfair-gemini", "inspects the in-process gemini integration", ["in"]),
    skill("authentication-review", "reviews authentication and session flows", [
      "authentication",
    ]),
  ];

  const stopwordOnly = recommendSkills({
    skills,
    queryTokens: ["in", "the", "a", "to"],
    alreadyLoaded: [],
  });
  assert.equal(stopwordOnly.recommended.length, 0, "no skill is matched by filler words");

  const genericOnly = recommendSkills({
    skills,
    queryTokens: ["app"],
    alreadyLoaded: [],
  });
  assert.equal(genericOnly.recommended.length, 0, "generic path names alone are not evidence");

  const specific = recommendSkills({
    skills,
    queryTokens: ["authentication"],
    alreadyLoaded: [],
  });
  assert.ok(
    specific.recommended.some((r) => r.name === "authentication-review"),
    "a distinctive token recommends the matching skill",
  );
  assert.ok(
    !specific.recommended.some((r) => r.name === "notfair-gemini"),
    "the unrelated global skill is not recommended",
  );
});
