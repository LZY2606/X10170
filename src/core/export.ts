import { ProjectStore } from './store';
import { lineCol, localName, parseXml, walkElements, XmlNode } from './xml';
import { Reading } from './model';

/** 可安全映射到 TEI 导出的元素白名单（按本地名匹配，命名空间前缀不影响） */
const KNOWN_ELEMENTS = new Set([
  'tei', 'teiheader', 'filedesc', 'titlestmt', 'title', 'publicationstmt', 'sourcedesc',
  'encodingdesc', 'revisiondesc', 'change', 'listwit', 'witness',
  'text', 'front', 'body', 'back', 'div', 'head', 'p', 'pb', 'lb', 'ab', 'seg',
  'hi', 'note', 'sp', 'speaker', 'stage', 'app', 'lem', 'rdg', 'listapp',
]);

export interface ExportIssue {
  kind: 'unknown-element' | 'unknown-entity' | 'doctype' | 'no-witness' | 'unit-without-range';
  message: string;
  witnessId?: string;
  location?: string;
}

function walkNodes(nodes: XmlNode[], fn: (n: XmlNode) => void): void {
  for (const n of nodes) {
    fn(n);
    if (n.kind === 'element') walkNodes(n.children, fn);
  }
}

/** 导出预检：任何无法安全映射的未知结构都会阻止导出并给出定位 */
export function preflight(store: ProjectStore): ExportIssue[] {
  const issues: ExportIssue[] = [];
  if (!store.data.witnesses.length) {
    issues.push({ kind: 'no-witness', message: '尚未导入任何见证' });
    return issues;
  }
  for (const w of store.data.witnesses) {
    const { nodes } = parseXml(w.rawXml);
    for (const el of walkElements(nodes)) {
      if (!KNOWN_ELEMENTS.has(localName(el.name).toLowerCase())) {
        issues.push({
          kind: 'unknown-element',
          message: `未知元素 <${el.name}> 无法安全映射到导出结构`,
          witnessId: w.id,
          location: lineCol(w.rawXml, el.start),
        });
      }
    }
    walkNodes(nodes, (n) => {
      if (n.kind === 'doctype') {
        issues.push({
          kind: 'doctype',
          message: '文档类型声明无法安全映射',
          witnessId: w.id,
          location: lineCol(w.rawXml, n.start),
        });
      }
    });
    const derived = store.derivedOf(w.id);
    for (const e of derived.entityIssues) {
      issues.push({
        kind: 'unknown-entity',
        message: `未知实体引用 ${e.raw}，无法确认其语义`,
        witnessId: w.id,
        location: lineCol(w.rawXml, e.offset),
      });
    }
  }
  for (const u of store.data.units) {
    if (!u.readings.some((r) => r.range)) {
      issues.push({ kind: 'unit-without-range', message: `单元「${u.label}」没有任何带区间的读法` });
    }
  }
  return issues;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rdgXml(store: ProjectStore, r: Reading): string {
  const wit = `#${r.witnessId}`;
  if (r.type === 'omission') return `<rdg wit="${wit}" type="omission"/>`;
  if (r.type === 'transposition' && r.parts?.length) {
    const segs = r.parts
      .map((p, i) => `<seg n="${i + 1}">${escapeXml(store.fragment(r.witnessId, p))}</seg>`)
      .join('');
    return `<rdg wit="${wit}" type="transposition">${segs}</rdg>`;
  }
  const text = r.range ? escapeXml(store.fragment(r.witnessId, r.range)) : '';
  const note = r.note ? `<note>${escapeXml(r.note)}</note>` : '';
  const type = r.type === 'editorial' ? ' type="editorial"' : '';
  return `<rdg wit="${wit}"${type}>${text}${note}</rdg>`;
}

export type ExportResult = { ok: true; xml: string } | { ok: false; issues: ExportIssue[] };

/** 生成带 apparatus 的 TEI XML；预检失败时拒绝导出而不是静默丢弃 */
export function exportApparatus(store: ProjectStore): ExportResult {
  const issues = preflight(store);
  if (issues.length) return { ok: false, issues };

  const witnesses = store.data.witnesses;
  const base = witnesses[0];
  const baseText = store.derivedOf(base.id).text;

  const witList = witnesses
    .map((w) => `<witness xml:id="${w.id}">${escapeXml(w.name)}</witness>`)
    .join('');

  const apps = store.data.units
    .map((u) => {
      const baseReading = u.readings.find((r) => r.witnessId === base.id && r.range);
      const anchorRange = baseReading?.range ?? u.readings.find((r) => r.range)!.range!;
      const lemText = baseReading
        ? escapeXml(store.fragment(base.id, baseReading.range!))
        : '';
      const lem = baseReading ? `<lem>${lemText}</lem>` : '<lem/>';
      const rdgs = u.readings
        .filter((r) => r !== baseReading)
        .map((r) => rdgXml(store, r))
        .join('');
      return `<app xml:id="${u.id}" from="${anchorRange.start}" to="${anchorRange.end}">${lem}${rdgs}</app>`;
    })
    .join('');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<TEI xmlns="http://www.tei-c.org/ns/1.0">` +
    `<teiHeader><fileDesc><titleStmt><title>异文织机导出</title></titleStmt>` +
    `<sourceDesc><listWit>${witList}</listWit></sourceDesc></fileDesc></teiHeader>` +
    `<text><body>` +
    `<p n="base">${escapeXml(baseText)}</p>` +
    `<listApp>${apps}</listApp>` +
    `</body></text></TEI>`;
  return { ok: true, xml };
}
