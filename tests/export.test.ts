import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/core/store.js';
import { buildExport, precheck, LOOM_NS } from '../src/core/export.js';
import { parseXml } from '../src/core/xml.js';
import { runRoundtrip } from '../src/core/roundtrip.js';

function storeWith(witnesses: Array<{ name: string; xml: string }>): {
  store: ProjectStore;
  ids: string[];
} {
  const store = new ProjectStore();
  const ids: string[] = [];
  let rev = 0;
  for (const w of witnesses) {
    const r = store.importWitness({ name: w.name, rawXml: w.xml },
      { editor: '编者甲', baseRevision: rev });
    rev = r.state.revision;
    ids.push((r.event.after as { id: string }).id);
  }
  return { store, ids };
}

describe('导出预检与未知结构阻断', () => {
  it('未知元素阻止导出，并给出见证、XPath 与原始偏移', () => {
    const { store } = storeWith([
      { name: '甲', xml: '<TEI><text><body><p>前文<custom:magic xmlns:custom="http://x">咒</custom:magic>后文</p></body></text></TEI>' },
    ]);
    const result = precheck(store.state);
    expect(result.ok).toBe(false);
    const blocker = result.blockers.find((b) => b.qname === 'custom:magic');
    expect(blocker).toBeTruthy();
    expect(blocker!.xpath).toContain('custom:magic');
    expect(blocker!.offset).toBeGreaterThan(0);
    expect(() => buildExport(store.state)).toThrow(/未知\/不安全结构阻止/);
  });

  it('DOCTYPE 阻止导出（无法安全迁移内部 DTD/实体）', () => {
    const { store } = storeWith([
      { name: '甲', xml: '<?xml version="1.0"?><!DOCTYPE TEI [<!ENTITY x "甲">]><TEI>&x;</TEI>' },
    ]);
    const result = precheck(store.state);
    expect(result.blockers.some((b) => b.qname === '!DOCTYPE')).toBe(true);
  });

  it('登记 keep 策略后未知元素可导出；命名空间与属性序保留', () => {
    const xml = '<TEI xmlns:ed="http://example.org/ed"><text><body><p ed:z="1" xml:id="p1">學而時習之</p></body></text></TEI>';
    const { store, ids } = storeWith([{ name: '甲', xml }]);
    store.setElementPolicy('TEI', 'keep', { editor: '编者甲', baseRevision: 1 });
    const created = store.createUnit({
      title: '首三字',
      anchors: [{ witnessId: ids[0], start: 0, end: 3 }],
      readings: [{
        witnessId: ids[0], type: 'original', note: '定本',
        fragments: [{ start: 0, end: 3, order: 0 }],
      }],
    }, { editor: '编者甲', baseRevision: store.state.revision });
    expect(created.event.revision).toBeGreaterThan(0);
    const exported = buildExport(store.state);
    expect(exported.xml).toContain(`xmlns:loom="${LOOM_NS}"`);
    expect(exported.xml).toContain('<loom:unit');
    expect(exported.xml).toContain('loom:start="0"');
    const reparsed = parseXml(exported.xml);
    expect(reparsed.root.local).toBe('corpus');
  });
});

describe('往返核验三分类', () => {
  it('干净导出：见证子树零差异，apparatus 记为已知编辑并能追到事件', () => {
    const xml = '<TEI><text><body><p>學而時習之，不亦說乎</p></body></text></TEI>';
    const { store, ids } = storeWith([{ name: '甲', xml }]);
    store.createUnit({
      title: '句读',
      anchors: [{ witnessId: ids[0], start: 0, end: 5 }],
      readings: [{
        witnessId: ids[0], type: 'lacuna', note: '缺文标记',
        fragments: [{ start: 0, end: 5, order: 0 }],
      }],
    }, { editor: '编者甲', baseRevision: store.state.revision });
    const exported = buildExport(store.state);
    const report = runRoundtrip(store.state, exported.xml);
    expect(report.ok).toBe(true);
    expect(report.counts['unacceptable-loss']).toBe(0);
    const known = report.diffs.filter((d) => d.classification === 'known-edit');
    expect(known.some((d) => d.kind === 'apparatus-added')).toBe(true);
    expect(known.find((d) => d.kind === 'apparatus-added')!.eventIds.length).toBeGreaterThan(0);
  });

  it('导出错改/丢失节点时判定为不可接受丢失，且无事件支撑', () => {
    const xml = '<TEI><text><body><p>前段<hi rend="b">中間</hi>後段</p></body></text></TEI>';
    const { store } = storeWith([{ name: '甲', xml }]);
    const tampered =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<loom:corpus xmlns:loom="${LOOM_NS}">
        <loom:witness loom:id="${store.state.witnesses[0].id}" loom:name="甲" loom:sha256="${store.state.witnesses[0].sha256}">
          <TEI><text><body><p>前段後段</p></body></text></TEI>
        </loom:witness>
        <loom:apparatus/>
      </loom:corpus>`;
    const report = runRoundtrip(store.state, tampered);
    expect(report.ok).toBe(false);
    const losses = report.diffs.filter((d) => d.classification === 'unacceptable-loss');
    expect(losses.some((l) => l.kind === 'element-removed' && l.originalSnippet.includes('hi'))).toBe(true);
    expect(losses.some((l) => l.kind === 'text-changed')).toBe(true);
    for (const loss of losses) expect(loss.eventIds).toEqual([]);
  });

  it('仅实体写法差异归为词法变化（语义不变）', () => {
    const xml = '<TEI><p xml:id="a">學&#32780;時習之</p></TEI>';
    const { store } = storeWith([{ name: '甲', xml }]);
    const lexical =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<loom:corpus xmlns:loom="${LOOM_NS}">
        <loom:witness loom:id="${store.state.witnesses[0].id}" loom:name="甲" loom:sha256="${store.state.witnesses[0].sha256}">
          <TEI><p xml:id="a">學而時習之</p></TEI>
        </loom:witness>
        <loom:apparatus/>
      </loom:corpus>`;
    const report = runRoundtrip(store.state, lexical);
    expect(report.counts['unacceptable-loss']).toBe(0);
    expect(report.diffs.some((d) => d.classification === 'lexical' && d.kind === 'entity-changed')).toBe(true);
  });
});
