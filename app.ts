// The HTTP server: one node:http listener dispatching to the four surfaces over a single
// in-memory forge — git smart HTTP at /{owner}/{repo}.git, REST v3 at /api/v3, GraphQL v4 at
// /api/graphql and MCP at /mcp. Auth is a Bearer token compared against MAKEFUN_SHOP_TOKEN;
// when the env carries no token the server accepts any (or no) credentials, which is how the
// local runner drives it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitserver.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body ?? null)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

let requestCounter = 0;

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const tokenOk = expected === '' ? true : authorization === `Bearer ${expected}`;
    const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';

    // The env's boot check: 200 {"ok":true}.
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitReply = handleGit(forge, { method, segments, query: url.searchParams, body, headers: req.headers, tokenOk });
    if (gitReply !== null) {
      sendRaw(res, gitReply.status, gitReply.contentType, gitReply.body, gitReply.headers ?? {});
      return;
    }

    // REST v3: every reply carries a request id; unknown routes are GitHub's JSON 404.
    if (segments[0] === 'api' && segments[1] === 'v3') {
      const reply = handleRest(forge, { method, segments, query: url.searchParams, body, host, tokenOk })
        ?? { status: 404, body: { message: 'Not Found' } };
      requestCounter += 1;
      sendJson(res, reply.status, reply.body, { 'x-github-request-id': `req-${requestCounter}`, ...(reply.headers ?? {}) });
      return;
    }

    // GraphQL v4.
    if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
      const reply = handleGraphQL(forge, body, tokenOk);
      requestCounter += 1;
      sendJson(res, reply.status, reply.body, { 'x-github-request-id': `req-${requestCounter}` });
      return;
    }

    // MCP (Streamable HTTP JSON-RPC).
    if (segments[0] === 'mcp' && segments.length === 1) {
      const reply = handleMcp(forge, body, tokenOk);
      if (reply.body === undefined) {
        res.writeHead(reply.status, { 'content-length': 0 });
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch {
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(forge, req, res);
  });
  // The read benchmark holds one keep-alive connection through 2000 sequential requests.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
