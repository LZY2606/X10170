/**
 * 由 token 流构建元素树；每个节点保留原始区间。
 * 未知元素照常进入树中 —— 是否可导出的判断在导出预检阶段进行。
 */
import { tokenize, type Token, type XmlAttr } from './tokenizer.js';

export interface ElementNode {
  type: 'element';
  name: string;            // 原始限定名（含前缀）
  localName: string;
  prefix: string | null;
  attrs: XmlAttr[];
  children: Node[];
  parent: ElementNode | null;
  start: number;           // 开始标签起点（raw offset）
  end: number;             // 结束标签终点（raw offset）
  contentStart: number;    // 开始标签之后
  contentEnd: number;      // 结束标签之前
  selfClosing: boolean;
}

export interface TextNode {
  type: 'text';
  text: string;            // 解码后文本
  start: number;
  end: number;
  parent: ElementNode | null;
}

export type Node = ElementNode | TextNode;

export interface ParsedDocument {
  xml: string;
  tokens: Token[];
  roots: Node[];
  elements: ElementNode[]; // 文档顺序
}

export function parseDocument(xml: string): ParsedDocument {
  const tokens = tokenize(xml);
  const roots: Node[] = [];
  const elements: ElementNode[] = [];
  const stack: ElementNode[] = [];

  const attach = (node: Node) => {
    const parent = stack.length ? stack[stack.length - 1] : null;
    node.parent = parent;
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  for (const tok of tokens) {
    if (tok.kind === 'start' || tok.kind === 'empty') {
      const q = tok.name;
      const colon = q.indexOf(':');
      const el: ElementNode = {
        type: 'element',
        name: q,
        localName: colon >= 0 ? q.slice(colon + 1) : q,
        prefix: colon >= 0 ? q.slice(0, colon) : null,
        attrs: tok.attrs,
        children: [],
        parent: null,
        start: tok.start,
        end: tok.end,
        contentStart: tok.end,
        contentEnd: tok.end,
        selfClosing: tok.kind === 'empty',
      };
      attach(el);
      elements.push(el);
      if (tok.kind === 'start') stack.push(el);
    } else if (tok.kind === 'end') {
      // 宽松闭合：弹到匹配元素为止；未匹配则忽略
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === tok.name) {
          while (stack.length > k) {
            const el = stack.pop()!;
            el.end = tok.end;
            el.contentEnd = tok.start;
          }
          break;
        }
      }
    } else if (tok.kind === 'text') {
      if (tok.raw.length === 0) continue;
      attach({ type: 'text', text: tok.raw, start: tok.start, end: tok.end, parent: null });
    } else if (tok.kind === 'cdata') {
      attach({ type: 'text', text: tok.text, start: tok.start, end: tok.end, parent: null });
    }
  }
  // 未闭合元素：延伸到文档末尾
  while (stack.length) {
    const el = stack.pop()!;
    el.end = xml.length;
    el.contentEnd = xml.length;
  }
  return { xml, tokens, roots, elements };
}
