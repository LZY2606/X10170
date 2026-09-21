import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { LoomStore } from '../core/store.js';
import { exportApparatus } from '../core/xml.js';
import { classifyRoundTrip, preflightExport } from '../core/roundtrip.js';
import type { EditEvent, TextRange, WitnessReading } from '../core/types.js';

let storePromise: Promise<LoomStore> | undefined;

function store(): Promise<LoomStore> {
  storePromise ||= LoomStore.open(join(process.cwd(), 'data'));
  return storePromise;
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function actor(value: any): { actor: string; baseVersion: number } {
  return { actor: String(value.actor || 'anonymous'), baseVersion: Number(value.baseVersion) };
}

function latestUnitEvent(events: EditEvent[], unitId: string): string | undefined {
  return [...events].reverse().find(event =>
    (event.type === 'unit.created' || event.type === 'unit.updated') &&
    (event.payload as { unit?: { id: string } }).unit?.id === unitId
  )?.id;
}

async function buildExport(loom: LoomStore) {
  const state = loom.getState();
  const witnesses = await Promise.all(Object.values(state.witnesses)
    .filter(witness => !witness.deleted)
    .map(async witness => ({ id: witness.id, name: witness.name, raw: await loom.getRaw(witness.id) })));
  const units = Object.values(state.units);
  return exportApparatus({
    witnesses,
    units,
    exportEventId: 'preview',
    anchorRanges: (anchorId) => state.anchors[anchorId]?.current.range,
    eventIdForUnit: unitId => latestUnitEvent(loom.getEvents(), unitId)
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!url.pathname.startsWith('/api/')) return next();
  const loom = await store();
  try {
    const route = url.pathname.slice('/api/'.length);

    if (req.method === 'GET' && route === 'state') {
      return send(res, 200, { state: loom.getState(), events: loom.getEvents() });
    }

    if (req.method === 'GET' && route.startsWith('witnesses/') && route.endsWith('/raw')) {
      const witnessId = route.split('/')[1];
      const raw = await loom.getRaw(witnessId);
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(raw);
      return;
    }

    if (req.method === 'GET' && route.startsWith('witnesses/') && route.endsWith('/view')) {
      const witnessId = route.split('/')[1];
      return send(res, 200, loom.getView(witnessId));
    }

    if (req.method === 'POST' && route === 'witnesses') {
      const body = await json(req);
      const event = await loom.importWitness(
        { name: body.name, filename: body.filename, raw: body.raw },
        actor(body)
      );
      return send(res, 201, { event, state: loom.getState() });
    }

    if (req.method === 'DELETE' && route.startsWith('witnesses/')) {
      const witnessId = route.split('/')[1];
      const body = await json(req).catch(() => ({}));
      const event = await loom.deleteWitness(witnessId, body.reason || '编辑删除', actor(body));
      return send(res, 200, { event, state: loom.getState() });
    }

    if (req.method === 'POST' && route === 'anchors') {
      const body = await json(req);
      const event = await loom.addAnchor(
        { witnessId: body.witnessId, range: body.range as TextRange, groupId: body.groupId, label: body.label },
        actor(body)
      );
      return send(res, 201, { event, state: loom.getState() });
    }

    if (req.method === 'PATCH' && route.startsWith('anchors/')) {
      const anchorId = route.split('/')[1];
      const body = await json(req);
      const event = await loom.reviseAnchor(anchorId, body.range, body.reason, actor(body));
      return send(res, 200, { event, state: loom.getState() });
    }

    if (req.method === 'POST' && route === 'units') {
      const body = await json(req);
      const event = await loom.createUnit(body.label, body.readings as Record<string, WitnessReading>, actor(body));
      return send(res, 201, { event, state: loom.getState() });
    }

    if (req.method === 'PATCH' && route.startsWith('units/')) {
      const unitId = route.split('/')[1];
      const body = await json(req);
      const event = await loom.updateUnit(unitId, { label: body.label, readings: body.readings }, actor(body));
      return send(res, 200, { event, state: loom.getState() });
    }

    if (req.method === 'POST' && route.startsWith('conflicts/') && route.endsWith('/resolve')) {
      const conflictId = route.split('/')[1];
      const body = await json(req);
      const event = await loom.resolveConflict(conflictId, actor(body));
      return send(res, 200, { event, state: loom.getState() });
    }

    if (req.method === 'POST' && route === 'export/preview') {
      const result = await buildExport(loom);
      const state = loom.getState();
      const raws = await Promise.all(Object.values(state.witnesses)
        .filter(witness => !witness.deleted)
        .map(async witness => ({ witnessId: witness.id, raw: await loom.getRaw(witness.id) })));
      const preflight = preflightExport(raws);
      return send(res, 200, { ...result, preflight });
    }

    if (req.method === 'POST' && route === 'export') {
      const result = await buildExport(loom);
      if (result.issues.some(issue => issue.severity === 'blocker')) {
        return send(res, 422, { ok: false, issues: result.issues });
      }
      const body = await json(req);
      const event = await loom.recordExport(result.xml || '', actor(body));
      const xml = result.xml!.replaceAll('sourceEvent="preview"', `sourceEvent="${event.id}"`);
      return send(res, 200, { xml, event, state: loom.getState() });
    }

    if (req.method === 'POST' && route === 'roundtrip') {
      const body = await json(req);
      const state = loom.getState();
      const originals = await Promise.all(Object.values(state.witnesses)
        .filter(witness => !witness.deleted)
        .map(async witness => ({ witnessId: witness.id, raw: await loom.getRaw(witness.id) })));
      const result = await buildExport(loom);
      const differences = classifyRoundTrip({
        originals,
        exportedXml: body.exportedXml || result.xml || '<apparatus/>',
        exportEventId: body.exportEventId || 'preview',
        events: loom.getEvents()
      });
      return send(res, 200, { differences });
    }

    return send(res, 404, { error: '未知 API' });
  } catch (error: any) {
    return send(res, error.status || 400, { error: error.message, references: error.references, conflictId: error.conflictId });
  }
}

export function loomApi(): Plugin {
  return {
    name: 'variant-loom-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        handle(req, res, next).catch(error => send(res, 500, { error: error.message }));
      });
    }
  };
}
