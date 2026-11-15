# github-core-clone-01 — build notes

A GitHub-compatible git forge for make.fun's `github-core-clone-01`, written from scratch in
plain TypeScript on the Node standard library only (no dependencies, no git binary). One
in-memory store backs all four surfaces: git smart HTTP, REST v3, GraphQL v4 and MCP.

## Scores (measured 2026-11-15, this VM)

Server-style grading through the kit's own env (`grade-local --driver process`, entry booted
via its own `main.ts`, live pass + replay check):

| Practice trial | Feature /600 | Agent /200 | Perf /200 | Score /1000 |
| --- | --- | --- | --- | --- |
| trial-0 | 600 | 200 | 182 | 982 |
| trial-1 | 600 | 200 | 183 | 983 |
| trial-2 | 600 | 200 | 181 | 981 |

All 120 conformance checks pass in every trial (git 30, repos 15, issues 15, pulls 20,
graphql 20, mcp 15, protocol 5). Replay verdict: **L1 reproduced** (state export byte-identical
on replay), 0 nondeterministic trials, 0 timeouts. The house reference forge passes 120/120 and
earns ~100/200 perf at its own reference times, so the entry leads it by ~80 points with a
spread of 2 across trials.

Standalone runner medians (fresh server, one combined run): push p50 484 ms (47 pts),
clone p50 97 ms (43), read p50 605 ms (50), write p50 100 ms (48) → perf 188, score 988.
Reference medians (T_ref): push 1640.82 ms, clone 266.941 ms, read 2759.715 ms, write 348.965 ms.

## How to measure locally

Standalone conformance + benchmark (fresh server per run — the suite reuses fixed repo names):

```sh
# terminal 1: serve the entry
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types /tmp/serve.ts
#   /tmp/serve.ts: import { createApp } from '<entry>/app.ts'; createApp().listen(8931, '127.0.0.1')

# terminal 2: the kit's runner (from the kit dir)
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8931 --token test-token-123 --perf --json
```

Full server-style grading incl. the replay check (from the kit dir):

```sh
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/github-core-clone-entry \
  --driver process --instances 3 --json
```

`grade-local` reports `prize_eligible: false` locally with reasons
`no_transcripts / coverage_below_gate / cost_unpriced` — that is the transcript gate, settled at
submit time by bundling the building session's transcripts and Muse usage, not by entry code.

## Architecture

- `main.ts` — the starter's env lifecycle, unchanged: bind an ephemeral port, POST `{port}` to
  `$MAKEFUN_ENV_URL/register`, poll `/done`, exit 0.
- `app.ts` — one `node:http` server; parses the URL once, reads the body, checks the Bearer
  token against `MAKEFUN_SHOP_TOKEN`, dispatches to the four surfaces, stamps
  `X-GitHub-Request-Id` on API replies. Keep-alive timeout 75 s for the read benchmark.
- `store.ts` — the `Forge`: one global content-addressed git object store shared by all repos,
  repos keyed by name (single-tenant: the token's user is the scenario viewer), issues and PRs
  sharing one per-repo number counter, labels, comments, refs. A logical tick clock seeded from
  `MAKEFUN_TRIAL_NOW` (fallback: the scenario epoch) drives every id and timestamp — no
  `Date.now`/`Math.random` anywhere a check can compare, so a live run and its replay agree
  byte for byte.
- `git.ts` — SHA-1 object hashing, tree/commit/tag parse+build, flattened-tree diffing,
  ancestry/merge-base, pack write (plain objects) and pack read with full OFS/REF delta
  resolution and trailer verification, pkt-line codec, sideband framing.
- `gitserver.ts` — smart HTTP: v0 advertisements (HEAD first, capabilities on the first line,
  peeled tag lines), the v2 advertisement when `Git-Protocol: version=2`, ls-refs with prefix
  filtering (HEAD included), v2 fetch with acknowledgments/shallow-info/packfile sections
  (never a response-end packet), v0 fetch with side-band-64k, receive-pack with
  report-status (stale-info / non-fast-forward reasons verbatim), FF-only updates.
- `rest.ts` — REST v3: root + meta, user/repos CRUD with Link pagination, branches, git refs,
  commits (ancestor walk of one ref), contents PUT/DELETE with the sha rules (409 stale, 422
  missing), labels, issues (state/sort/direction filters, unknown label 422), comments, pulls
  (diff via merge-base with LCS line counts, squash merge → 200, conflict → 405, unknown → 404).
  Errors are always JSON with a string `message`; another owner is a 404, never a 403.
- `graphql.ts` — a small lexer/parser/executor for the documents gh and github-mcp-server send:
  viewer, repository fields, issue/pullRequest lookups, issues connections with cursor
  pagination and `orderBy CREATED_AT` (ties by number), Relay `node(id:)`, the
  createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations, introspection
  for Issue/PullRequest/Repository/SearchType, batching (array body → array of results), unknown
  field → 200 with an `errors` array naming the field, unknown repo → `data.repository = null`.
  Global ids are opaque base64 (`Type:key`), never the database id.
- `mcp.ts` — JSON-RPC 2.0 at `/mcp`: auth before anything (401 without a valid Bearer),
  `server/discover` advertising `2026-07-28` among supportedVersions plus the classic
  `initialize` handshake, `tools/list` byte-identical across calls (the tool table is built
  once), six tools over the same store (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`), `-32700` with HTTP 400 for a
  non-JSON body, `-32601` unknown method, `-32602` unknown tool / missing arguments, domain
  failures as `isError` results, a duplicate `create_repo` returns the existing repository.

## Remaining gaps / notes for the finisher

- Perf is 181–188 of 200; the residual is per-request HTTP overhead, not algorithmics (the
  depth-limited fetch planner already prunes at the depth boundary). The lead over the reference
  (~80 points, spread 2) does not depend on squeezing it.
- The trial pod runs Node v22.23.4 (this VM: v24.22.1); the code is plain type-strippable TS
  (no enums/namespaces/parameter properties) and uses no post-22 APIs.
- Submit-time transcript gate: the finisher must bundle this building session's transcripts and
  pass the Muse usage rows (`--muse-usage`) so `thinking_reproduces` / `thinking_priced` clear
  their thresholds; grade-local without a bundle shows `authored_coverage 0` for that reason
  alone.
- Nothing here submits anything; submission is a separate step under the quality gate and the
  T-10 timing rule.
