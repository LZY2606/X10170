import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/core/xml.js';
import { normalize, validateRange } from '../src/core/normalize.js';

describe('规范化派生视图与锚点', () => {
  it('跨元素范围映射到连续规范化文本，且不修改原文', () => {
    const xml = '<TEI><text><body><p>學而<hi>時習</hi>之</p></body></text></TEI>';
    const doc = parseXml(xml);
    const view = normalize(doc);
    expect(view.text).toBe('學而時習之');
    expect(view.graphemes.map((g) => g.nodeId).length).toBe(5);
    expect(doc.source).toBe(xml);
  });

  it('组合字符（基字符 +  combining mark）不能被锚点边界切断', () => {
    const composed = 'e\u0301a';
    const xml = `<p>${composed}</p>`;
    const view = normalize(parseXml(xml));
    expect(view.text).toBe(composed);
    expect(validateRange(view, 0, 1)).toMatch(/组合字符/);
    expect(validateRange(view, 0, 2)).toBeNull();
    expect(validateRange(view, 1, 2)).toMatch(/组合字符/);
  });

  it('页码 pb 与 milestone 产生非文本标记', () => {
    const xml = '<body><p>前段</p><pb n="12"/><milestone unit="stanza"/>后段</body>';
    const view = normalize(parseXml(xml));
    expect(view.text).toBe('前段后段');
    expect(view.markers.map((m) => [m.kind, m.label, m.offset])).toEqual([
      ['page', '12', 2],
      ['milestone', 'stanza', 2],
    ]);
  });

  it('CDATA 文本进入规范化视图', () => {
    const view = normalize(parseXml('<root><![CDATA[一二三]]></root>'));
    expect(view.text).toBe('一二三');
  });
});
