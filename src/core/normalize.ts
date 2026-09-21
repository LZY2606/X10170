import { attrValue, findAttr, qname } from './xml.js';
import type { ElementNode, Node, TextNode } from './types.js';
import type { XmlDocument } from './types.js';

export interface Grapheme {
  /** code point index in the normalized text of this witness */
  offset: number;
  text: string;
  /** source byte/code-unit slice boundaries this grapheme came from */
  nodeId: string;
  start: number;
  end: number;
}

export interface Marker {
  offset: number;
  kind: 'page' | 'milestone';
  label: string;
  nodeId: string;
}

export interface NormalizedView {
  text: string;
  graphemes: Grapheme[];
  markers: Marker[];
}

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'grapheme' });

function pageLike(el: ElementNode): { kind: 'page' | 'milestone'; label: string } | null {
  const name = qname(el);
  if (name === 'pb') {
    const n = findAttr(el, 'n') ?? findAttr(el, 'xml:id');
    return { kind: 'page', label: n ? attrValue(n) : '' };
  }
  if (name === 'milestone') {
    const unit = findAttr(el, 'unit');
    return { kind: 'milestone', label: unit ? attrValue(unit) : '' };
  }
  return null;
}

function appendText(
  view: NormalizedView,
  node: TextNode,
  value: string,
  unitOffset: number,
): void {
  const segs = Array.from(SEGMENTER.segment(value));
  for (const seg of segs) {
    const g: Grapheme = {
      offset: view.text.length,
      text: seg.segment,
      nodeId: node.id!,
      start: unitOffset + seg.index,
      end: unitOffset + seg.index + seg.segment.length,
    };
    view.graphemes.push(g);
    view.text += seg.segment;
  }
}

function walk(node: Node, view: NormalizedView, source: XmlDocument['source']): void {
  if (node.kind === 'text') {
    appendText(view, node, node.value, 0);
    return;
  }
  if (node.kind === 'cdata') {
    const synthetic: TextNode = {
      kind: 'text',
      value: node.text,
      entities: [],
      start: node.start,
      end: node.end,
      id: node.id,
    };
    appendText(view, synthetic, node.text, 0);
    return;
  }
  if (node.kind === 'element') {
    const marker = pageLike(node);
    if (marker) {
      view.markers.push({ offset: view.text.length, kind: marker.kind, label: marker.label, nodeId: node.id! });
      return;
    }
    for (const child of node.children) walk(child, view, source);
  }
}

export function normalize(doc: XmlDocument): NormalizedView {
  const view: NormalizedView = { text: '', graphemes: [], markers: [] };
  for (const child of doc.root.children) walk(child, view, doc.source);
  return view;
}

export function graphemesAt(view: NormalizedView, start: number, end: number): Grapheme[] {
  return view.graphemes.filter((g) => g.offset >= start && g.offset + g.text.length <= end);
}

/**
 * 校验选区不切断任何字形簇（组合字符必须与基字符同在一个锚点范围内）。
 */
export function validateRange(view: NormalizedView, start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return '范围端点必须是整数';
  if (start < 0 || end > view.text.length) return '范围超出规范化文本边界';
  if (start >= end) return '范围必须至少包含一个字符';
  const starts = new Set(view.graphemes.map((g) => g.offset));
  if (!starts.has(start)) return '起点切断了组合字符（必须落在字形簇边界上）';
  if (end !== view.text.length && !starts.has(end)) return '终点切断了组合字符（必须落在字形簇边界上）';
  return null;
}
