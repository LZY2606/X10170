import { XmlNode } from './xml';

/**
 * 派生视图：仅用于页面展示与锚点定位。
 * 原始 XML 永远不动；这里输出的每个字符都能映射回原始字节偏移。
 */

export interface EntityIssue {
  raw: string;
  offset: number;
}

export interface DerivedText {
  /** 解码实体后的展示文本（UTF-16 码元偏移） */
  text: string;
  /** toRaw[i] = 派生文本第 i 个码元在原始 XML 中的偏移，长度 text.length + 1 */
  toRaw: number[];
  /** 无法识别的实体引用（原样保留在展示文本中，并在此报告） */
  entityIssues: EntityIssue[];
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

export function decodeEntities(raw: string, baseOffset: number): DerivedText {
  let text = '';
  const toRaw: number[] = [];
  const entityIssues: EntityIssue[] = [];
  const pushChars = (s: string, rawPos: number) => {
    for (let k = 0; k < s.length; k++) {
      text += s[k];
      toRaw.push(rawPos);
    }
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '&') {
      const semi = raw.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 32) {
        const body = raw.slice(i + 1, semi);
        let decoded: string | null = null;
        if (body in NAMED_ENTITIES) decoded = NAMED_ENTITIES[body];
        else if (/^#\d+$/.test(body)) decoded = String.fromCodePoint(parseInt(body.slice(1), 10));
        else if (/^#[xX][0-9a-fA-F]+$/.test(body)) decoded = String.fromCodePoint(parseInt(body.slice(2), 16));
        if (decoded !== null) {
          pushChars(decoded, i);
          i = semi + 1;
          continue;
        }
        // 未知实体：不丢、不改，原样进入派生视图并记录问题
        entityIssues.push({ raw: raw.slice(i, semi + 1), offset: baseOffset + i });
        pushChars(raw.slice(i, semi + 1), i);
        i = semi + 1;
        continue;
      }
    }
    pushChars(ch, i);
    i += 1;
  }
  toRaw.push(baseOffset + raw.length);
  return { text, toRaw, entityIssues };
}

export function deriveText(nodes: XmlNode[]): DerivedText {
  let text = '';
  const toRaw: number[] = [];
  const entityIssues: EntityIssue[] = [];
  let tail = 0;
  const append = (d: DerivedText) => {
    for (let k = 0; k < d.text.length; k++) toRaw.push(d.toRaw[k]);
    tail = d.toRaw[d.text.length];
    text += d.text;
    entityIssues.push(...d.entityIssues);
  };
  const walk = (ns: XmlNode[]) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        append(decodeEntities(n.raw, n.start));
      } else if (n.kind === 'cdata') {
        const toRawC: number[] = [];
        for (let k = 0; k <= n.raw.length; k++) toRawC.push(n.start + 9 + k);
        append({ text: n.raw, toRaw: toRawC, entityIssues: [] });
      } else if (n.kind === 'element') {
        walk(n.children);
      }
      // comment / pi / doctype 不进入派生文本，但保留在语法树中
    }
  };
  walk(nodes);
  toRaw.push(tail);
  return { text, toRaw, entityIssues };
}

/**
 * NFC 规范化视图：组合字符（如 e + U+0301）在展示层合并为单个字素。
 * toBase 把规范化后的偏移映射回派生文本偏移，保证锚点在两种视图间往返稳定。
 */
export function nfcView(text: string): { text: string; toBase: number[] } {
  const norm = text.normalize('NFC');
  const normPosOfBase: number[] = new Array(text.length + 1);
  for (let b = 0; b <= text.length; b++) {
    normPosOfBase[b] = text.slice(0, b).normalize('NFC').length;
  }
  const toBase: number[] = new Array(norm.length + 1).fill(0);
  let prev = 0;
  for (let b = 1; b <= text.length; b++) {
    const p = normPosOfBase[b];
    if (p > prev) {
      for (let k = prev + 1; k <= p; k++) toBase[k] = b;
      prev = p;
    }
  }
  return { text: norm, toBase };
}

export function sliceRange(text: string, start: number, end: number): string {
  return text.slice(start, end);
}
