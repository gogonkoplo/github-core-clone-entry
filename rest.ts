// The REST v3 surface under /api/v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, serialized the way GitHub shapes them. Every reply is JSON with a
// string `message` on errors; ownership is the token's login — a repository under any other
// owner is a 404, never a 403.

import { parseCommit } from './git.ts';
import { VIEWER, type Forge, type IssueRec, type LabelRec, type PullRec, type RepoRec } from './store.ts';

export interface HttpCtx {
  method: string;
  /** Path segments after the leading '/', percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
  tokenOk: boolean;
}

export interface HttpReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const message = (text: string): { message: string } => ({ message: text });
const notFound = (): HttpReply => ({ status: 404, body: message('Not Found') });

// ---------------------------------------------------------------------------------------------
// serializers

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(forge: Forge, rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.id,
    name: rec.name,
    full_name: `${VIEWER.login}/${rec.name}`,
    owner: userJson(),
    private: rec.private,
    description: rec.description,
    default_branch: rec.defaultBranch,
    created_at: forge.isoOf(rec.seq),
    updated_at: forge.isoOf(rec.seq),
    html_url: `/${VIEWER.login}/${rec.name}`,
    clone_url: `/${VIEWER.login}/${rec.name}.git`,
    fork: false,
    archived: false,
    has_issues: true,
    open_issues_count: [...rec.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function labelJson(rec: LabelRec): Record<string, unknown> {
  return { name: rec.name, color: rec.color, description: rec.description, default: false };
}

export function issueJson(forge: Forge, repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  return {
    id: rec.id,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: null, default: false };
    }),
    user: userJson(),
    comments: rec.comments.length,
    created_at: forge.isoOf(rec.seq),
    updated_at: forge.isoOf(rec.seq),
    closed_at: rec.state === 'closed' ? forge.isoOf(rec.seq) : null,
    pull_request: undefined,
  };
}

export function commentJson(forge: Forge, rec: { id: number; body: string; seq: number }): Record<string, unknown> {
  return { id: rec.id, body: rec.body, user: userJson(), created_at: forge.isoOf(rec.seq), updated_at: forge.isoOf(rec.seq) };
}

export function pullJson(forge: Forge, repo: RepoRec, rec: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, rec.headRef) ?? rec.headSha;
  const baseSha = forge.branchTip(repo, rec.baseRef) ?? rec.baseSha;
  return {
    id: rec.id,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    merged: rec.merged,
    merged_at: rec.mergedSeq !== null ? forge.isoOf(rec.mergedSeq) : null,
    merge_commit_sha: rec.mergeCommitSha,
    mergeable: rec.state === 'open' ? forge.pullMergeable(repo, rec) === 'MERGEABLE' : null,
    head: { ref: rec.headRef, sha: headSha, label: `${VIEWER.login}:${rec.headRef}` },
    base: { ref: rec.baseRef, sha: baseSha, label: `${VIEWER.login}:${rec.baseRef}` },
    user: userJson(),
    created_at: forge.isoOf(rec.seq),
    updated_at: forge.isoOf(rec.seq),
  };
}

// ---------------------------------------------------------------------------------------------
// helpers

function parseJsonBody(ctx: HttpCtx): { value: Record<string, unknown> } | { error: HttpReply } {
  if (ctx.body.length === 0) return { value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: { status: 400, body: message('Malformed JSON body') } };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: { status: 400, body: message('Malformed JSON body') } };
  }
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const found = value[field];
  return typeof found === 'string' ? found : undefined;
}

function pagination(ctx: HttpCtx): { page: number; perPage: number } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

/** Slice one page and build the Link header (same-origin absolute URLs from the Host header). */
function paged<T>(ctx: HttpCtx, path: string, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(ctx);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<http://${ctx.host}${path}?${params.toString()}>`;
  };
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(totalPages)}; rel="last"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`, `${urlFor(1)}; rel="first"`);
  return { page: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

/** Line-level change counts between two texts (an LCS diff; the suite's files are small). */
function lineCounts(before: string | null, after: string | null): { additions: number; deletions: number } {
  const linesOf = (text: string | null): string[] => {
    if (text === null) return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(above, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// ---------------------------------------------------------------------------------------------
// route handlers

function rootReply(): HttpReply {
  return {
    status: 200,
    body: {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issues_url: '/api/v3/repos/{owner}/{repo}/issues',
      rate_limit_url: '/api/v3/rate_limit',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org, user' },
  };
}

function createRepo(forge: Forge, ctx: HttpCtx): HttpReply {
  const parsed = parseJsonBody(ctx);
  if ('error' in parsed) return parsed.error;
  const name = stringField(parsed.value, 'name');
  if (name === undefined || name === '') return { status: 422, body: message('Repository name is required') };
  const created = forge.createRepo(name, {
    private: parsed.value.private === true,
    description: stringField(parsed.value, 'description') ?? '',
  });
  if (created === 'exists') return { status: 422, body: message('Repository already exists') };
  return { status: 201, body: repoJson(forge, created) };
}

function repoScoped(forge: Forge, ctx: HttpCtx, owner: string, name: string, rest: string[]): HttpReply | null {
  const repo = forge.getRepo(owner, name);
  const method = ctx.method;
  const head = rest[0];

  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === null) return notFound();
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'PATCH') {
      if (repo === null) return notFound();
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const description = stringField(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      if (parsed.value.private !== undefined) repo.private = parsed.value.private === true;
      const defaultBranch = stringField(parsed.value, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return { status: 200, body: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      if (repo === null) return notFound();
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return null;
  }

  if (repo === null) return notFound();

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === null) return notFound();
      return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
    }
    return null;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const ref = stringField(parsed.value, 'ref');
      const sha = stringField(parsed.value, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
        return { status: 422, body: message('A ref and a sha are required') };
      }
      if (repo.refs.has(ref)) return { status: 422, body: message('Reference already exists') };
      const target = forge.objects.get(sha);
      if (target === undefined) return { status: 422, body: message(`Object ${sha} does not exist`) };
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: target.type } } };
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      const target = forge.objects.get(sha);
      return { status: 200, body: { ref, object: { sha, type: target?.type ?? 'commit' } } };
    }
    return null;
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const refish = ctx.query.get('sha') ?? repo.defaultBranch;
    const commits = forge.listCommits(repo, refish);
    const body = commits.map((entry) => {
      const object = forge.objects.get(entry.sha);
      const commit = object !== undefined ? parseCommit(object.data) : null;
      const identity = (line: string): { name: string; email: string; date: string } => {
        const match = /^(.*) <(.*)> (\d+) /.exec(line);
        if (match === null) return { name: '', email: '', date: forge.isoOf(repo.seq) };
        return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
      };
      return {
        sha: entry.sha,
        commit: {
          message: entry.message.endsWith('\n') ? entry.message.slice(0, -1) : entry.message,
          author: identity(commit?.author ?? ''),
          committer: identity(commit?.committer ?? ''),
          tree: { sha: commit?.tree ?? '' },
        },
        parents: (commit?.parents ?? []).map((sha) => ({ sha })),
      };
    });
    return { status: 200, body };
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const refish = ctx.query.get('ref') ?? repo.defaultBranch;
      const found = forge.readContent(repo, refish, path);
      if (found === null) return notFound();
      if (found.kind === 'file') {
        const name = path.split('/').pop() ?? path;
        return {
          status: 200,
          body: {
            name,
            path,
            sha: found.oid,
            size: found.size,
            type: 'file',
            encoding: 'base64',
            content: found.data.toString('base64'),
          },
        };
      }
      const entries = found.entries.map((entry) => {
        const isDir = entry.mode === '40000';
        const object = forge.objects.get(entry.oid);
        return {
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: isDir || object === undefined ? 0 : object.data.length,
          type: isDir ? 'dir' : 'file',
        };
      });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: entries };
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const contentB64 = stringField(parsed.value, 'content');
      const commitMessage = stringField(parsed.value, 'message');
      if (contentB64 === undefined || commitMessage === undefined) {
        return { status: 422, body: message('A message and content are required') };
      }
      const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
      const sha = stringField(parsed.value, 'sha');
      const result = forge.putContent(repo, branch, path, Buffer.from(contentB64, 'base64'), commitMessage, sha);
      if ('error' in result) {
        return result.error === 'conflict'
          ? { status: 409, body: message('The sha does not match the current file sha') }
          : { status: 422, body: message('The sha is missing or does not apply to this path') };
      }
      const name = path.split('/').pop() ?? path;
      return {
        status: result.created ? 201 : 200,
        body: {
          content: { name, path, sha: result.blobSha, size: Buffer.from(contentB64, 'base64').length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message: commitMessage },
        },
      };
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const commitMessage = stringField(parsed.value, 'message') ?? 'Delete file';
      const branch = stringField(parsed.value, 'branch') ?? repo.defaultBranch;
      const sha = stringField(parsed.value, 'sha');
      const result = forge.deleteContent(repo, branch, path, commitMessage, sha);
      if ('error' in result) {
        if (result.error === 'not-found') return notFound();
        return result.error === 'conflict'
          ? { status: 409, body: message('The sha does not match the current file sha') }
          : { status: 422, body: message('The sha is required to delete a file') };
      }
      return { status: 200, body: { content: null, commit: { sha: result.commitSha, message: commitMessage } } };
    }
    return null;
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const name = stringField(parsed.value, 'name');
      if (name === undefined || name === '') return { status: 422, body: message('A label name is required') };
      const colorRaw = stringField(parsed.value, 'color') ?? 'ededed';
      const created = forge.createLabel(repo, name, colorRaw.replace(/^#/, ''), stringField(parsed.value, 'description') ?? null);
      if (created === 'exists') return { status: 422, body: message('Label already exists') };
      return { status: 201, body: labelJson(created) };
    }
    return null;
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const direction = ctx.query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page, headers } = paged(ctx, `/api/v3/repos/${owner}/${name}/issues`, issues);
        return { status: 200, body: page.map((issue) => issueJson(forge, repo, issue)), headers };
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        const title = stringField(parsed.value, 'title');
        if (title === undefined || title === '') return { status: 422, body: message('An issue title is required') };
        const labelsRaw = parsed.value.labels;
        const labels: string[] = [];
        if (Array.isArray(labelsRaw)) {
          for (const entry of labelsRaw) {
            if (typeof entry === 'string') labels.push(entry);
            else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
              labels.push((entry as { name: string }).name);
            }
          }
        }
        const created = forge.createIssue(repo, { title, body: stringField(parsed.value, 'body') ?? '', labels });
        if ('error' in created) return { status: 422, body: message(`Unknown label: ${created.label}`) };
        return { status: 201, body: issueJson(forge, repo, created) };
      }
      return null;
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
      if (method === 'PATCH') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        const state = stringField(parsed.value, 'state');
        if (state !== undefined) {
          if (state !== 'open' && state !== 'closed') return { status: 422, body: message('State must be open or closed') };
          issue.state = state;
        }
        const title = stringField(parsed.value, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = stringField(parsed.value, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        return { status: 200, body: issueJson(forge, repo, issue) };
      }
      return null;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => commentJson(forge, comment)) };
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        const bodyText = stringField(parsed.value, 'body');
        if (bodyText === undefined) return { status: 422, body: message('A comment body is required') };
        const comment = forge.addComment(repo, issue, bodyText);
        return { status: 201, body: commentJson(forge, comment) };
      }
      return null;
    }
    return null;
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, headers } = paged(ctx, `/api/v3/repos/${owner}/${name}/pulls`, pulls);
        return { status: 200, body: page.map((pull) => pullJson(forge, repo, pull)), headers };
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if ('error' in parsed) return parsed.error;
        const title = stringField(parsed.value, 'title');
        const headRef = stringField(parsed.value, 'head');
        const baseRef = stringField(parsed.value, 'base');
        if (title === undefined || headRef === undefined || baseRef === undefined) {
          return { status: 422, body: message('A title, head and base are required') };
        }
        const created = forge.createPull(repo, {
          title,
          body: stringField(parsed.value, 'body') ?? '',
          head: headRef.replace(/^[^:]+:/, (prefix) => (prefix.slice(0, -1) === VIEWER.login ? '' : prefix)),
          base: baseRef,
        });
        if ('error' in created) return { status: 422, body: message(created.error) };
        return { status: 201, body: pullJson(forge, repo, created) };
      }
      return null;
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      const diff = forge.pullDiff(repo, pull);
      const body = diff.map((entry) => {
        const beforeObj = entry.before !== null ? forge.objects.get(entry.before) : undefined;
        const afterObj = entry.after !== null ? forge.objects.get(entry.after) : undefined;
        const counts = lineCounts(
          beforeObj !== undefined ? beforeObj.data.toString('utf8') : null,
          afterObj !== undefined ? afterObj.data.toString('utf8') : null,
        );
        return {
          sha: entry.after ?? entry.before ?? '',
          filename: entry.path,
          status: entry.status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        };
      });
      return { status: 200, body };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const parsed = parseJsonBody(ctx);
      if ('error' in parsed) return parsed.error;
      const outcome = forge.mergePull(repo, pull);
      if (!outcome.ok) {
        if (outcome.reason === 'not-found') return notFound();
        return { status: 405, body: message('Pull Request is not mergeable') };
      }
      return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return null;
  }

  return null;
}

/** Handle one /api/v3 request; null when the path is outside the REST surface. */
export function handleRest(forge: Forge, ctx: HttpCtx): HttpReply | null {
  const segments = ctx.segments;
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  if (!ctx.tokenOk) return { status: 401, body: message('Bad credentials') };
  const rest = segments.slice(2);

  if (rest.length === 0) {
    return ctx.method === 'GET' ? rootReply() : null;
  }
  if (rest[0] === 'meta' && rest.length === 1 && ctx.method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', git_url: '', api_url: '/api/v3' } };
  }
  if (rest[0] === 'user' && rest.length === 1 && ctx.method === 'GET') {
    return { status: 200, body: userJson() };
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (ctx.method === 'GET') {
      const { page, headers } = paged(ctx, '/api/v3/user/repos', forge.repoOrder);
      return { status: 200, body: page.map((rec) => repoJson(forge, rec)), headers };
    }
    if (ctx.method === 'POST') return createRepo(forge, ctx);
    return null;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    return repoScoped(forge, ctx, rest[1] as string, rest[2] as string, rest.slice(3));
  }
  return null;
}
