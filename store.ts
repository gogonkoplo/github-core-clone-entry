// The forge's state and domain logic: one in-memory store shared by the REST, GraphQL, MCP and
// git surfaces, so an object created on one surface is the same object on every other.
//
// Determinism: the suite replays a run and compares pass/fail bits, so nothing here reads the
// wall clock or a random source. Ids come from counters, timestamps from a logical clock seeded
// by MAKEFUN_TRIAL_NOW (or the scenario epoch when unset), and git object ids from content.

import {
  buildCommit,
  collectReachable,
  commitAncestors,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  storeFlatTree,
  treeDirEntries,
  type FlatEntry,
  type GitObject,
} from './git.ts';

/** The one user the bearer token names (the contest scenario's viewer; wire contract data). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';
const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, wire.ts's scenario epoch

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  seq: number;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'not-open' | 'conflict' | 'up-to-date' };

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRec>();
  readonly repoOrder: RepoRec[] = [];
  private tick = 0;
  private repoIdSeq = 0;
  private issueIdSeq = 0;
  private commentIdSeq = 0;
  readonly epochBase: number;

  constructor() {
    const trialNow = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = trialNow !== undefined && trialNow !== '' ? Date.parse(trialNow) : Number.NaN;
    this.epochBase = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : SCENARIO_EPOCH_SEC;
  }

  /** Advance the logical clock; the returned value orders and timestamps one mutation. */
  nextTick(): number {
    this.tick += 1;
    return this.tick;
  }

  /** The ISO timestamp for a logical tick (deterministic; monotonic in creation order). */
  isoOf(tick: number): string {
    return new Date((this.epochBase + tick) * 1000).toISOString();
  }

  identity(): string {
    return `${VIEWER.name} <${VIEWER.email}>`;
  }

  // -------------------------------------------------------------------------------------------
  // repositories

  createRepo(name: string, options: { private?: boolean; description?: string }): RepoRec | 'exists' {
    if (this.repos.has(name)) return 'exists';
    const rec: RepoRec = {
      id: (this.repoIdSeq += 1),
      name,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      seq: this.nextTick(),
    };
    this.repos.set(name, rec);
    this.repoOrder.push(rec);
    return rec;
  }

  /** A repository is visible only under its owner's login; any other owner is a 404. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    const rec = this.getRepo(owner, name);
    if (rec === null) return false;
    this.repos.delete(name);
    const index = this.repoOrder.indexOf(rec);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // git refs and commits inside one repository

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a ref-ish (branch name, full ref, tag name or commit sha) to a commit sha. */
  resolveCommit(repo: RepoRec, refish: string): string | null {
    let oid: string | undefined;
    if (refish.startsWith('refs/')) oid = repo.refs.get(refish);
    else if (repo.refs.has(`refs/heads/${refish}`)) oid = repo.refs.get(`refs/heads/${refish}`);
    else if (repo.refs.has(`refs/tags/${refish}`)) oid = repo.refs.get(`refs/tags/${refish}`);
    else if (this.objects.has(refish)) oid = refish;
    if (oid === undefined) return null;
    return peelToCommit(this.objects, oid);
  }

  treeOfCommit(commitSha: string): string | null {
    const object = this.objects.get(commitSha);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  flatAtCommit(commitSha: string | null): Map<string, FlatEntry> {
    if (commitSha === null) return new Map();
    const tree = this.treeOfCommit(commitSha);
    if (tree === null) return new Map();
    return flattenTree(this.objects, tree);
  }

  /** Create a commit object on top of `parent` (null for a root commit) and return its sha. */
  makeCommit(treeOid: string, parent: string | null, message: string): string {
    const tick = this.nextTick();
    const data = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      author: this.identity(),
      committer: this.identity(),
      timestamp: this.epochBase + tick,
      message,
    });
    const oid = hashObject('commit', data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  putBlob(data: Buffer): string {
    const oid = hashObject('blob', data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type: 'blob', data });
    return oid;
  }

  // -------------------------------------------------------------------------------------------
  // the contents API (also how REST fixtures build branches and commits)

  /**
   * Create or update one file on a branch, as PUT /contents does. `sha` is the blob id the
   * caller believes current: a mismatch on an existing file is a conflict (409), a missing sha
   * on an existing file or a sha for a file that does not exist is unprocessable (422).
   */
  putContent(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    sha?: string,
  ): { commitSha: string; blobSha: string; created: boolean } | { error: 'conflict' | 'unprocessable' } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    const flat = this.flatAtCommit(tip);
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (sha === undefined) return { error: 'unprocessable' };
      if (sha !== existing.oid) return { error: 'conflict' };
    } else if (sha !== undefined) {
      return { error: 'unprocessable' };
    }
    const blobSha = this.putBlob(content);
    flat.set(path, { mode: '100644', oid: blobSha });
    const tree = storeFlatTree(this.objects, flat);
    const commitSha = this.makeCommit(tree, tip, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created: existing === undefined };
  }

  /** Delete one file on a branch, as DELETE /contents does. */
  deleteContent(
    repo: RepoRec,
    branch: string,
    path: string,
    message: string,
    sha?: string,
  ): { commitSha: string } | { error: 'not-found' | 'conflict' | 'unprocessable' } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return { error: 'not-found' };
    const flat = this.flatAtCommit(tip);
    const existing = flat.get(path);
    if (existing === undefined) return { error: 'not-found' };
    if (sha === undefined) return { error: 'unprocessable' };
    if (sha !== existing.oid) return { error: 'conflict' };
    flat.delete(path);
    const tree = storeFlatTree(this.objects, flat);
    const commitSha = this.makeCommit(tree, tip, message);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Read a path at a ref: a file's blob, a directory's entries, or null when absent. */
  readContent(
    repo: RepoRec,
    refish: string,
    path: string,
  ):
    | { kind: 'file'; oid: string; data: Buffer; size: number }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; mode: string; oid: string }> }
    | null {
    const commit = this.resolveCommit(repo, refish);
    if (commit === null) return null;
    const tree = this.treeOfCommit(commit);
    if (tree === null) return null;
    if (path !== '') {
      const flat = flattenTree(this.objects, tree);
      const file = flat.get(path);
      if (file !== undefined) {
        const object = this.objects.get(file.oid);
        if (object === undefined) return null;
        return { kind: 'file', oid: file.oid, data: object.data, size: object.data.length };
      }
    }
    const entries = treeDirEntries(this.objects, tree, path);
    if (entries === null) return null;
    if (path === '' && entries.length === 0) return null;
    return { kind: 'dir', entries };
  }

  /** Commits reachable from a ref-ish, newest first (author time, then discovery order). */
  listCommits(repo: RepoRec, refish: string): Array<{ sha: string; message: string; authorTime: number }> {
    const tip = this.resolveCommit(repo, refish);
    if (tip === null) return [];
    const ancestors = commitAncestors(this.objects, tip);
    const rows: Array<{ sha: string; message: string; authorTime: number }> = [];
    for (const sha of ancestors) {
      const object = this.objects.get(sha);
      if (object === undefined) continue;
      const commit = parseCommit(object.data);
      rows.push({ sha, message: commit.message, authorTime: commit.authorTime });
    }
    // A stable newest-first order: walk from the tip so parents always follow their children,
    // which a plain time sort cannot promise for equal timestamps.
    const ordered: Array<{ sha: string; message: string; authorTime: number }> = [];
    const bySha = new Map(rows.map((row) => [row.sha, row]));
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const row = bySha.get(sha);
      if (row !== undefined) ordered.push(row);
      const object = this.objects.get(sha);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return ordered;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, comments

  createLabel(repo: RepoRec, name: string, color: string, description: string | null): LabelRec | 'exists' {
    if (repo.labels.has(name)) return 'exists';
    const rec: LabelRec = { name, color, description };
    repo.labels.set(name, rec);
    return rec;
  }

  createIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec | { error: 'bad-label'; label: string } {
    const labels = input.labels ?? [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: 'bad-label', label };
    }
    const rec: IssueRec = {
      kind: 'issue',
      number: repo.nextNumber++,
      id: (this.issueIdSeq += 1) + 1_000_000,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextTick(),
    };
    repo.issues.set(rec.number, rec);
    return rec;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const rec: CommentRec = { id: (this.commentIdSeq += 1) + 2_000_000, body, seq: this.nextTick() };
    issue.comments.push(rec);
    void repo;
    return rec;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests: diff, mergeability, squash merge

  createPull(repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec | { error: string } {
    const headTip = this.branchTip(repo, input.head);
    const baseTip = this.branchTip(repo, input.base);
    if (headTip === null) return { error: `head branch ${input.head} does not exist` };
    if (baseTip === null) return { error: `base branch ${input.base} does not exist` };
    if (input.head === input.base) return { error: 'head and base are the same branch' };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        return { error: 'a pull request already exists for this head and base' };
      }
    }
    const rec: PullRec = {
      kind: 'pull',
      number: repo.nextNumber++,
      id: (this.issueIdSeq += 1) + 1_000_000,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      headRef: input.head,
      baseRef: input.base,
      headSha: headTip,
      baseSha: baseTip,
      mergeCommitSha: null,
      mergedSeq: null,
      seq: this.nextTick(),
    };
    repo.pulls.set(rec.number, rec);
    return rec;
  }

  /** The paths a pull request changes: merge-base tree versus head tree. */
  pullDiff(repo: RepoRec, pull: PullRec): Array<{ path: string; status: 'added' | 'modified' | 'removed'; before: string | null; after: string | null }> {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(this.objects, baseTip, headTip) ?? baseTip;
    const before = this.flatAtCommit(base);
    const after = this.flatAtCommit(headTip);
    const paths = new Set([...before.keys(), ...after.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; before: string | null; after: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b !== undefined && a !== undefined && b.oid === a.oid) continue;
      if (b === undefined && a !== undefined) out.push({ path, status: 'added', before: null, after: a.oid });
      else if (b !== undefined && a === undefined) out.push({ path, status: 'removed', before: b.oid, after: null });
      else if (b !== undefined && a !== undefined) out.push({ path, status: 'modified', before: b.oid, after: a.oid });
    }
    return out;
  }

  /**
   * A three-way merge of flattened trees (merge-base, current base, head). Returns the merged
   * path map, or null when both sides changed the same path differently.
   */
  tryMergeTrees(repo: RepoRec, baseTip: string, headTip: string): Map<string, FlatEntry> | null {
    const base = mergeBase(this.objects, baseTip, headTip);
    const origin = base === null ? new Map<string, FlatEntry>() : this.flatAtCommit(base);
    const ours = this.flatAtCommit(baseTip);
    const theirs = this.flatAtCommit(headTip);
    const paths = new Set([...origin.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, FlatEntry>();
    for (const path of paths) {
      const o = origin.get(path);
      const b = ours.get(path);
      const h = theirs.get(path);
      const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
      if (same(b, h)) {
        if (b !== undefined) merged.set(path, b);
      } else if (same(o, b)) {
        if (h !== undefined) merged.set(path, h);
      } else if (same(o, h)) {
        if (b !== undefined) merged.set(path, b);
      } else {
        return null;
      }
    }
    void repo;
    return merged;
  }

  /** Whether an open pull request merges cleanly right now (its GraphQL `mergeable`). */
  pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return 'CONFLICTING';
    return this.tryMergeTrees(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch: one new commit carrying the merged tree. */
  mergePull(repo: RepoRec, pull: PullRec): MergeOutcome {
    if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { ok: false, reason: 'not-found' };
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base !== null && base === headTip) return { ok: false, reason: 'up-to-date' };
    const merged = this.tryMergeTrees(repo, baseTip, headTip);
    if (merged === null) return { ok: false, reason: 'conflict' };
    const tree = storeFlatTree(this.objects, merged);
    const sha = this.makeCommit(tree, baseTip, `${pull.title}\n\n${pull.body}`.trimEnd());
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedSeq = this.nextTick();
    return { ok: true, sha };
  }

  /** Every object reachable from all of a repository's refs (its clonable closure). */
  repoClosure(repo: RepoRec): Set<string> {
    return collectReachable(this.objects, repo.refs.values());
  }
}

export { isAncestor, parseCommit, parseTree };
