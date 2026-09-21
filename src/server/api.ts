/** 无外部依赖的 HTTP API：JSON 路由 + 静态文件。 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, ConflictError, StoreError } from './store.js';
import { preflight, exportXml, ExportBlockedError } from './exportXml.js';
import { roundtripVerify } from './roundtrip.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isObj = typeof body === 'object' && body !== null;
  const payload = isObj ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, {
    'content-type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

export function createApp(store: Store): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    try {
      // ---------- 见证 ----------
      if (p === '/api/witnesses' && m === 'GET') return send(res, 200, store.listWitnesses());
      if (p === '/api/witnesses' && m === 'POST') {
        const body = JSON.parse(await readBody(req));
        return send(res, 201, store.importWitness(body));
      }
      let mm = p.match(/^\/api\/witnesses\/([^/]+)$/);
      if (mm && m === 'GET') return send(res, 200, store.getWitness(mm[1]));
      if (mm && m === 'DELETE') {
        const confirm = url.searchParams.get('confirm') === 'true';
        return send(res, 200, store.deleteWitness(mm[1], confirm));
      }
      mm = p.match(/^\/api\/witnesses\/([^/]+)\/raw$/);
      if (mm && m === 'GET') {
        const w = store.getWitness(mm[1]);
        if (!w) throw new StoreError('见证不存在', 404);
        return send(res, 200, w.xml, { 'content-type': 'application/xml; charset=utf-8' });
      }
      mm = p.match(/^\/api\/witnesses\/([^/]+)\/references$/);
      if (mm && m === 'GET') return send(res, 200, store.witnessReferences(mm[1]));
      mm = p.match(/^\/api\/witnesses\/([^/]+)\/anchors$/);
      if (mm && m === 'POST') {
        const body = JSON.parse(await readBody(req));
        return send(res, 201, store.addAnchor(mm[1], body));
      }

      // ---------- 锚点 ----------
      mm = p.match(/^\/api\/anchors\/([^/]+)$/);
      if (mm && m === 'PUT') {
        const body = JSON.parse(await readBody(req));
        return send(res, 200, store.reviseAnchor(mm[1], body));
      }
      if (p === '/api/alignment' && m === 'GET') return send(res, 200, store.alignment());

      // ---------- 校勘单元 ----------
      if (p === '/api/units' && m === 'GET') return send(res, 200, store.listUnits());
      if (p === '/api/units' && m === 'POST') {
        const body = JSON.parse(await readBody(req));
        return send(res, 201, store.createUnit(body));
      }
      mm = p.match(/^\/api\/units\/([^/]+)$/);
      if (mm && m === 'PUT') {
        const body = JSON.parse(await readBody(req));
        return send(res, 200, store.updateUnit(mm[1], body));
      }
      if (mm && m === 'DELETE') return send(res, 200, store.deleteUnit(mm[1]));
      if (p === '/api/overlaps' && m === 'GET') return send(res, 200, store.overlaps());

      // ---------- 历史 / 导出 / 往返 ----------
      if (p === '/api/history' && m === 'GET') return send(res, 200, store.history());
      if (p === '/api/export/preflight' && m === 'POST') return send(res, 200, preflight(store));
      if (p === '/api/export' && m === 'POST') {
        return send(res, 200, exportXml(store), { 'content-type': 'application/xml; charset=utf-8' });
      }
      if (p === '/api/roundtrip' && m === 'POST') return send(res, 200, roundtripVerify(store));

      // ---------- 静态文件 ----------
      if (m === 'GET' && !p.startsWith('/api/')) {
        const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
        const file = path.join(WEB_DIR, rel);
        if (file.startsWith(WEB_DIR) && existsSync(file)) {
          const ext = path.extname(file);
          const content = await readFile(file);
          res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
          return res.end(content);
        }
      }
      return send(res, 404, { error: 'not found', path: p });
    } catch (err) {
      if (err instanceof ConflictError) return send(res, 409, { error: 'conflict', conflict: err.conflict });
      if (err instanceof ExportBlockedError) return send(res, 422, { error: err.message, errors: err.errors });
      if (err instanceof StoreError) return send(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      if (err instanceof SyntaxError) return send(res, 400, { error: '请求体不是合法 JSON' });
      console.error(err);
      return send(res, 500, { error: String(err) });
    }
  });
}
