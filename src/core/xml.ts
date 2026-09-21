import type {
  AttributeNode,
  CDataNode,
  CommentNode,
  DoctypeNode,
  ElementNode,
  EntityRef,
  Node,
  PINode,
  TextNode,
} from './types.js';
import type { XmlDocument } from './types.js';
export type { XmlDocument } from './types.js';

export class ParseError extends Error {
  pos: number;
  constructor(message: string, pos: number) {
    super(`${message}（位置 ${pos}）`);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

interface StackFrame {
  node: ElementNode;
}

let nodeCounter = 0;
export function resetNodeCounter(): void {
  nodeCounter = 0;
}

function assignId(node: Node): void {
  if (node.kind === 'element' || node.kind === 'text' || node.kind === 'comment' ||
      node.kind === 'pi' || node.kind === 'cdata' || node.kind === 'doctype') {
    node.id = `n${nodeCounter++}`;
  }
}

function isNameStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return ch === '_' || ch === ':' || (/[A-Za-z]/.test(ch)) || ch.charCodeAt(0) > 0x7f;
}

function isNameChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return isNameStart(ch) || ch === '-' || ch === '.' || /[0-9]/.test(ch) || ch === '\u00b7';
}

const BUILTIN_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  apos: "'",
  quot: '"',
};

export function decodeEntities(raw: string): { value: string; entities: EntityRef[] } {
  let value = '';
  const entities: EntityRef[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '&') {
      value += ch;
      continue;
    }
    const semi = raw.indexOf(';', i + 1);
    if (semi === -1 || semi - i > 64) {
      value += ch;
      continue;
    }
    const body = raw.slice(i + 1, semi);
    let name = body;
    let hex = false;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      name = body.slice(2);
      hex = true;
    } else if (body.startsWith('#')) {
      name = body.slice(1);
    }
    const ref: EntityRef = {
      kind: 'entityRef',
      name,
      hex,
      raw: raw.slice(i, semi + 1),
      start: i,
      end: semi + 1,
    };
    entities.push(ref);
    if (body.startsWith('#')) {
      const cp = Number.parseInt(name, hex ? 16 : 10);
      value += Number.isFinite(cp) ? String.fromCodePoint(cp) : ref.raw;
    } else {
      value += BUILTIN_ENTITIES[name] ?? ref.raw;
    }
    i = semi;
  }
  return { value, entities };
}

export function parseXml(source: string): XmlDocument {
  resetNodeCounter();
  const content: Node[] = [];
  let declaration: PINode | null = null;
  let doctype: DoctypeNode | null = null;
  let root: ElementNode | null = null;
  const stack: StackFrame[] = [];
  let i = 0;

  const fail = (message: string, at = i): never => {
    throw new ParseError(message, at);
  };

  const current = (): ElementNode => {
    const top = stack[stack.length - 1];
    if (!top) fail('文档在根元素之外出现内容');
    return top.node;
  };

  const append = (node: Node): void => {
    assignId(node);
    if (stack.length === 0) content.push(node);
    else current().children.push(node);
  };

  while (i < source.length) {
    if (source.startsWith('<![CDATA[', i)) {
      const start = i;
      const close = source.indexOf(']]>', i + 9);
      if (close === -1) fail('未闭合的 CDATA 区段');
      const node: CDataNode = {
        kind: 'cdata',
        text: source.slice(i + 9, close),
        start,
        end: close + 3,
      };
      append(node);
      i = close + 3;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const start = i;
      const close = source.indexOf('-->', i + 4);
      if (close === -1) fail('未闭合的注释');
      if (source.slice(i + 4, close).includes('--')) fail('注释中不允许出现 --');
      const node: CommentNode = {
        kind: 'comment',
        text: source.slice(i + 4, close),
        start,
        end: close + 3,
      };
      append(node);
      i = close + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      const start = i;
      const close = source.indexOf('>', i + 2);
      if (close === -1) fail('未闭合的声明');
      const text = source.slice(i + 2, close);
      const node: DoctypeNode = { kind: 'doctype', text, start, end: close + 1 };
      assignId(node);
      if (root || stack.length > 0) fail('DOCTYPE 必须出现在根元素之前', start);
      if (doctype) fail('DOCTYPE 只能出现一次', start);
      doctype = node;
      content.push(node);
      i = close + 1;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const start = i;
      const close = source.indexOf('?>', i + 2);
      if (close === -1) fail('未闭合的处理指令');
      const body = source.slice(i + 2, close);
      const spaceIdx = body.search(/\s/);
      const target = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
      const piBody = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);
      const node: PINode = { kind: 'pi', target, body: piBody, start, end: close + 2 };
      assignId(node);
      if (target === 'xml' && declaration === null && !root && stack.length === 0) {
        declaration = node;
      }
      if (stack.length === 0 && !root) content.push(node);
      else append(node);
      i = close + 2;
      continue;
    }
    if (source.startsWith('</', i)) {
      const start = i;
      const gt = source.indexOf('>', i + 2);
      if (gt === -1) fail('未闭合的结束标签');
      const name = source.slice(i + 2, gt).trim();
      if (stack.length === 0) fail(`出现多余的结束标签 </${name}>`);
      const frame = stack[stack.length - 1];
      const opened = frame.node.prefix ? `${frame.node.prefix}:${frame.node.local}` : frame.node.local;
      if (name !== opened) fail(`结束标签 </${name}> 与开始标签 <${opened}> 不匹配`, start);
      (frame.node as { end: number }).end = gt + 1;
      (frame.node as { closeStart: number }).closeStart = i;
      (frame.node as { closeEnd: number }).closeEnd = gt + 1;
      stack.pop();
      i = gt + 1;
      continue;
    }
    if (source[i] === '<') {
      if (!isNameStart(source[i + 1])) fail('无法识别的标签');
      const start = i;
      i += 1;
      const nameStart = i;
      while (isNameChar(source[i])) i++;
      const nameEnd = i;
      const rawName = source.slice(nameStart, nameEnd);
      const colon = rawName.indexOf(':');
      const prefix = colon === -1 ? null : rawName.slice(0, colon);
      const local = colon === -1 ? rawName : rawName.slice(colon + 1);
      const attributes: AttributeNode[] = [];
      const nsDecls: AttributeNode[] = [];
      let selfClosing = false;
      while (i < source.length) {
        while (/\s/.test(source[i])) i++;
        if (source[i] === '>') {
          i++;
          break;
        }
        if (source.startsWith('/>', i)) {
          selfClosing = true;
          i += 2;
          break;
        }
        if (source.startsWith('?>', i)) fail('开始标签内出现非法字符 ?>', i);
        if (!isNameStart(source[i])) fail('开始标签内出现非法字符', i);
        const aNameStart = i;
        while (isNameChar(source[i])) i++;
        const aNameEnd = i;
        while (/\s/.test(source[i])) i++;
        if (source[i] !== '=') fail('属性缺少 = 号', i);
        i++;
        while (/\s/.test(source[i])) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== "'") fail('属性值必须用引号包裹', i);
        const valueStart = i + 1;
        i++;
        const valStart = i;
        while (i < source.length && source[i] !== quote) {
          if (source.startsWith(']]>', i)) fail('属性值中出现非法序列 ]]>');
          i++;
        }
        if (source[i] !== quote) fail('属性值缺少结束引号', valueStart - 1);
        const rawValue = source.slice(valStart, i);
        const aEnd = i + 1;
        i++;
        const aName = source.slice(aNameStart, aNameEnd);
        const aColon = aName.indexOf(':');
        const aPrefix = aColon === -1 ? null : aName.slice(0, aColon);
        const aLocal = aColon === -1 ? aName : aName.slice(aColon + 1);
        const attr: AttributeNode = {
          kind: 'attribute',
          prefix: aPrefix,
          local: aLocal,
          rawValue,
          quote: quote as '"' | "'",
          start: aNameStart,
          end: aEnd,
          nameStart: aNameStart,
          nameEnd: aNameEnd,
        };
        if (aName === 'xmlns' || aPrefix === 'xmlns') nsDecls.push(attr);
        else attributes.push(attr);
      }
      const node: ElementNode = {
        kind: 'element',
        prefix,
        local,
        attributes,
        nsDecls,
        children: [],
        start,
        end: -1,
        openEnd: i,
        selfClosing,
        closeStart: null,
        closeEnd: null,
        nameStart,
        nameEnd,
      };
      assignId(node);
      if (stack.length === 0) {
        if (root) fail('文档只允许有一个根元素', start);
        root = node;
        content.push(node);
      } else {
        current().children.push(node);
      }
      if (!selfClosing) stack.push({ node });
      else {
        (node as { end: number }).end = i;
      }
      continue;
    }
    const nextLt = source.indexOf('<', i);
    const end = nextLt === -1 ? source.length : nextLt;
    const raw = source.slice(i, end);
    const { value, entities } = decodeEntities(raw);
    const node: TextNode = { kind: 'text', value, entities, start: i, end };
    append(node);
    i = end;
  }

  if (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const name = frame.node.prefix ? `${frame.node.prefix}:${frame.node.local}` : frame.node.local;
    fail(`元素 <${name}> 缺少结束标签`, frame.node.start);
  }
  if (!root) fail('文档缺少根元素');
  return { source, content, declaration, doctype, root: root as ElementNode };
}

export function serialize(doc: XmlDocument): string {
  return doc.content.map((node) => serializeNode(node, doc.source)).join('');
}

export function serializeNode(node: Node, source: string): string {
  if (node.kind === 'element' && node.end >= node.start && node.closeEnd !== null && !node.selfClosing) {
    const head = source.slice(node.start, node.openEnd);
    const tail = node.closeStart === null ? '' : source.slice(node.closeStart, node.closeEnd ?? node.closeStart);
    const body = node.children.map((child) => serializeNode(child, source)).join('');
    return head + body + tail;
  }
  if (node.start >= 0 && node.end > node.start) return source.slice(node.start, node.end);
  return '';
}

export function qname(node: ElementNode | AttributeNode): string {
  return node.prefix ? `${node.prefix}:${node.local}` : node.local;
}

export function attrValue(attr: AttributeNode): string {
  return decodeEntities(attr.rawValue).value;
}

export function findAttr(el: ElementNode, name: string): AttributeNode | undefined {
  return el.attributes.find((a) => qname(a) === name);
}
