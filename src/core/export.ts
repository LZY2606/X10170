import { parseXml, qname } from './xml.js';
import type { ElementNode, Node } from './types.js';
import type { XmlDocument } from './types.js';
import { normalize, validateRange } from './normalize.js';
import type { ProjectState, Unit } from './model.js';

export const LOOM_NS = 'http://yiwen-zhiji.local/ns/loom';
export const LOOM_PREFIX = 'loom';

export interface ExportBlocker {
  witnessId: string;
  witnessName: string;
  xpath: string;
  offset: number;
  qname: string;
  reason: string;
}

/** 默认可安全映射的元素（TEI/TEI-lite 常见结构） */
export const DEFAULT_ELEMENT_POLICY: Record<string, 'keep' | 'unwrap'> = {
  TEI: 'keep',
  teiHeader: 'keep',
  fileDesc: 'keep',
  titleStmt: 'keep',
  title: 'keep',
  publicationStmt: 'keep',
  p: 'keep',
  ab: 'keep',
  l: 'keep',
  lg: 'keep',
  div: 'keep',
  div1: 'keep',
  div2: 'keep',
  div3: 'keep',
  body: 'keep',
  text: 'keep',
  group: 'keep',
  front: 'keep',
  back: 'keep',
  head: 'keep',
  pb: 'keep',
  milestone: 'keep',
  lb: 'keep',
  cb: 'keep',
  note: 'keep',
  hi: 'keep',
  foreign: 'keep',
  supplied: 'keep',
  unclear: 'keep',
  gap: 'keep',
  sic: 'keep',
  corr: 'keep',
  choice: 'keep',
  orig: 'keep',
  reg: 'keep',
  add: 'keep',
  del: 'keep',
  seg: 'keep',
  list: 'keep',
  item: 'keep',
  sp: 'keep',
  speaker: 'keep',
};

export interface PrecheckResult {
  ok: boolean;
  blockers: ExportBlocker[];
  normalizedUnitCount: number;
}

export function precheck(state: ProjectState): PrecheckResult {
  const blockers: ExportBlocker[] = [];
  for (const witness of state.witnesses) {
    let doc: XmlDocument;
    try {
      doc = parseXml(witness.rawXml);
    } catch (err) {
      const pos = (err as { pos?: number }).pos ?? 0;
      blockers.push({
        witnessId: witness.id,
        witnessName: witness.name,
        xpath: '/',
        offset: pos,
        qname: '#parse-error',
        reason: `原始 XML 无法重新解析：${(err as Error).message}`,
      });
      continue;
    }
    if (doc.doctype) {
      blockers.push({
        witnessId: witness.id,
        witnessName: witness.name,
        xpath: '/',
        offset: doc.doctype.start,
        qname: '!DOCTYPE',
        reason: 'DOCTYPE/内部 DTD 无法安全迁移到合并文档，请移除 DTD 或内联实体后再导出',
      });
    }
    traverse(doc.root, '', (el, xpath) => {
      const name = qname(el);
      const policy = state.elementPolicy[name] ?? DEFAULT_ELEMENT_POLICY[name];
      if (!policy) {
        blockers.push({
          witnessId: witness.id,
          witnessName: witness.name,
          xpath,
          offset: el.start,
          qname: name,
          reason: `未知元素 <${name}> 没有安全映射策略：无法保证导出不丢失语义，已阻止导出`,
        });
      }
    });
    const view = normalize(doc);
    for (const unit of state.units) {
      for (const anchor of unit.anchors.filter((a) => a.witnessId === witness.id)) {
        const err = validateRange(view, anchor.start, anchor.end);
        if (err) {
          blockers.push({
            witnessId: witness.id,
            witnessName: witness.name,
            xpath: `@anchor[${anchor.start},${anchor.end})`,
            offset: anchor.start,
            qname: '#anchor',
            reason: `单元「${unit.title}」(${unit.id}) 的锚点非法：${err}`,
          });
        }
      }
    }
  }
  return { ok: blockers.length === 0, blockers, normalizedUnitCount: state.units.length };
}

function traverse(el: ElementNode, path: string, visit: (el: ElementNode, xpath: string) => void): void {
  const tag = qname(el);
  const xpath = `${path}/${tag}`;
  visit(el, xpath);
  let sameName = 0;
  for (const child of el.children) {
    if (child.kind === 'element') {
      traverse(child, `${xpath}[${sameName + 1}]`, visit);
      if (qname(child) === tag) sameName += 1;
    }
  }
}

export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function emitAttributes(el: ElementNode): string {
  const all = [...el.nsDecls, ...el.attributes];
  return all
    .map((attr) => ` ${qname(attr)}=${attr.quote}${attr.rawValue}${attr.quote}`)
    .join('');
}

function emitElement(el: ElementNode, source: string): string {
  const tag = qname(el);
  const rawAttrs = emitAttributes(el);
  if (el.selfClosing) {
    return `<${tag}${rawAttrs}/>`;
  }
  const inner = el.children.map((child) => emitNode(child, source)).join('');
  return `<${tag}${rawAttrs}>${inner}</${tag}>`;
}

function emitNode(node: Node, source: string): string {
  if (node.kind === 'element') return emitElement(node, source);
  if (node.kind === 'text') return source.slice(node.start, node.end);
  return source.slice(node.start, node.end);
}

export interface ExportResult {
  xml: string;
  witnessCount: number;
  unitCount: number;
}

export function buildExport(state: ProjectState): ExportResult {
  const check = precheck(state);
  if (!check.ok) {
    throw new Error(
      `导出被 ${check.blockers.length} 个未知/不安全结构阻止：\n` +
        check.blockers.map((b) => ` - ${b.witnessName} ${b.xpath} @${b.offset}: ${b.reason}`).join('\n'),
    );
  }
  const docs = state.witnesses.map((w) => ({ witness: w, doc: parseXml(w.rawXml) }));
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<${LOOM_PREFIX}:corpus xmlns:${LOOM_PREFIX}="${LOOM_NS}">`);
  for (const { witness, doc } of docs) {
    lines.push(`  <${LOOM_PREFIX}:witness ${LOOM_PREFIX}:id="${escapeAttr(witness.id)}" ${LOOM_PREFIX}:name="${escapeAttr(witness.name)}" ${LOOM_PREFIX}:sha256="${witness.sha256}">`);
    lines.push(`    ${emitElement(doc.root, doc.source)}`);
    lines.push(`  </${LOOM_PREFIX}:witness>`);
  }
  lines.push(`  <${LOOM_PREFIX}:apparatus>`);
  for (const unit of state.units) {
    lines.push(emitApparatusUnit(unit));
  }
  lines.push(`  </${LOOM_PREFIX}:apparatus>`);
  lines.push(`</${LOOM_PREFIX}:corpus>`);
  return { xml: lines.join('\n') + '\n', witnessCount: docs.length, unitCount: state.units.length };
}

function emitApparatusUnit(unit: Unit): string {
  const parts: string[] = [];
  parts.push(`    <${LOOM_PREFIX}:unit ${LOOM_PREFIX}:id="${escapeAttr(unit.id)}" ${LOOM_PREFIX}:title="${escapeAttr(unit.title)}">`);
  for (const anchor of unit.anchors) {
    parts.push(
      `      <${LOOM_PREFIX}:anchor ${LOOM_PREFIX}:witness="${escapeAttr(anchor.witnessId)}" ${LOOM_PREFIX}:start="${anchor.start}" ${LOOM_PREFIX}:end="${anchor.end}"${anchor.label ? ` ${LOOM_PREFIX}:label="${escapeAttr(anchor.label)}"` : ''}/>`,
    );
  }
  for (const reading of unit.readings) {
    const frags = reading.fragments
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((f) => `${f.start},${f.end}`)
      .join(' ');
    parts.push(
      `      <${LOOM_PREFIX}:rdg ${LOOM_PREFIX}:witness="${escapeAttr(reading.witnessId)}" ${LOOM_PREFIX}:type="${reading.type}" ${LOOM_PREFIX}:fragments="${escapeAttr(frags)}">${escapeText(reading.note)}</${LOOM_PREFIX}:rdg>`,
    );
  }
  parts.push(`    </${LOOM_PREFIX}:unit>`);
  return parts.join('\n');
}
