import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, saveRawWitness, PROJECT_DIR } from '../src/server/persistence.js';
import { ProjectStore } from '../src/core/store.js';

describe('项目目录持久化与重启恢复', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('重启后版本、事件、冲突基线与原始文件全部恢复，sha256 校验', () => {
    dir = mkdtempSync(join(tmpdir(), 'loom-'));
    const store = new ProjectStore();
    const r = store.importWitness(
      { name: '甲本', rawXml: '<TEI><p>學而時習之</p></TEI>' },
      { editor: '编者甲', baseRevision: 0 },
    );
    const wid = (r.event.after as { id: string }).id;
    saveRawWitness(dir, wid, '<TEI><p>學而時習之</p></TEI>');
    saveState(dir, store.state);

    expect(existsSync(join(dir, PROJECT_DIR, 'state.json'))).toBe(true);
    expect(existsSync(join(dir, PROJECT_DIR, 'raw', `${wid}.xml`))).toBe(true);

    const restored = loadState(dir)!;
    expect(restored).toBeTruthy();
    expect(restored.revision).toBe(1);
    expect(restored.witnesses[0].rawXml).toBe('<TEI><p>學而時習之</p></TEI>');
    expect(restored.events[0].kind).toBe('witness.import');
    expect(readFileSync(join(dir, PROJECT_DIR, 'raw', `${wid}.xml`), 'utf8'))
      .toBe('<TEI><p>學而時習之</p></TEI>');

    const reopened = new ProjectStore(restored);
    expect(() =>
      reopened.importWitness({ name: '乙', rawXml: '<TEI/>' }, { editor: '编者乙', baseRevision: 1 }),
    ).not.toThrow();
    expect(() =>
      reopened.importWitness({ name: '丙', rawXml: '<TEI/>' }, { editor: '编者丙', baseRevision: 1 }),
    ).toThrow(/修订冲突/);
  });

  it('原始磁盘文件被篡改时 sha256 校验失败', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loom-'));
    const store = new ProjectStore();
    const r = store.importWitness(
      { name: '甲', rawXml: '<TEI><p>原文</p></TEI>' },
      { editor: 'e', baseRevision: 0 },
    );
    const wid = (r.event.after as { id: string }).id;
    saveRawWitness(dir, wid, '<TEI><p>原文</p></TEI>');
    saveState(dir, store.state);
    const safe = wid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, PROJECT_DIR, 'raw', `${safe}.xml`), '<TEI><p>被篡改</p></TEI>', 'utf8');
    expect(() => loadState(dir)).toThrow(/校验失败/);
  });
});
