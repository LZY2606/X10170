import { describe, expect, it } from 'vitest';
import { ProjectStore, RevisionConflict } from '../src/core/store.js';
import type { Anchor, Reading } from '../src/core/model.js';

function seededStore(): { store: ProjectStore; w1: string; w2: string } {
  const store = new ProjectStore();
  const ctxA = { editor: '编者甲', baseRevision: 0 };
  const r1 = store.importWitness({ name: '甲本', rawXml: `<p>${'一二三四五六七八九十'}</p>` }, ctxA);
  const w1 = (r1.event.after as { id: string }).id;
  const r2 = store.importWitness({ name: '乙本', rawXml: `<p>${'壹貳參四五六七八九十'}</p>` },
    { editor: '编者甲', baseRevision: 1 });
  const w2 = (r2.event.after as { id: string }).id;
  return { store, w1, w2 };
}

function anchor(witnessId: string, start: number, end: number): Anchor {
  return { witnessId, start, end };
}

function originalReading(witnessId: string, start: number, end: number): Reading {
  return { witnessId, type: 'original', note: '', fragments: [{ start, end, order: 0 }] };
}

describe('交叠与倒置', () => {
  it('同一见证内交叉锚点允许，包含锚点拒绝', () => {
    const { store, w1: W1, w2: _w2 } = seededStore();
    const ok = store.createUnit({
      title: '单元一',
      anchors: [anchor(W1, 0, 4)],
      readings: [originalReading(W1, 0, 4)],
    }, { editor: '编者甲', baseRevision: 2 });
    expect(ok.event.revision).toBe(3);
    const crossing = store.createUnit({
      title: '单元二-交叉',
      anchors: [anchor(W1, 2, 6)],
      readings: [originalReading(W1, 2, 6)],
    }, { editor: '编者甲', baseRevision: 3 });
    expect(crossing.event.revision).toBe(4);
    expect(() =>
      store.createUnit({
        title: '单元三-包含',
        anchors: [anchor(W1, 1, 3)],
        readings: [originalReading(W1, 1, 3)],
      }, { editor: '编者甲', baseRevision: 4 }),
    ).toThrow(/互相包含/);
    expect(() =>
      store.createUnit({
        title: '单元四-相同',
        anchors: [anchor(W1, 0, 4)],
        readings: [originalReading(W1, 0, 4)],
      }, { editor: '编者甲', baseRevision: 4 }),
    ).toThrow(/完全相同/);
  });

  it('倒置：两段互不交叠，order 与文档顺序相反时仍为合法异序异读', () => {
    const { store, w1: W1, w2: W2 } = seededStore();
    const transposition: Reading = {
      witnessId: W2,
      type: 'transposition',
      note: '乙本把后半倒置抄到前面',
      fragments: [
        { start: 6, end: 10, order: 0 },
        { start: 0, end: 4, order: 1 },
      ],
    };
    const result = store.createUnit({
      title: '倒置句',
      anchors: [anchor(W1, 0, 10), anchor(W2, 0, 10)],
      readings: [
        originalReading(W1, 0, 10),
        transposition,
      ],
    }, { editor: '编者乙', baseRevision: 2 });
    expect(result.state.units[0].readings[1].type).toBe('transposition');
    const bad: Reading = {
      witnessId: W2,
      type: 'transposition',
      note: '片段交叠',
      fragments: [
        { start: 0, end: 6, order: 0 },
        { start: 4, end: 10, order: 1 },
      ],
    };
    expect(() =>
      store.createUnit({
        title: '坏倒置',
        anchors: [anchor(W2, 8, 10)],
        readings: [bad],
      }, { editor: '编者乙', baseRevision: 3 }),
    ).toThrow(/倒置片段彼此交叠/);
  });
});

describe('并发冲突与删除保护', () => {
  it('基于旧版本提交的第二人得到 409 风格冲突，载荷含双方范围和片段线索', () => {
    const { store, w1: W1, w2: W2 } = seededStore();
    store.createUnit({
      title: '甲的单元',
      anchors: [anchor(W1, 0, 3)],
      readings: [originalReading(W1, 0, 3)],
    }, { editor: '编者甲', baseRevision: 2 });
    let caught: RevisionConflict | null = null;
    try {
      store.createUnit({
        title: '乙基于旧版本的单元',
        anchors: [anchor(W2, 0, 3)],
        readings: [originalReading(W2, 0, 3)],
      }, { editor: '编者乙', baseRevision: 2 });
    } catch (err) {
      caught = err as RevisionConflict;
    }
    expect(caught).toBeInstanceOf(RevisionConflict);
    expect(caught!.detail.currentRevision).toBe(3);
    expect(caught!.detail.interveningEvents).toHaveLength(1);
    expect(caught!.detail.interveningEvents[0].summary).toContain('甲的单元');
    expect(store.state.revision).toBe(3);
  });

  it('删除被引用的见证被拒绝，并列出引用单元', () => {
    const { store, w1: W1, w2: _w2 } = seededStore();
    store.createUnit({
      title: '引用单元',
      anchors: [anchor(W1, 0, 2)],
      readings: [originalReading(W1, 0, 2)],
    }, { editor: '编者甲', baseRevision: 2 });
    const check = store.checkDeleteWitness(W1);
    expect(check.blocked).toBe(true);
    expect(check.referenced[0].title).toBe('引用单元');
    expect(() =>
      store.deleteWitness(W1, { editor: '编者甲', baseRevision: 3 }),
    ).toThrow(/仍有 1 个校勘单元引用/);
  });

  it('锚点修订保留旧版本并登记受影响单元', () => {
    const { store, w1: W1, w2: _w2 } = seededStore();
    store.createUnit({
      title: '待修订',
      anchors: [anchor(W1, 0, 4)],
      readings: [originalReading(W1, 0, 4)],
    }, { editor: '编者甲', baseRevision: 2 });
    const result = store.reviseAnchor(W1, { start: 0, end: 4 }, { start: 1, end: 5 },
      { editor: '编者甲', baseRevision: 3 });
    expect(result.event.before).toEqual({ witnessId: W1, start: 0, end: 4 });
    expect(result.event.affectedUnits).toEqual([store.state.units[0].id]);
    expect(store.state.units[0].anchors[0]).toMatchObject({ start: 1, end: 5 });
  });

  it('缺文与编辑判断异读可入库', () => {
    const { store, w1: W1, w2: W2 } = seededStore();
    const lacuna: Reading = { witnessId: W2, type: 'lacuna', note: '虫蛀缺三字', fragments: [{ start: 2, end: 5, order: 0 }] };
    const judgment: Reading = { witnessId: W2, type: 'judgment', note: '据他本补', fragments: [] };
    store.createUnit({
      title: '缺文判断',
      anchors: [anchor(W1, 0, 5)],
      readings: [originalReading(W1, 0, 5), lacuna, judgment],
    }, { editor: '编者甲', baseRevision: 2 });
    expect(store.state.units[0].readings.map((r) => r.type)).toEqual(['original', 'lacuna', 'judgment']);
    expect(() => new ProjectStore(store.state as never)).not.toThrow();
  });
});
