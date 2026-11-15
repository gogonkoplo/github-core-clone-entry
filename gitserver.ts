// The git smart-HTTP surface at /{owner}/{repo}.git: ref advertisement (protocol v2 and the v0
// fallback), ls-refs and fetch over protocol v2, fetch over v0, and receive-pack pushes with
// report-status. Repositories are created through REST only; a push cannot invent one, and a
// missing repository answers 404 on both services' info/refs.

import {
  PKT_FLUSH,
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  sidebandPackets,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { VIEWER, type Forge, type RepoRec } from './store.ts';

export interface RawReply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export interface GitCtx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  tokenOk: boolean;
}

const AGENT = 'github-core-clone/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function textReply(status: number, text: string): RawReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function repoOf(forge: Forge, owner: string, repoSegment: string): RepoRec | null {
  if (!repoSegment.endsWith('.git')) return null;
  return forge.getRepo(owner, repoSegment.slice(0, -4));
}

/** Ref lines for a v0 advertisement: HEAD first (or the empty repo's pseudo-ref), refs sorted. */
function v0RefLines(forge: Forge, repo: RepoRec, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const refLine = (oid: string, name: string, caps?: string): Buffer =>
    encodePktLine(caps !== undefined ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`);
  if (refs.length === 0) {
    lines.push(refLine(ZERO_OID, 'capabilities^{}', capabilities));
    return lines;
  }
  // Capabilities ride on the first ref line only (the HEAD line here); later lines are bare.
  lines.push(refLine(headTip ?? ZERO_OID, 'HEAD', `${capabilities} symref=HEAD:${headRef}`));
  for (const [name, oid] of refs) {
    lines.push(refLine(oid, name));
    const object = forge.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(forge.objects, oid);
      if (peeled !== null) lines.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

function infoRefs(forge: Forge, repo: RepoRec, service: string, ctx: GitCtx): RawReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textReply(400, 'unknown service');
  }
  const preamble = encodePktLine(`# service=${service}\n`);
  const wantsV2 = (ctx.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      preamble,
      PKT_FLUSH,
      encodePktLine('version 2\n'),
      encodePktLine(`agent=${AGENT}\n`),
      encodePktLine('ls-refs=unborn\n'),
      encodePktLine('fetch=shallow\n'),
      encodePktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const capabilities = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const body = Buffer.concat([preamble, PKT_FLUSH, ...v0RefLines(forge, repo, capabilities), PKT_FLUSH]);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/**
 * The objects a fetch sends: everything within `depth` generations of the wants (all of it when
 * depth is null), minus what the haves prove the client holds — the client's shallow boundary
 * cuts the have-walk, so a deepen sends the newly included generation and nothing older.
 */
function planFetch(
  forge: Forge,
  wants: readonly string[],
  haves: readonly string[],
  shallowCuts: readonly string[],
  depth: number | null,
): FetchPlan {
  const store = forge.objects;
  const dist = new Map<string, number>();
  const tagOids = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const enqueueWant = (oid: string): void => {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = store.get(current);
      if (object === undefined) return;
      if (object.type === 'tag') {
        tagOids.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') queue.push({ oid: current, dist: 0 });
      return;
    }
  };
  for (const want of wants) enqueueWant(want);
  while (queue.length > 0) {
    const { oid, dist: d } = queue.shift() as { oid: string; dist: number };
    const known = dist.get(oid);
    if (known !== undefined && known <= d) continue;
    dist.set(oid, d);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth !== null && d + 1 >= depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: d + 1 });
  }
  const included = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth === null || d < depth) included.add(oid);
  }
  const boundary = new Set<string>();
  for (const oid of included) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent) && store.has(parent)) boundary.add(oid);
    }
  }
  const includeObjs = collectReachable(store, [...included, ...tagOids], { cut: included });
  const excludeObjs = collectReachable(store, haves, { cut: new Set(shallowCuts) });
  // Deterministic pack order: by object id.
  const ordered = [...includeObjs].filter((oid) => !excludeObjs.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of ordered) {
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const unshallow = shallowCuts.filter((oid) => included.has(oid) && !boundary.has(oid));
  const commonHaves = haves.filter((oid) => store.has(oid));
  return { objects, shallow: [...boundary].sort(), unshallow: unshallow.sort(), commonHaves };
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST

/** Split a v2 request's lines at the delim packet (decodePktLines keeps control packets). */
function parseV2(body: Buffer): { command: string; args: string[] } | null {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return command === '' ? null : { command, args };
}

function lsRefsReply(forge: Forge, repo: RepoRec, args: readonly string[]): RawReply {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(encodePktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      lines.push(encodePktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let suffix = '';
    const object = forge.objects.get(oid);
    if (peel && object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(forge.objects, oid);
      if (peeled !== null) suffix = ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${oid} ${name}${suffix}\n`));
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat([...lines, PKT_FLUSH]),
  };
}

function fetchReplyV2(forge: Forge, repo: RepoRec, args: readonly string[]): RawReply {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowCuts: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowCuts.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  const plan = planFetch(forge, wants, haves, shallowCuts, depth);
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (plan.commonHaves.length > 0) {
    for (const have of plan.commonHaves) parts.push(encodePktLine(`ACK ${have}\n`));
    if (!done) parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (!done) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchReplyV0(forge: Forge, repo: RepoRec, body: Buffer): RawReply {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowCuts: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallowCuts.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(forge, wants, haves, shallowCuts, depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length > 0) parts.push(encodePktLine(`ACK ${plan.commonHaves[0]}\n`));
  else parts.push(encodePktLine('NAK\n'));
  const pack = writePack(plan.objects);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function uploadPack(forge: Forge, repo: RepoRec, ctx: GitCtx): RawReply {
  const isV2 = (ctx.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (isV2) {
    const parsed = parseV2(ctx.body);
    if (parsed === null) return textReply(400, 'malformed upload-pack request');
    if (parsed.command === 'ls-refs') return lsRefsReply(forge, repo, parsed.args);
    if (parsed.command === 'fetch') return fetchReplyV2(forge, repo, parsed.args);
    return textReply(400, `unknown command ${parsed.command}`);
  }
  return fetchReplyV0(forge, repo, ctx.body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(forge: Forge, repo: RepoRec, ctx: GitCtx): RawReply {
  const { packets, consumed } = decodePktLines(ctx.body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) return textReply(400, 'malformed receive-pack request');

  const pack = ctx.body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => forge.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!forge.objects.has(oid)) forge.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ') : 'corrupt pack'}`;
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!forge.objects.has(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_OID && current !== command.newOid) {
      const currentCommit = peelToCommit(forge.objects, current);
      const newCommit = peelToCommit(forge.objects, command.newOid);
      if (currentCommit === null || newCommit === null || !isAncestor(forge.objects, currentCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat(reportLines.map((line) => encodePktLine(line)));
  const body = sideband
    ? Buffer.concat([...sidebandPackets(report, 1), PKT_FLUSH])
    : Buffer.concat([report, PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

// ---------------------------------------------------------------------------------------------
// entry point

/** Handle one git smart-HTTP request; null when the path is not a git path. */
export function handleGit(forge: Forge, ctx: GitCtx): RawReply | null {
  const [owner, repoSegment, ...rest] = ctx.segments;
  if (owner === undefined || repoSegment === undefined || !repoSegment.endsWith('.git')) return null;
  if (!ctx.tokenOk) return textReply(401, 'unauthorized');
  const repo = repoOf(forge, owner, repoSegment);
  if (repo === null) return textReply(404, 'repository not found');
  if (ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    return infoRefs(forge, repo, ctx.query.get('service') ?? '', ctx);
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    return uploadPack(forge, repo, ctx);
  }
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    return receivePack(forge, repo, ctx);
  }
  return textReply(404, 'not found');
}

