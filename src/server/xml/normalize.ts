/**
 * 规范化派生视图：把文档的文本内容（含 CDATA）解码实体后拼接为
 * 一条用于展示与定位的规范化字符串，并维护 规范化偏移 -> 原始偏移 的映射。
 * 原始 XML 永远原样保存在磁盘上；本视图只是派生物。
 */
import { tokenize, decodeEntitiesWithMap } from './tokenizer.js';

export interface NormalizedView {
  text: string;
  /** 长度 = text.length + 1；toRaw[i] 为规范化偏移 i 对应的原始偏移。 */
  toRaw: number[];
}

export function normalizeDocument(xml: string): NormalizedView {
  const tokens = tokenize(xml);
  let text = '';
  const toRaw: number[] = [];
  for (const tok of tokens) {
    if (tok.kind === 'text') {
      const { text: decoded, toRaw: map } = decodeEntitiesWithMap(tok.raw, tok.start);
      text += decoded;
      for (let k = 0; k < map.length - 1; k++) toRaw.push(map[k]);
    } else if (tok.kind === 'cdata') {
      for (let k = 0; k < tok.text.length; k++) {
        text += tok.text[k];
        toRaw.push(tok.start + 9 + k); // 跳过 <![CDATA[
      }
    }
  }
  toRaw.push(xml.length);
  return { text, toRaw };
}

/** 比较用规范化（NFC），用于对齐与等价判断；不影响存储。 */
export function canon(s: string): string {
  return s.normalize('NFC');
}

/** 在规范化视图中按 NFC 等价查找子串，返回规范化偏移或 -1。 */
export function indexOfCanon(haystack: string, needle: string, from = 0): number {
  const h = canon(haystack);
  const n = canon(needle);
  return h.indexOf(n, from);
}
