/**
 * 保真 XML 解析器：
 * - 每个节点保留在原始字符串中的 [start, end) 偏移，原始字节可随时切回；
 * - 属性按出现顺序保存；
 * - 文本节点保留实体引用的原始写法（如 &amp; 与 &#38; 的区别），解码只发生在派生视图；
 * - 未知元素照常解析，绝不丢弃。
 */

export interface Attr {
  name: string;
  value: string;
}

export type XmlNode =
  | { kind: 'element'; name: string; attrs: Attr[]; children: XmlNode[]; start: number; end: number; selfClosing: boolean }
  | { kind: 'text'; raw: string; start: number; end: number }
  | { kind: 'cdata'; raw: string; start: number; end: number }
  | { kind: 'comment' | 'pi' | 'doctype'; raw: string; start: number; end: number };

export interface ParseIssue {
  message: string;
  offset: number;
}

export function localName(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

export function parseXml(src: string): { nodes: XmlNode[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const rootChildren: XmlNode[] = [];
  const stack: Extract<XmlNode, { kind: 'element' }>[] = [];
  const push = (node: XmlNode) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push(node);
    else rootChildren.push(node);
  };

  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const stop = next === -1 ? src.length : next;
      push({ kind: 'text', raw: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? src.length : end + 3;
      if (end === -1) issues.push({ message: '未闭合的注释', offset: i });
      push({ kind: 'comment', raw: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const stop = end === -1 ? src.length : end + 3;
      if (end === -1) issues.push({ message: '未闭合的 CDATA', offset: i });
      push({ kind: 'cdata', raw: src.slice(i + 9, end === -1 ? src.length : end), start: i, end: stop });
      i = stop;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      if (end === -1) issues.push({ message: '未闭合的处理指令', offset: i });
      push({ kind: 'pi', raw: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i + 2);
      const stop = end === -1 ? src.length : end + 1;
      if (end === -1) issues.push({ message: '未闭合的声明', offset: i });
      push({ kind: 'doctype', raw: src.slice(i, stop), start: i, end: stop });
      i = stop;
      continue;
    }
    if (src.startsWith('</', i)) {
      const m = /^<\/([^\s>]+)\s*>/.exec(src.slice(i));
      if (!m) {
        issues.push({ message: '非法结束标签', offset: i });
        i += 1;
        continue;
      }
      const name = m[1];
      const open = stack.pop();
      if (!open || open.name !== name) {
        issues.push({ message: `结束标签不匹配: ${name}`, offset: i });
        if (open) stack.push(open);
      } else {
        open.end = i + m[0].length;
      }
      i += m[0].length;
      continue;
    }
    const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(src.slice(i));
    if (!m) {
      issues.push({ message: '非法标签', offset: i });
      i += 1;
      continue;
    }
    const name = m[1];
    const attrSrc = m[2] || '';
    const attrs: Attr[] = [];
    const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = re.exec(attrSrc))) {
      attrs.push({ name: am[1], value: am[2] ?? am[3] ?? am[4] ?? '' });
    }
    const selfClosing = m[3] === '/';
    const node: Extract<XmlNode, { kind: 'element' }> = {
      kind: 'element',
      name,
      attrs,
      children: [],
      start: i,
      end: i + m[0].length,
      selfClosing,
    };
    push(node);
    if (!selfClosing) stack.push(node);
    i += m[0].length;
  }
  while (stack.length > 0) {
    const open = stack.pop()!;
    issues.push({ message: `未闭合的元素: ${open.name}`, offset: open.start });
  }
  return { nodes: rootChildren, issues };
}

export function walkElements(nodes: XmlNode[], out: Extract<XmlNode, { kind: 'element' }>[] = []): Extract<XmlNode, { kind: 'element' }>[] {
  for (const n of nodes) {
    if (n.kind === 'element') {
      out.push(n);
      walkElements(n.children, out);
    }
  }
  return out;
}

/** 由原始偏移计算 行:列 定位（1 起） */
export function lineCol(src: string, offset: number): string {
  let line = 1;
  let col = 1;
  for (let k = 0; k < offset && k < src.length; k++) {
    if (src[k] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return `第${line}行第${col}列`;
}
