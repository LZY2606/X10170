/**
 * 导出与预检：
 * - 预检扫描所有校勘单元涉及的原始区间，遇到无法安全映射的未知结构
 *   （未知元素 / 未知命名空间前缀）即阻止导出并给出定位。
 * - 导出生成带 apparatus 的 TEI 风格 XML。
 */
import { parseDocument, type ElementNode } from './xml/model.js';
import { lineCol } from './xml/tokenizer.js';
import type { Store, Unit, Reading } from './store.js';

/** 可安全映射的已知元素（按 localName 判断，允许 tei/xml 前缀）。 */
export const KNOWN_ELEMENTS = new Set([
  'TEI', 'teiHeader', 'fileDesc', 'titleStmt', 'title', 'publicationStmt',
  'sourceDesc', 'text', 'body', 'front', 'back', 'div', 'div1', 'div2',
  'p', 'pb', 'lb', 'cb', 'head', 'hi', 'app', 'lem', 'rdg', 'note', 'seg',
  'ab', 'sp', 'speaker', 'stage', 'list', 'item', 'name', 'date', 'quote',
  'said', 'add', 'del', 'gap', 'unclear', 'supplied', 'choice', 'orig',
  'reg', 'sic', 'corr', 'expan', 'abbr', 'milestone', 'anchor', 'fw',
  'figure', 'table', 'row', 'cell', 'ref', 'ptr', 'listWit', 'witness',
  'msDesc', 'msIdentifier', 'settlement', 'repository', 'idno', 'desc',
  'respStmt', 'resp', 'editionStmt', 'edition', 'extent', 'bibl', 'author',
  'editor', 'encodingDesc', 'revisionDesc', 'change', 'listBibl', 'lg', 'l',
]);

const KNOWN_PREFIXES = new Set([null, 'tei', 'xml']);

export interface PreflightError {
  unitId: string;
  unitName: string;
  witnessId: string;
  element: string;
  rawOffset: number;
  line: number;
  col: number;
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: PreflightError[];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/** 找出与 [rawStart, rawEnd) 相交的元素节点。 */
function elementsIntersecting(elements: ElementNode[], rawStart: number, rawEnd: number): ElementNode[] {
  return elements.filter((el) => el.start < rawEnd && el.end > rawStart);
}

export function preflight(store: Store): PreflightResult {
  const errors: PreflightError[] = [];
  for (const unit of store.units.values()) {
    for (const reading of unit.readings) {
      const w = store.getWitness(reading.witnessId);
      if (!w) continue;
      const rawStart = w.view.toRaw[reading.start];
      const rawEnd = w.view.toRaw[reading.end];
      const doc = parseDocument(w.xml);
      for (const el of elementsIntersecting(doc.elements, rawStart, rawEnd)) {
        const known = KNOWN_ELEMENTS.has(el.localName) && KNOWN_PREFIXES.has(el.prefix);
        if (!known) {
          const { line, col } = lineCol(w.xml, el.start);
          errors.push({
            unitId: unit.id,
            unitName: unit.name,
            witnessId: w.id,
            element: el.name,
            rawOffset: el.start,
            line,
            col,
            message: `未知结构 <${el.name}> 与单元「${unit.name}」的区间相交（${w.name} 第 ${line} 行第 ${col} 列），无法安全映射，已阻止导出`,
          });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export class ExportBlockedError extends Error {
  constructor(public errors: PreflightError[]) {
    super(`导出被阻止：${errors.length} 处未知结构`);
    this.name = 'ExportBlockedError';
  }
}

function readingXml(store: Store, unit: Unit, reading: Reading, tag: 'lem' | 'rdg'): string {
  const wit = `#${reading.witnessId}`;
  const attrs = tag === 'lem' ? ` wit="${wit}"` : ` wit="${wit}"`;
  if (reading.type === 'lacuna') {
    return `<${tag}${attrs} type="lacuna"><gap reason="lacuna"/></${tag}>`;
  }
  const text = store.resolveReading(unit, reading);
  const typeAttr = reading.type === 'original' ? '' : ` type="${reading.type}"`;
  const note = reading.note ? `<note>${escapeXml(reading.note)}</note>` : '';
  return `<${tag}${attrs}${typeAttr}>${escapeXml(text)}${note}</${tag}>`;
}

export function exportXml(store: Store): string {
  const check = preflight(store);
  if (!check.ok) throw new ExportBlockedError(check.errors);

  const witnesses = store.listWitnesses();
  const base = witnesses[0];
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<TEI xmlns="http://www.tei-c.org/ns/1.0">`);
  lines.push(`  <teiHeader>`);
  lines.push(`    <fileDesc>`);
  lines.push(`      <titleStmt><title>异文织机导出</title></titleStmt>`);
  lines.push(`      <publicationStmt><p>由异文织机本地导出</p></publicationStmt>`);
  lines.push(`      <sourceDesc>`);
  lines.push(`        <listWit>`);
  for (const w of witnesses) {
    lines.push(`          <witness xml:id="${escapeAttr(w.id)}">${escapeXml(w.name)}</witness>`);
  }
  lines.push(`        </listWit>`);
  lines.push(`      </sourceDesc>`);
  lines.push(`    </fileDesc>`);
  lines.push(`  </teiHeader>`);
  lines.push(`  <text><body>`);
  lines.push(`    <div type="apparatus">`);
  for (const unit of store.units.values()) {
    lines.push(`      <app xml:id="${escapeAttr(unit.id)}">`);
    const baseReading = base ? unit.readings.find((r) => r.witnessId === base.id) : undefined;
    if (baseReading) lines.push(`        ${readingXml(store, unit, baseReading, 'lem')}`);
    for (const r of unit.readings) {
      if (baseReading && r.witnessId === baseReading.witnessId) continue;
      lines.push(`        ${readingXml(store, unit, r, 'rdg')}`);
    }
    lines.push(`      </app>`);
  }
  lines.push(`    </div>`);
  lines.push(`  </body></text>`);
  lines.push(`</TEI>`);
  return lines.join('\n') + '\n';
}
