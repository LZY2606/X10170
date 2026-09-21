import { describe, expect, it } from 'vitest';
import { parseXml, serialize, qname, attrValue, decodeEntities } from '../src/core/xml.js';

describe('XML 词法保真', () => {
  it('往返后与原始输入逐字节一致（空白、属性序、自闭合、注释、PI）', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- 古籍见证：保留空白 -->\n' +
      '<TEI xmlns="http://www.tei-c.org/ns/1.0" xml:id="alpha"  custom-z="x">\n' +
      '  <text><body><p>子曰：<hi rend="bold">學而時習之</hi></p>\n' +
      '  <pb n="2"/><gap reason="lacuna"/></body></text>\n' +
      '</TEI>\n';
    const doc = parseXml(xml);
    expect(serialize(doc)).toBe(xml);
    expect(doc.declaration?.target).toBe('xml');
  });

  it('保留命名空间前缀、自定义属性和命名空间声明', () => {
    const xml = '<root xmlns:ed="http://example.org/ed" xmlns="http://default"><ed:note ed:level="3" z-last="1">文</ed:note></root>';
    const doc = parseXml(xml);
    expect(qname(doc.root)).toBe('root');
    const note = doc.root.children[0];
    expect(note.kind).toBe('element');
    if (note.kind === 'element') {
      expect(note.prefix).toBe('ed');
      expect(note.local).toBe('note');
      expect(note.nsDecls.length).toBe(0);
      expect(qname(note.attributes[0])).toBe('ed:level');
      expect(qname(note.attributes[1])).toBe('z-last');
    }
    expect(doc.root.nsDecls.map((a) => qname(a))).toEqual(['xmlns:ed', 'xmlns']);
  });

  it('原样保留命名实体、字符引用和实体写法（不悄悄改写）', () => {
    const { value, entities } = decodeEntities('a&amp;b&#21495;c&#x4e2d;d&unknownEnt;e');
    expect(value).toBe('a&b号c中d&unknownEnt;e');
    expect(entities.map((x) => x.raw)).toEqual(['&amp;', '&#21495;', '&#x4e2d;', '&unknownEnt;']);
    const xml = '<p>學而&#21495;時習 &amp; &custom; 之</p>';
    const doc = parseXml(xml);
    expect(serialize(doc)).toBe(xml);
  });

  it('属性中的实体也被记录，词法形式不丢', () => {
    const xml = '<p n="a&amp;b&#x4e2d;">x</p>';
    const doc = parseXml(xml);
    const attr = doc.root.attributes[0];
    expect(attr.rawValue).toBe('a&amp;b&#x4e2d;');
    expect(attrValue(attr)).toBe('a&b中');
    expect(attr.quote).toBe('"');
  });

  it('单引号属性、CDATA、处理指令原样保留', () => {
    const xml = "<?custom pi?><root attr='a&amp;b'><![CDATA[<not a tag> & raw]]><?other go?></root>";
    const doc = parseXml(xml);
    expect(serialize(doc)).toBe(xml);
    expect(doc.root.attributes[0].quote).toBe("'");
  });

  it('标签不匹配与未闭合报错并给出位置', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(/不匹配/);
    expect(() => parseXml('<a>text')).toThrow(/缺少结束标签/);
    expect(() => parseXml('<a attr="x>y</a>')).toThrow(/引号/);
  });
});
