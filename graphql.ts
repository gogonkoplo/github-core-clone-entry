// The GraphQL v4 surface at /api/graphql: a small parser and executor covering the documents
// gh and github-mcp-server send — viewer, repository fields, issue/pull-request reads, the
// create/close/merge mutations, Relay node(id:), cursor pagination, introspection probes and
// operation batching. A GraphQL-level failure (an unknown field) is a 200 with an `errors`
// array naming the field; an unknown repository is data.repository = null with no errors.

import { VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids (Relay): opaque, stable, and never the plain database id

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGid = (rec: RepoRec): string => globalId('Repository', String(rec.id));
const issueGid = (repo: RepoRec, rec: IssueRec): string => globalId('Issue', `${repo.id}:${rec.number}`);
const pullGid = (repo: RepoRec, rec: PullRec): string => globalId('PullRequest', `${repo.id}:${rec.number}`);

// ---------------------------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'name', value: (match as RegExpExecArray)[0] });
      i += (match as RegExpExecArray)[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && (this.peek() as Token).kind === 'punct' && ((this.peek() as { value: string }).value === '(')) {
          this.parseVariableDefinitions();
        }
        this.parseDirectives();
        operations.push({ operation: token.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return;
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return args;
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      for (;;) {
        if (this.skipPunct(']')) return { kind: 'list', items };
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      for (;;) {
        if (this.skipPunct('}')) return { kind: 'object', fields };
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      if (this.skipPunct('}')) return selections;
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------------------------------------
// schema description (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'files',
    'author', 'url', 'createdAt', 'updatedAt', 'closedAt',
  ],
  Ref: ['name', 'target'],
  Commit: ['oid'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'type', 'isDeprecated'],
  __EnumValue: ['name', 'description', 'isDeprecated'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'ORG', 'PROJECT', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
};

// ---------------------------------------------------------------------------------------------
// execution

interface GNode {
  __typename: string;
  [key: string]: unknown;
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

class GqlError extends Error {}

function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

const userNode = (): GNode => ({ __typename: 'User', login: VIEWER.login });
const repoNode = (rec: RepoRec): GNode => ({ __typename: 'Repository', rec });
const issueNode = (repo: RepoRec, rec: IssueRec): GNode => ({ __typename: 'Issue', repo, rec });
const pullNode = (repo: RepoRec, rec: PullRec): GNode => ({ __typename: 'PullRequest', repo, rec });

function typeNode(name: string): GNode | null {
  if (TYPE_FIELDS[name] !== undefined) return { __typename: '__Type', name, kind: 'OBJECT' };
  if (TYPE_ENUMS[name] !== undefined) return { __typename: '__Type', name, kind: 'ENUM' };
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') {
    return { __typename: '__Type', name, kind: 'SCALAR' };
  }
  return null;
}

function findRepoByDbId(forge: Forge, dbId: number): RepoRec | null {
  return forge.repoOrder.find((rec) => rec.id === dbId) ?? null;
}

function nodeById(forge: Forge, id: string): GNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = findRepoByDbId(forge, Number(decoded.key));
    return repo === null ? null : repoNode(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':');
    const repo = findRepoByDbId(forge, Number(repoId));
    if (repo === null) return null;
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(Number(number));
      return issue === undefined ? null : issueNode(repo, issue);
    }
    const pull = repo.pulls.get(Number(number));
    return pull === undefined ? null : pullNode(repo, pull);
  }
  if (decoded.type === 'User') return userNode();
  return null;
}

function issuesConnection(forge: Forge, repo: RepoRec, args: Record<string, unknown>): GNode {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy !== null && typeof orderBy === 'object' ? orderBy.direction === 'DESC' : false;
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const cursorOf = (seq: number): string => Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const seq = Number(text.replace(/^cursor:/, ''));
      if (Number.isFinite(seq)) {
        issues = issues.filter((issue) => (descending ? issue.seq < seq : issue.seq > seq));
      }
    } catch {
      // an opaque cursor we did not mint: ignore it rather than fail the query
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
  const page = issues.slice(0, first);
  const last = page[page.length - 1];
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: issues.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorOf((page[0] as IssueRec).seq) : null,
      endCursor: last !== undefined ? cursorOf(last.seq) : null,
    } as GNode,
    totalCount: issues.length,
  };
}

type Resolver = (node: GNode, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (_node, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.getRepo(owner, name);
      return repo === null ? null : repoNode(repo);
    },
    node: (_node, args, ctx) => (typeof args.id === 'string' ? nodeById(ctx.forge, args.id) : null),
    __type: (_node, args) => (typeof args.name === 'string' ? typeNode(args.name) : null),
    __schema: () => ({
      __typename: '__Schema',
      queryType: typeNode('Query'),
      mutationType: typeNode('Mutation'),
      subscriptionType: null,
      types: [],
      directives: [],
    }),
  },
  Mutation: {
    createIssue: (_node, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, Number(decoded.key)) : null;
      if (repo === null) throw new GqlError('repository not found for createIssue');
      const created = ctx.forge.createIssue(repo, { title: input.title ?? '', body: input.body ?? '' });
      if ('error' in created) throw new GqlError(`unknown label: ${created.label}`);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created), clientMutationId: null };
    },
    closeIssue: (_node, args, ctx) => {
      const input = (args.input ?? {}) as { issueId?: string };
      const target = typeof input.issueId === 'string' ? nodeById(ctx.forge, input.issueId) : null;
      if (target === null || target.__typename !== 'Issue') throw new GqlError('issue not found for closeIssue');
      const issue = target.rec as IssueRec;
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: target, clientMutationId: null };
    },
    createPullRequest: (_node, args, ctx) => {
      const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, Number(decoded.key)) : null;
      if (repo === null) throw new GqlError('repository not found for createPullRequest');
      const created = ctx.forge.createPull(repo, {
        title: input.title ?? '',
        body: input.body ?? '',
        head: input.headRefName ?? '',
        base: input.baseRefName ?? '',
      });
      if ('error' in created) throw new GqlError(created.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created), clientMutationId: null };
    },
    mergePullRequest: (_node, args, ctx) => {
      const input = (args.input ?? {}) as { pullRequestId?: string };
      const target = typeof input.pullRequestId === 'string' ? nodeById(ctx.forge, input.pullRequestId) : null;
      if (target === null || target.__typename !== 'PullRequest') throw new GqlError('pull request not found for mergePullRequest');
      const repo = target.repo as RepoRec;
      const pull = target.rec as PullRec;
      const outcome = ctx.forge.mergePull(repo, pull);
      if (!outcome.ok) throw new GqlError(`pull request is not mergeable (${outcome.reason})`);
      return { __typename: 'MergePullRequestPayload', pullRequest: target, clientMutationId: null };
    },
    addComment: (_node, args, ctx) => {
      const input = (args.input ?? {}) as { subjectId?: string; body?: string };
      const target = typeof input.subjectId === 'string' ? nodeById(ctx.forge, input.subjectId) : null;
      if (target === null || target.__typename !== 'Issue') throw new GqlError('subject not found for addComment');
      const repo = target.repo as RepoRec;
      const issue = target.rec as IssueRec;
      const comment = ctx.forge.addComment(repo, issue, input.body ?? '');
      const commentNode: GNode = {
        __typename: 'IssueComment',
        id: globalId('IssueComment', String(comment.id)),
        body: comment.body,
        rec: comment,
        repo,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentNode, cursor: '' },
        subject: target,
        clientMutationId: null,
      };
    },
  },
  User: {
    id: () => globalId('User', String(VIEWER.id)),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `/${VIEWER.login}`,
  },
  Repository: {
    id: (node) => repoGid(node.rec as RepoRec),
    databaseId: (node) => (node.rec as RepoRec).id,
    name: (node) => (node.rec as RepoRec).name,
    nameWithOwner: (node) => `${VIEWER.login}/${(node.rec as RepoRec).name}`,
    owner: () => userNode(),
    defaultBranchRef: (node, _args, ctx) => {
      const repo = node.rec as RepoRec;
      const tip = ctx.forge.branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } } as GNode;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (node) => (node.rec as RepoRec).private,
    description: (node) => (node.rec as RepoRec).description,
    url: (node) => `/${VIEWER.login}/${(node.rec as RepoRec).name}`,
    createdAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as RepoRec).seq),
    updatedAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as RepoRec).seq),
    issue: (node, args) => {
      const repo = node.rec as RepoRec;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueNode(repo, issue);
    },
    issues: (node, args, ctx) => issuesConnection(ctx.forge, node.rec as RepoRec, args),
    pullRequest: (node, args) => {
      const repo = node.rec as RepoRec;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullNode(repo, pull);
    },
    pullRequests: (node, args) => {
      const repo = node.rec as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return wanted.has(state);
        });
      }
      pulls.sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
      const page = pulls.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullNode(repo, pull)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: pulls.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null } as GNode,
        totalCount: pulls.length,
      } as GNode;
    },
  },
  Issue: {
    id: (node) => issueGid(node.repo as RepoRec, node.rec as IssueRec),
    databaseId: (node) => (node.rec as IssueRec).id,
    number: (node) => (node.rec as IssueRec).number,
    title: (node) => (node.rec as IssueRec).title,
    body: (node) => (node.rec as IssueRec).body,
    state: (node) => (node.rec as IssueRec).state.toUpperCase(),
    author: () => userNode(),
    url: (node) => `/${VIEWER.login}/${(node.repo as RepoRec).name}/issues/${(node.rec as IssueRec).number}`,
    createdAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as IssueRec).seq),
    updatedAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as IssueRec).seq),
    closedAt: (node, _args, ctx) => ((node.rec as IssueRec).state === 'closed' ? ctx.forge.isoOf((node.rec as IssueRec).seq) : null),
  },
  PullRequest: {
    id: (node) => pullGid(node.repo as RepoRec, node.rec as PullRec),
    databaseId: (node) => (node.rec as PullRec).id,
    number: (node) => (node.rec as PullRec).number,
    title: (node) => (node.rec as PullRec).title,
    body: (node) => (node.rec as PullRec).body,
    state: (node) => {
      const pull = node.rec as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (node) => (node.rec as PullRec).merged,
    mergedAt: (node, _args, ctx) => {
      const pull = node.rec as PullRec;
      return pull.mergedSeq !== null ? ctx.forge.isoOf(pull.mergedSeq) : null;
    },
    mergeable: (node, _args, ctx) => {
      const pull = node.rec as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullMergeable(node.repo as RepoRec, pull);
    },
    headRefName: (node) => (node.rec as PullRec).headRef,
    baseRefName: (node) => (node.rec as PullRec).baseRef,
    headRefOid: (node, _args, ctx) => {
      const pull = node.rec as PullRec;
      return ctx.forge.branchTip(node.repo as RepoRec, pull.headRef) ?? pull.headSha;
    },
    baseRefOid: (node, _args, ctx) => {
      const pull = node.rec as PullRec;
      return ctx.forge.branchTip(node.repo as RepoRec, pull.baseRef) ?? pull.baseSha;
    },
    mergeCommit: (node) => {
      const pull = node.rec as PullRec;
      return pull.mergeCommitSha !== null ? ({ __typename: 'Commit', oid: pull.mergeCommitSha } as GNode) : null;
    },
    files: (node, args, ctx) => {
      const repo = node.repo as RepoRec;
      const pull = node.rec as PullRec;
      const diff = ctx.forge.pullDiff(repo, pull);
      const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: diff.slice(0, first).map((entry) => ({ __typename: 'PullRequestChangedFile', path: entry.path }) as GNode),
        totalCount: diff.length,
      } as GNode;
    },
    author: () => userNode(),
    url: (node) => `/${VIEWER.login}/${(node.repo as RepoRec).name}/pull/${(node.rec as PullRec).number}`,
    createdAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as PullRec).seq),
    updatedAt: (node, _args, ctx) => ctx.forge.isoOf((node.rec as PullRec).seq),
    closedAt: (node, _args, ctx) => {
      const pull = node.rec as PullRec;
      return pull.state === 'closed' ? ctx.forge.isoOf(pull.mergedSeq ?? pull.seq) : null;
    },
  },
  Ref: {
    name: (node) => node.name as string,
    target: (node) => (node.target as GNode | undefined) ?? null,
  },
  Commit: {
    oid: (node) => node.oid as string,
  },
  IssueConnection: {
    nodes: (node) => node.nodes as GNode[],
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (node) => node.nodes as GNode[],
    pageInfo: (node) => node.pageInfo as GNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (node) => node.nodes as GNode[],
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestChangedFile: {
    path: (node) => node.path as string,
  },
  PageInfo: {
    hasNextPage: (node) => node.hasNextPage as boolean,
    hasPreviousPage: (node) => node.hasPreviousPage as boolean,
    startCursor: (node) => (node.startCursor as string | null) ?? null,
    endCursor: (node) => (node.endCursor as string | null) ?? null,
  },
  IssueComment: {
    id: (node) => node.id as string,
    body: (node) => node.body as string,
    author: () => userNode(),
    createdAt: (node, _args, ctx) => ctx.forge.isoOf(((node.rec as { seq: number }).seq)),
  },
  CommentEdge: {
    node: (node) => node.node as GNode,
    cursor: (node) => node.cursor as string,
  },
  CreateIssuePayload: { issue: (node) => node.issue as GNode, clientMutationId: () => null },
  CloseIssuePayload: { issue: (node) => node.issue as GNode, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (node) => node.pullRequest as GNode, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (node) => node.pullRequest as GNode, clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (node) => node.commentEdge as GNode,
    subject: (node) => node.subject as GNode,
    clientMutationId: () => null,
  },
  __Type: {
    name: (node) => node.name as string,
    kind: (node) => node.kind as string,
    description: () => null,
    fields: (node) => {
      const fields = TYPE_FIELDS[node.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => ({ __typename: '__Field', name }) as GNode);
    },
    enumValues: (node) => {
      const values = TYPE_ENUMS[node.name as string];
      if (values === undefined) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }) as GNode);
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
  },
  __Field: { name: (node) => node.name as string, description: () => null, isDeprecated: () => false },
  __EnumValue: { name: (node) => node.name as string, description: () => null, isDeprecated: () => false },
  __Schema: {
    queryType: (node) => node.queryType as GNode,
    mutationType: (node) => node.mutationType as GNode,
    subscriptionType: () => null,
    types: (node) => node.types as GNode[],
    directives: (node) => node.directives as unknown[],
  },
};

/** Collect the fields of a selection set for one object, expanding fragments. */
function collectFields(
  selections: readonly SelectionNode[],
  typename: string,
  ctx: ExecCtx,
  out: Map<string, FieldNode>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const existing = out.get(key);
      if (existing === undefined) out.set(key, selection);
      else if (existing.selectionSet !== null && selection.selectionSet !== null) {
        existing.selectionSet = [...existing.selectionSet, ...selection.selectionSet];
      }
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typename) {
        collectFields(selection.selectionSet, typename, ctx, out);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typename) {
        collectFields(fragment.selectionSet, typename, ctx, out);
      }
    }
  }
}

function executeSelectionSet(selections: readonly SelectionNode[], node: GNode, ctx: ExecCtx): Record<string, unknown> {
  const fields = new Map<string, FieldNode>();
  collectFields(selections, node.__typename, ctx, fields);
  const out: Record<string, unknown> = {};
  for (const [key, field] of fields) {
    out[key] = executeField(node, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && (value as GNode).__typename !== undefined) {
    if (field.selectionSet === null) return null;
    return executeSelectionSet(field.selectionSet, value as GNode, ctx);
  }
  return value;
}

function executeField(node: GNode, field: FieldNode, ctx: ExecCtx): unknown {
  if (field.name === '__typename') return node.__typename;
  const typeResolvers = RESOLVERS[node.__typename];
  const resolver = typeResolvers?.[field.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${node.__typename}'` });
    return null;
  }
  try {
    const value = resolver(node, argsOf(field, ctx), ctx);
    return completeValue(value, field, ctx);
  } catch (err) {
    if (err instanceof GqlError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// request handling

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function runOperation(forge: Forge, operation: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { forge, variables, fragments, errors: [] };
  const root: GNode = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(operation.selectionSet, root, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

function runDocument(forge: Forge, body: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  if (typeof body.query !== 'string' || body.query === '') {
    return { data: null, errors: [{ message: 'A query document is required' }] };
  }
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(lex(body.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let operation: OperationNode | undefined;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    operation = parsed.operations.find((candidate) => candidate.name === body.operationName);
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  } else {
    operation = parsed.operations[0];
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'Operation not found' }] };
  return runOperation(forge, operation, parsed.fragments, variables);
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, rawBody: Buffer, tokenOk: boolean): GraphQLReply {
  if (!tokenOk) return { status: 401, body: { message: 'Bad credentials' } };
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { data: null, errors: [{ message: 'Malformed JSON body' }] } };
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) =>
      runDocument(forge, (typeof entry === 'object' && entry !== null ? entry : {}) as { query?: unknown; variables?: unknown; operationName?: unknown }),
    );
    return { status: 200, body: results };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { data: null, errors: [{ message: 'A JSON object body is required' }] } };
  }
  return { status: 200, body: runDocument(forge, body as { query?: unknown; variables?: unknown; operationName?: unknown }) };
}
