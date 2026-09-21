import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConflictError, ProjectStore, ValidationError, WitnessInUseError } from '../core/store';
import { exportApparatus } from '../core/export';
import { roundtripDiffs } from '../core/roundtrip';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown, contentType = 'application/json; charset=utf-8'): void {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

export function createApiHandler(store: ProjectStore): Connect.NextHandleFunction {
  return (req, res, next) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = url.pathname.replace(/\/+$/, '') || '/';
        const method = req.method ?? 'GET';
        const body = method === 'POST' || method === 'PUT' || method === 'DELETE'
          ? JSON.parse((await readBody(req)) || '{}')
          : {};

        if (route === '/state' && method === 'GET') {
          return send(res, 200, {
            ...store.data,
            derived: Object.fromEntries(
              store.data.witnesses.map((w) => [w.id, store.derivedOf(w.id).text]),
            ),
          });
        }
        if (route === '/witnesses' && method === 'POST') {
          return send(res, 200, store.addWitness(body.name ?? '', body.xml ?? ''));
        }
        const wm = /^\/witnesses\/([^/]+)$/.exec(route);
        if (wm && method === 'DELETE') {
          store.removeWitness(wm[1], url.searchParams.get('force') === '1');
          return send(res, 200, { ok: true });
        }
        if (route === '/anchors' && method === 'POST') {
          return send(res, 200, store.addAnchor(body.witnessId, body.start, body.end));
        }
        const am = /^\/anchors\/([^/]+)$/.exec(route);
        if (am && method === 'PUT') {
          return send(res, 200, store.reviseAnchor(am[1], body.start, body.end, body.baseVersion));
        }
        if (route === '/units' && method === 'POST') {
          return send(res, 200, store.addUnit(body.label ?? '', body.readings ?? []));
        }
        const um = /^\/units\/([^/]+)$/.exec(route);
        if (um && method === 'PUT') {
          return send(res, 200, store.updateUnit(um[1], body.updates ?? {}, body.baseVersion));
        }
        if (um && method === 'DELETE') {
          store.deleteUnit(um[1]);
          return send(res, 200, { ok: true });
        }
        if (route === '/export' && method === 'GET') {
          const result = exportApparatus(store);
          if (!result.ok) return send(res, 422, { issues: result.issues });
          return send(res, 200, result.xml, 'application/xml; charset=utf-8');
        }
        if (route === '/roundtrip' && method === 'GET') {
          const result = exportApparatus(store);
          if (!result.ok) return send(res, 422, { issues: result.issues });
          return send(res, 200, { xml: result.xml, diffs: roundtripDiffs(store, result.xml) });
        }
        next();
      } catch (err) {
        if (err instanceof ConflictError) return send(res, 409, { conflict: err.payload });
        if (err instanceof WitnessInUseError) {
          return send(res, 409, { inUse: err.referencingUnits });
        }
        if (err instanceof ValidationError) {
          return send(res, 400, { error: err.message, details: err.details });
        }
        send(res, 500, { error: String(err) });
      }
    })();
  };
}

export function apiPlugin(dir = path.resolve('data')): Plugin {
  const store = new ProjectStore(dir);
  store.load();
  return {
    name: 'collation-loom-api',
    configureServer(server) {
      server.middlewares.use('/api', createApiHandler(store));
    },
  };
}
