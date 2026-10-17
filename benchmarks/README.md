# Benchmarks

Two harnesses live here:

| File | Purpose |
|---|---|
| `run.ts` | Deterministic offline quality harness (retrieval, redaction, handoff, token budget, code-graph integrity). Timing is diagnostic only. |
| `eval.ts` | Versioned-corpus retrieval evaluation with metric schema v2 (answerable quality, negative/abstention safety, ceilings, bootstrap CIs, per-class breakdowns, FTS sidecar verification). |

## `run.ts` — deterministic quality harness

```bash
node benchmarks/run.ts
# or
pnpm bench
```

Loads committed fixtures into a temp `Engine` and scores retrieval, stale/candidate
exclusion, secret redaction, handoff completeness, and token-budget conformance. The
clock and inputs are fixed; timing is printed but never a pass/fail assertion.

## `eval.ts` — retrieval evaluation (metric schema v2)

```bash
# Full evaluation (writes benchmarks/results/<retriever>-<corpus>-<datetime>.json)
node benchmarks/eval.ts --retriever deterministic --corpus 1.0.1
node benchmarks/eval.ts --retriever fts5          --corpus 1.0.1

# Explicit output path
node benchmarks/eval.ts --retriever fts5 --corpus 1.0.1 --out benchmarks/results/my-run.json

# Gate mode (exits 1 on failure)
node benchmarks/eval.ts --retriever fts5 --corpus 1.0.1 --gate
```

Every result document starts with `"metricSchemaVersion": 2`.

### Why v2 exists

The v1 headline averaged recall/MRR/nDCG over **all** queries. Most queries have
zero relevant labels, so they contributed `0` by construction and diluted the
numbers. v1 p@5 was also ceiling-limited, duplicate label ids inflated recall
denominators, and the FTS run never backfilled the live sidecar. **v1 result
files are retired and are not comparable to v2.** `compareBaseline` refuses to
compare across metric schema versions with an explicit error.

### Corpus 1.0.1 label semantics

`harmfulEntryIds` means **content that must not be shown**: non-active records
(`candidate`, `stale`, `superseded`, `disputed`, `forgotten`) or genuinely
wrong/unsafe records. An **active, correct fact that contradicts the user's
request is never harmful**. It is corrective evidence and belongs in
`relevantEntryIds`; the query is answerable.

Corpus 1.0.1 fixes label defects while keeping all 93 entries unchanged:

- Contradictory requests with an active corrector ("use MySQL" -> PostgreSQL,
  "deploy to Heroku" -> Azure, "use MongoDB" -> PostgreSQL, "npm" -> pnpm,
  "class component" -> function components) are now answerable
  (`queryClass: "contradiction"`) instead of labeling the corrector harmful.
- Active-entry matching is word-boundary based, so `npm` no longer matches
  inside `pnpm`, and `validation` no longer matches inside `invalidation`.
  A trailing plural is still allowed (`class component` matches
  `class components`).
- `q-typo-004` targets the disputed `e-0073` record, not an active failure.
- Injection canaries no longer label active records that merely contain a
  lexical token such as `token` or `AWS`; this corpus has no genuinely
  secret-shaped record, so those queries carry no harmful labels.
- Stale/superseded negative queries label their non-active records, and all
  label arrays are deduped.

No entries were added, removed, or edited. Recall denominators are unchanged by
deduping because the harness already used `Set(relevantEntryIds).size`.

### Answerable metrics

Computed only over queries with at least one relevant label
(`relevantEntryIds.length > 0`):

- `n`
- `hitRateAt1`
- `recallAt1`, `recallAt5`, `recallAt10`
- `mrr`
- `ndcgAt5`
- `medianFirstRelevantRank` — 1-based median rank of the first relevant result;
  misses are assigned `maxEntries + 1` so missing results are never rewarded.
- `misses`
- `bootstrap95.recallAt5` / `bootstrap95.ndcgAt5`

**Dedupe rule:** the recall denominator is `Set(relevantEntryIds).size`. Corpus
1.0.1 label arrays are deduped, so `relevantCount` and `uniqueRelevantCount`
agree; the harness still uses a `Set` so a future raw label cannot inflate the
denominator. This matches nDCG, which already used a set.

### Negative / abstention safety

Computed over queries with zero relevant labels (no positive answer expected):

- `n`, `nWithHarmfulLabels`
- `harmfulRate` — non-active harmful records in the top 5 / top-5 slots
- `staleRate` — `status === "stale"` records in the top 5 / top-5 slots
- `conflictRate` — active records labeled harmful in the top 5 / top-5 slots.
  Under the 1.0.1 semantics this should be zero: an active corrector is labeled
  relevant, not harmful. A non-zero value means the corpus still labels active
  evidence as contradictory, and the gate fails rather than hiding it.
- `abstained` / `abstentionRate` — queries where `resultCount === 0`.

These are safety/diagnostic numbers, not quality scores. They are reported for
tuning and holdout separately.

### Ceiling

- `ceiling.precisionAt5 = Σ min(uniqueRelevant, 5) / 5 / nAnswerable`
- `ceiling.recallAt5 = Σ min(uniqueRelevant, 5) / uniqueRelevant / nAnswerable`
- `ceiling.queriesWithRelevantOver5`

The old all-query p@5 ceiling was ~0.097 (tuning) / ~0.173 (holdout) because
empty-label queries were in the denominator. The answerable ceilings are higher
and are the correct context for a p@5 number.

### Bootstrap confidence intervals

`recall@5` and `nDCG@5` include a 95% percentile-bootstrap interval:

- fixed seed `0x5eedc0de` (`mulberry32`)
- 1000 resamples
- intervals use the percentile method at 2.5% / 97.5%

The same inputs produce the same interval.

### Per-query-class breakdown

`tuning.byQueryClass` and `holdout.byQueryClass` contain `answerable`, `ceiling`,
and `negatives` blocks. The required classes `long`, `contradiction`,
`changed-file`, `typo`, and `multilingual` are always present; classes absent
from a split are reported with zero counts rather than omitted.

### Legacy block

`tuning.legacy` and `holdout.legacy` retain the old all-query aggregates
(including the raw-label recall denominator) **only** so historical numbers can
be interpreted. They are not headline quality and are never used by the gate.

### Gate definition

The v2 gate intentionally ignores the all-query average:

1. **Holdout answerable quality:** `holdout.answerable.recallAt5 >= 0.4` **and**
   `holdout.answerable.ndcgAt5 >= 0.4`.
2. **Labeled-negative safety:** zero `harmfulRate`, `staleRate`, and
   `conflictRate` on the tuning **and** holdout negative sets.

Conflict rate is a real gate input. Active corrective evidence must be labeled
relevant; if any active entry remains in `harmfulEntryIds`, its retrieval is
reported as a conflict and fails the gate. The threshold is not relaxed and
conflicts are never silently reclassified as safe.

### FTS correctness

For `--retriever fts5`, the harness:

1. Bulk-loads corpus entries into SQLite.
2. Calls `ensureFtsSidecar()` and `ftsBackfillSidecar()` **before** retrieval.
3. Verifies `ftsIntegrityCheck()` reports `ok`, `contentCount > 0`, and
   `ftsCount > 0`; otherwise the run throws instead of falling back silently.
4. Records the resolved FTS source for every query in
   `retrieval.fts.sources` (`sidecar`, `legacy`, `like`, `none`) and in each
   `perQuery.ftsSource`.
5. Throws if any query resolves the retired `legacy` `memory_fts` path or if no
   query resolves `sidecar`.

`like` (substring over the sidecar content mirror) and `none` (no FTS token
match, lexical-only retrieval) are recorded explicitly, not hidden. Tag
indexing is intentionally deferred.

### Reproducibility

With the same corpus and code, metric values are deterministic, including the
bootstrap intervals. The following are expected to vary between runs and are
diagnostic only: `run.startedAt`, `run.finishedAt`, latency percentiles, peak RSS,
and the output filename timestamp. The FTS source counts should be stable.

### Baseline files

Stored under `benchmarks/results/` with the pattern
`<retriever>-<corpus>-<datetime>.json`.

`--gate` compares against the most recent baseline for the same retriever and
corpus version. Crossing corpus versions is a hard error. Crossing metric schema
versions is also a hard error; old v1 files must be deleted or regenerated.
