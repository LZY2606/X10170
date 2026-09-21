import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApiHandler } from '../src/server/api.js';
import { ProjectStore } from '../src/core/store.js';
import { loadState } from '../src/server/persistence.js';

class FakeReq extends EventEmitter {
  method = '';
  url = '';
  headers = {};
}

class FakeRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    this.headers = headers;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

async function call(
  handler: ReturnType<typeof createApiHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const req = new FakeReq();
  req.method = method;
  req.url = url;
  const res = new FakeRes();
  const done = handler(req as never, res as never, () => {});
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  await done;
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

describe('HTTP API', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('两人并发：后提交者得到 409 且载荷包含双方范围与文本片段线索', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loom-api-'));
    const store = new ProjectStore();
    const handler = createApiHandler({ store, rootDir: dir });

    const imp1 = await call(handler, 'POST', '/api/witness/import', {
      name: '甲', rawXml: '<TEI><p>一二三四五</p></TEI>', editor: '编者甲', baseRevision: 0,
    });
    expect(imp1.status).toBe(200);
    const imp2 = await call(handler, 'POST', '/api/witness/import', {
      name: '乙', rawXml: '<TEI><p>壹貳參四五</p></TEI>', editor: '编者甲', baseRevision: 1,
    });
    expect(imp2.status).toBe(200);
    const w1 = imp1.json.event.after.id;
    const w2 = imp2.json.event.after.id;

    const unitA = await call(handler, 'POST', '/api/unit', {
      title: '甲先提交',
      anchors: [{ witnessId: w1, start: 0, end: 3 }],
      readings: [{ witnessId: w1, type: 'original', note: '', fragments: [{ start: 0, end: 3, order: 0 }] }],
      editor: '编者甲', baseRevision: 2,
    });
    expect(unitA.status).toBe(200);

    const unitB = await call(handler, 'POST', '/api/unit', {
      title: '乙后提交-基于旧版本',
      anchors: [{ witnessId: w2, start: 0, end: 3 }],
      readings: [{ witnessId: w2, type: 'original', note: '', fragments: [{ start: 0, end: 3, order: 0 }] }],
      editor: '编者乙', baseRevision: 2,
    });
    expect(unitB.status).toBe(409);
    expect(unitB.json.error.code).toBe('revision-conflict');
    expect(unitB.json.error.detail.interveningEvents[0].after.title).toBe('甲先提交');
    expect(unitB.json.error.detail.attemptedAfter.anchors[0].end).toBe(3);
  });

  it('未知元素通过 /api/export/precheck 阻断，/api/export 返回 500 而不是静默成功', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loom-api-'));
    const store = new ProjectStore();
    const handler = createApiHandler({ store, rootDir: dir });
    await call(handler, 'POST', '/api/witness/import', {
      name: '甲',
      rawXml: '<TEI><text><body><p>文<strange x="1">异</strange></p></body></text></TEI>',
      editor: '编者甲', baseRevision: 0,
    });
    const precheck = await call(handler, 'GET', '/api/export/precheck');
    expect(precheck.json.ok).toBe(false);
    expect(precheck.json.blockers[0].qname).toBe('strange');
    const exported = await call(handler, 'POST', '/api/export', {});
    expect([500, 422]).toContain(exported.status);
    expect(exported.json.error.message).toMatch(/阻止/);
  });

  it('往返接口把 apparatus 标为已知编辑，并落盘 state 供重启恢复', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loom-api-'));
    const store = new ProjectStore();
    const handler = createApiHandler({ store, rootDir: dir });
    const imp = await call(handler, 'POST', '/api/witness/import', {
      name: '甲', rawXml: '<TEI><p>學而時習之</p></TEI>', editor: '编者甲', baseRevision: 0,
    });
    const wid = imp.json.event.after.id;
    await call(handler, 'POST', '/api/unit', {
      title: '三字',
      anchors: [{ witnessId: wid, start: 0, end: 3 }],
      readings: [{ witnessId: wid, type: 'lacuna', note: '缺', fragments: [{ start: 0, end: 3, order: 0 }] }],
      editor: '编者甲', baseRevision: 1,
    });
    const rt = await call(handler, 'POST', '/api/roundtrip', {});
    expect(rt.status).toBe(200);
    expect(rt.json.ok).toBe(true);
    expect(rt.json.counts['known-edit']).toBeGreaterThan(0);
    const restored = loadState(dir)!;
    expect(restored.units).toHaveLength(1);
    expect(restored.witnesses[0].rawXml).toContain('學而時習之');
  });
});
