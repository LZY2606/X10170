import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProjectStore, RevisionConflict, ValidationFailure } from '../core/store.js';
import { parseXml } from '../core/xml.js';
import { normalize, validateRange } from '../core/normalize.js';
import { buildExport, precheck } from '../core/export.js';
import { runRoundtrip } from '../core/roundtrip.js';
import { loadState, saveRawWitness, saveState, layout } from './persistence.js';
import type { ProjectState } from '../core/model.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, extra?: unknown): void {
  sendJson(res, status, { error: { code, message, ...(extra ? { detail: extra } : {}) } });
}

export interface ApiDeps {
  store: ProjectStore;
  rootDir: string;
}

export function createApiHandler(deps: ApiDeps): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => Promise<void> {
  const { store, rootDir } = deps;
  const persist = (): void => saveState(rootDir, store.state);

  return async function handler(req, res, next): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      next();
      return;
    }
    try {
      if (req.method === 'GET' && path === '/api/state') {
        const state = store.state as ProjectState;
        sendJson(res, 200, {
          revision: state.revision,
          witnesses: state.witnesses.map((w) => ({
            id: w.id, name: w.name, sha256: w.sha256, importedAt: w.importedAt, size: w.rawXml.length,
          })),
          units: state.units,
          events: state.events,
          elementPolicy: state.elementPolicy,
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/witness') {
        const id = url.searchParams.get('id') ?? '';
        const w = store.state.witnesses.find((x) => x.id === id);
        if (!w) return sendError(res, 404, 'not-found', `见证 ${id} 不存在`);
        sendJson(res, 200, { id: w.id, name: w.name, rawXml: w.rawXml, sha256: w.sha256, view: normalize(parseXml(w.rawXml)) });
        return;
      }
      if (req.method === 'POST' && path === '/api/witness/import') {
        const body = await readJson<{ name: string; rawXml: string; editor: string; baseRevision: number }>(req);
        parseXml(body.rawXml);
        const result = store.importWitness({ name: body.name, rawXml: body.rawXml },
          { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        const after = result.event.after;
        const importedId = after && typeof after === 'object' && 'id' in after ?
          (after as { id: string }).id : '';
        saveRawWitness(rootDir, importedId, body.rawXml);
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      if (req.method === 'POST' && path === '/api/witness/delete-check') {
        const body = await readJson<{ witnessId: string }>(req);
        const result = store.checkDeleteWitness(body.witnessId);
        sendJson(res, 200, {
          blocked: result.blocked,
          referenced: result.referenced.map((u) => ({ id: u.id, title: u.title })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/api/witness/delete') {
        const body = await readJson<{ witnessId: string; editor: string; baseRevision: number }>(req);
        const result = store.deleteWitness(body.witnessId, { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      if (req.method === 'POST' && path === '/api/unit') {
        const body = await readJson<{
          title: string; anchors: import('../core/model.js').Anchor[];
          readings: import('../core/model.js').Reading[]; editor: string; baseRevision: number;
        }>(req);
        const result = store.createUnit(
          { title: body.title, anchors: body.anchors, readings: body.readings },
          { editor: body.editor || '匿名', baseRevision: body.baseRevision },
        );
        persist();
        const createdAfter = result.event.after;
        const createdId = createdAfter && typeof createdAfter === 'object' && 'id' in createdAfter
          ? (createdAfter as { id: string }).id : null;
        sendJson(res, 200, { revision: store.state.revision, event: result.event, unitId: createdId });
        return;
      }
      if (req.method === 'POST' && path === '/api/unit/update') {
        const body = await readJson<{
          unitId: string; title?: string;
          anchors?: import('../core/model.js').Anchor[];
          readings?: import('../core/model.js').Reading[];
          editor: string; baseRevision: number;
        }>(req);
        const result = store.updateUnit(body.unitId,
          { title: body.title, anchors: body.anchors, readings: body.readings },
          { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      if (req.method === 'POST' && path === '/api/unit/delete') {
        const body = await readJson<{ unitId: string; editor: string; baseRevision: number }>(req);
        const result = store.deleteUnit(body.unitId, { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      if (req.method === 'POST' && path === '/api/anchor/revise') {
        const body = await readJson<{
          witnessId: string; oldStart: number; oldEnd: number;
          newStart: number; newEnd: number; label?: string; editor: string; baseRevision: number;
        }>(req);
        const w = store.state.witnesses.find((x) => x.id === body.witnessId);
        if (w) {
          const err = validateRange(normalize(parseXml(w.rawXml)), body.newStart, body.newEnd);
          if (err) return sendError(res, 422, 'invalid-range', err);
        }
        const result = store.reviseAnchor(body.witnessId,
          { start: body.oldStart, end: body.oldEnd },
          { start: body.newStart, end: body.newEnd, label: body.label },
          { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      if (req.method === 'GET' && path === '/api/export/precheck') {
        sendJson(res, 200, precheck(store.state));
        return;
      }
      if (req.method === 'POST' && path === '/api/export') {
        const result = buildExport(store.state);
        saveState(rootDir, { ...store.state });
        const l = layout(rootDir);
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        writeFileSync(join(l.dir, 'export.xml'), result.xml, 'utf8');
        sendJson(res, 200, result);
        return;
      }
      if (req.method === 'POST' && path === '/api/roundtrip') {
        const body = await readJson<{ exportedXml?: string }>(req);
        let xml = body.exportedXml;
        if (!xml) {
          const built = buildExport(store.state);
          xml = built.xml;
        }
        sendJson(res, 200, runRoundtrip(store.state, xml));
        return;
      }
      if (req.method === 'POST' && path === '/api/policy') {
        const body = await readJson<{ qname: string; policy: 'keep' | 'unwrap'; editor: string; baseRevision: number }>(req);
        const result = store.setElementPolicy(body.qname, body.policy,
          { editor: body.editor || '匿名', baseRevision: body.baseRevision });
        persist();
        sendJson(res, 200, { revision: store.state.revision, event: result.event });
        return;
      }
      sendError(res, 404, 'no-route', `未知接口 ${path}`);
    } catch (err) {
      if (err instanceof RevisionConflict) {
        sendError(res, 409, 'revision-conflict', err.message, err.detail);
        return;
      }
      if (err instanceof ValidationFailure) {
        sendError(res, 422, 'validation-failed', err.message);
        return;
      }
      sendError(res, 500, 'internal', (err as Error).message);
    }
  };
}

export function loomPlugin(rootDir: string): Plugin {
  const restored = loadState(rootDir) ?? undefined;
  const store = new ProjectStore(restored);
  return {
    name: 'yiwen-zhiji-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void createApiHandler({ store, rootDir })(req, res, next);
      });
    },
  };
}
