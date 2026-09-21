/**
 * XML 分词器：保留每个 token 的原始字节区间（raw offsets），
 * 不规范化任何内容 —— 空白、属性顺序、实体写法、注释、PI 全部原样保留。
 */

export interface XmlAttr {
  name: string;        // 原始属性名（含前缀）
  value: string;       // 实体解码后的值
  rawValue: string;    // 引号内原始写法
  quote: '"' | "'" | null;
  raw: string;         // 属性完整原始片段
}

export type Token =
  | { kind: 'start'; name: string; attrs: XmlAttr[]; start: number; end: number; raw: string }
  | { kind: 'empty'; name: string; attrs: XmlAttr[]; start: number; end: number; raw: string }
  | { kind: 'end'; name: string; start: number; end: number; raw: string }
  | { kind: 'text'; start: number; end: number; raw: string }
  | { kind: 'cdata'; text: string; start: number; end: number; raw: string }
  | { kind: 'comment'; start: number; end: number; raw: string }
  | { kind: 'pi'; target: string; start: number; end: number; raw: string }
  | { kind: 'doctype'; start: number; end: number; raw: string }
  | { kind: 'decl'; start: number; end: number; raw: string };

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'",
};

/** 解码实体引用，同时给出每个输出字符对应的原始偏移映射。 */
export function decodeEntitiesWithMap(
  raw: string,
  rawStart: number,
): { text: string; toRaw: number[] } {
  let text = '';
  const toRaw: number[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '&') {
      const semi = raw.indexOf(';', i);
      if (semi > i) {
        const body = raw.slice(i + 1, semi);
        let decoded: string | null = null;
        if (body[0] === '#') {
          const hex = body[1] === 'x' || body[1] === 'X';
          const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (Number.isFinite(code)) decoded = String.fromCodePoint(code);
        } else if (body in NAMED_ENTITIES) {
          decoded = NAMED_ENTITIES[body];
        }
        if (decoded !== null) {
          for (const ch of decoded) {
            text += ch;
            toRaw.push(rawStart + i);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    const ch = String.fromCodePoint(raw.codePointAt(i)!);
    text += ch;
    toRaw.push(rawStart + i);
    i += ch.length;
  }
  toRaw.push(rawStart + raw.length);
  return { text, toRaw };
}

export function decodeEntities(raw: string): string {
  return decodeEntitiesWithMap(raw, 0).text;
}

function parseAttrs(inner: string, offset: number): XmlAttr[] {
  const attrs: XmlAttr[] = [];
  const re = /([^\s=/>]+)(\s*=\s*("[^"]*"|'[^']*'))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1];
    const rawAssign = m[2] ?? '';
    let value = '';
    let rawValue = '';
    let quote: '"' | "'" | null = null;
    if (rawAssign) {
      const q = rawAssign.indexOf('=');
      const quoted = rawAssign.slice(q + 1).trim();
      quote = quoted[0] === '"' ? '"' : "'";
      rawValue = quoted.slice(1, -1);
      value = decodeEntities(rawValue);
    }
    attrs.push({ name, value, rawValue, quote, raw: inner.slice(m.index, m.index + m[0].length) });
    void offset;
  }
  return attrs;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*/;

export function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] === '<') {
      if (xml.startsWith('<!--', i)) {
        const close = xml.indexOf('-->', i + 4);
        const end = close < 0 ? n : close + 3;
        tokens.push({ kind: 'comment', start: i, end, raw: xml.slice(i, end) });
        i = end;
      } else if (xml.startsWith('<![CDATA[', i)) {
        const close = xml.indexOf(']]>', i + 9);
        const end = close < 0 ? n : close + 3;
        tokens.push({ kind: 'cdata', text: xml.slice(i + 9, close < 0 ? n : close), start: i, end, raw: xml.slice(i, end) });
        i = end;
      } else if (xml.startsWith('<?', i)) {
        const close = xml.indexOf('?>', i + 2);
        const end = close < 0 ? n : close + 2;
        const raw = xml.slice(i, end);
        const target = (raw.slice(2).match(NAME_RE) ?? [''])[0];
        if (i === 0 && target.toLowerCase() === 'xml') {
          tokens.push({ kind: 'decl', start: i, end, raw });
        } else {
          tokens.push({ kind: 'pi', target, start: i, end, raw });
        }
        i = end;
      } else if (xml.startsWith('<!', i)) {
        // DOCTYPE 等：扫描到匹配的 '>'（容忍内部子集 []）
        let depth = 0;
        let j = i + 2;
        while (j < n) {
          if (xml[j] === '[') depth++;
          else if (xml[j] === ']') depth--;
          else if (xml[j] === '>' && depth === 0) break;
          j++;
        }
        const end = Math.min(j + 1, n);
        tokens.push({ kind: 'doctype', start: i, end, raw: xml.slice(i, end) });
        i = end;
      } else if (xml.startsWith('</', i)) {
        const close = xml.indexOf('>', i + 2);
        const end = close < 0 ? n : close + 1;
        const raw = xml.slice(i, end);
        const name = (raw.slice(2).match(NAME_RE) ?? [''])[0];
        tokens.push({ kind: 'end', name, start: i, end, raw });
        i = end;
      } else {
        // 开始标签或空元素标签
        let j = i + 1;
        let quote: string | null = null;
        while (j < n) {
          const c = xml[j];
          if (quote) {
            if (c === quote) quote = null;
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === '>') {
            break;
          }
          j++;
        }
        const end = Math.min(j + 1, n);
        const raw = xml.slice(i, end);
        const nameMatch = raw.slice(1).match(NAME_RE);
        const name = nameMatch ? nameMatch[0] : '';
        const selfClosing = /\/\s*>$/.test(raw);
        const innerStart = 1 + name.length;
        const innerEnd = raw.length - (selfClosing ? 2 : 1);
        const attrs = parseAttrs(raw.slice(innerStart, Math.max(innerStart, innerEnd)), i + innerStart);
        tokens.push({ kind: selfClosing ? 'empty' : 'start', name, attrs, start: i, end, raw });
        i = end;
      }
    } else {
      const next = xml.indexOf('<', i);
      const end = next < 0 ? n : next;
      tokens.push({ kind: 'text', start: i, end, raw: xml.slice(i, end) });
      i = end;
    }
  }
  return tokens;
}

/** 由原始偏移计算 1 起始的行列号。 */
export function lineCol(xml: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let k = 0; k < offset && k < xml.length; k++) {
    if (xml[k] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}
