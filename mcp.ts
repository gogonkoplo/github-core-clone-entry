// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. Speaks the modern revision via
// server/discover (supportedVersions includes 2026-07-28) and the classic initialize handshake
// for older clients. The six tools mirror the REST surface over the same store. Authentication
// is checked before anything else: every /mcp request without a valid Bearer token is a 401.

import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The canonical tool set. Built once so tools/list is byte-identical on every call. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request, squashing its commits onto the base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export interface McpReply {
  status: number;
  body?: unknown;
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: unknown, code: number, message: string): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  const structured = (typeof value === 'object' && value !== null ? value : { value }) as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function initializeResult(params: Record<string, unknown>): Record<string, unknown> {
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function callTool(forge: Forge, name: string, rawArgs: unknown, id: unknown): { status: number; body: unknown } {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  const repoOf = (): RepoRec | null => forge.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const created = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      // A duplicate create returns the existing repository as a success.
      const repo = created === 'exists' ? forge.getRepo(VIEWER.login, repoName) : created;
      if (repo === null) return rpcResult(id, toolFailure(`could not create repository ${repoName}`));
      return rpcResult(id, toolSuccess(repoJson(forge, repo)));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return rpcResult(id, toolFailure(`repository not found: ${stringArg(args, 'owner')}/${stringArg(args, 'repo')}`));
      return rpcResult(id, toolSuccess(repoJson(forge, repo)));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return rpcResult(id, toolFailure('repository not found'));
      const created = forge.createIssue(repo, {
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return rpcResult(id, toolFailure(`unknown label: ${created.label}`));
      return rpcResult(id, toolSuccess(issueJson(forge, repo, created)));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return rpcResult(id, toolFailure('repository not found'));
      const state = (typeof args.state === 'string' ? args.state : 'open').toLowerCase();
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueJson(forge, repo, issue));
      return rpcResult(id, toolSuccess({ issues }));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return rpcResult(id, toolFailure('repository not found'));
      let head = stringArg(args, 'head');
      const colon = head.indexOf(':');
      if (colon > 0 && head.slice(0, colon) === VIEWER.login) head = head.slice(colon + 1);
      const created = forge.createPull(repo, {
        title: stringArg(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base: stringArg(args, 'base'),
      });
      if ('error' in created) return rpcResult(id, toolFailure(created.error));
      return rpcResult(id, toolSuccess(pullJson(forge, repo, created)));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return rpcResult(id, toolFailure('repository not found'));
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return rpcResult(id, toolFailure(`pull request not found: ${String(args.pull_number)}`));
      const outcome = forge.mergePull(repo, pull);
      if (!outcome.ok) return rpcResult(id, toolFailure(`pull request is not mergeable (${outcome.reason})`));
      return rpcResult(id, toolSuccess(pullJson(forge, repo, pull)));
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/** Handle one /mcp request. Auth runs first: no valid Bearer token, no JSON-RPC at all. */
export function handleMcp(forge: Forge, rawBody: Buffer, tokenOk: boolean): McpReply {
  if (!tokenOk) return { status: 401, body: { message: 'Unauthorized' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } },
    };
  }
  const request = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as RpcRequest;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize':
      return rpcResult(id, initializeResult(params));
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      return callTool(forge, toolName, params.arguments, id);
    }
    default:
      break;
  }
  if (method.startsWith('notifications/')) return { status: 202 };
  if (isNotification) return { status: 202 };
  return rpcError(id, -32601, `Method not found: ${method}`);
}
