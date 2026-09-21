import { DOMParser, XMLSerializer, DOMImplementation } from '@xmldom/xmldom';
import type { NormalizedView, RoundTripDifference, TextRange, TextSegment, XmlIssue } from './types.js';
import type { CollationUnit, EditEvent } from './types.js';

const KNOWN_WITNESS_NODES = new Set([
  'tei:TEI', 'tei:teiHeader', 'tei:fileDesc', 'tei:titleStmt', 'tei:title',
  'tei:publicationStmt', 'tei:p', 'tei:sourceDesc', 'tei:text', 'tei:body',
  'tei:pb', 'tei:lb', 'tei:note', 'TEI', 'teiHeader', 'fileDesc', 'titleStmt',
  'title', 'publicationStmt', 'p', 'sourceDesc', 'text', 'body', 'pb', 'lb', 'note'
]);

function qName(node: Node): string {
  const element = node as Element;
  if (element.prefix) return `${element.prefix}:${element.localName}`;
  return element.localName || element.nodeName;
}

function nodePath(node: Node): string {
  const parts: string[] = [];
  let current: Node | null = node;
  while (current && current.nodeType === 1) {
    const parent: Node | null = current.parentNode;
    const name = qName(current);
    let index = 1;
    if (parent) {
      const siblings = Array.from(parent.childNodes).filter(
        (child: Node) => child.nodeType === 1 && qName(child) === name
      );
      index = siblings.findIndex(child => child === current) + 1;
    }
    parts.unshift(`${name}[${index}]`);
    current = parent;
  }
  return '/' + parts.join('/');
}

export function parseXml(raw: string, witnessId?: string): Document {
  const errors: string[] = [];
  const parser = new DOMParser({
    locator: {},
    errorHandler: {
      warning: message => errors.push(message),
      error: message => errors.push(message),
      fatalError: message => errors.push(message)
    }
  });
  const doc = parser.parseFromString(raw, 'application/xml');
  if (errors.length || doc.getElementsByTagName('parsererror').length) {
    const message = errors[0] || 'XML 无法解析';
    const error = new Error(message) as Error & { witnessId?: string };
    error.witnessId = witnessId;
    throw error;
  }
  return doc;
}

export function elementRangeContains(outer: TextRange, inner: TextRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end &&
    !(outer.start === inner.start && outer.end === inner.end);
}

export function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function walkContent(node: Node, visitor: (node: Node) => void): void {
  if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 7) visitor(node);
  Array.from(node.childNodes).forEach(child => walkContent(child, visitor));
}

export function buildNormalizedView(raw: string, witnessId?: string): NormalizedView {
  const doc = parseXml(raw, witnessId);
  const issues: XmlIssue[] = [];
  const segments: TextSegment[] = [];
  let text = '';
  const structures: NormalizedView['structures'] = [];

  const elementStarts = new Map<Element, number>();
  const process = (node: Node) => {
    if (node.nodeType === 1) {
      const element = node as Element;
      const name = qName(element);
      const known = KNOWN_WITNESS_NODES.has(name);
      const start = codepointLength(text);
      elementStarts.set(element, start);
      Array.from(node.childNodes).forEach(process);
      const end = codepointLength(text);
      structures.push({
        path: nodePath(element), qualifiedName: name, localName: element.localName || name,
        start, end, known
      });
      if (!known) {
        issues.push({
          witnessId, path: nodePath(element), qualifiedName: name,
          localName: element.localName || name,
          message: '未知元素没有安全的 apparatus 映射，导出前必须人工处理',
          severity: 'blocker'
        });
      }
    } else if (node.nodeType === 3 || node.nodeType === 4) {
      const value = node.nodeValue || '';
      const start = codepointLength(text);
      text += value;
      const end = codepointLength(text);
      segments.push({ text: value, start, end, path: nodePath(node.parentNode || node), kind: 'text' });
    } else if (node.nodeType === 7) {
      const value = node.nodeValue || '';
      const start = codepointLength(text);
      text += value;
      segments.push({
        text: value, start, end: codepointLength(text),
        path: nodePath(node.parentNode || node), kind: 'text'
      });
    } else {
      Array.from(node.childNodes).forEach(process);
    }
  };
  process(doc.documentElement);
  return { text, codePointLength: codepointLength(text), segments, structures, issues };
}

export function codepointLength(value: string): number {
  return Array.from(value).length;
}

export function codepointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}

export function validateRange(range: TextRange, length: number): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error('锚点端点必须是整数码位偏移');
  }
  if (range.start < 0 || range.end > length) throw new Error('锚点超出见证文本范围');
  if (range.start >= range.end) throw new Error('锚点必须至少选择一个字符');
}

export function snippetFor(view: NormalizedView, range: TextRange): string {
  return JSON.stringify(codepointSlice(view.text, range.start, range.end));
}

export function detectAnchors(view: NormalizedView, witnessId: string) {
  return view.structures
    .filter(item => item.known && (item.localName === 'pb' || (item.localName === 'p' && item.end > item.start)))
    .map((item, index) => ({
      key: `${item.localName}:${index}`,
      kind: item.localName === 'pb' ? 'page' as const : 'paragraph' as const,
      range: { start: item.start, end: item.end },
      witnessId,
      label: `${item.localName === 'pb' ? '页' : '段'} ${index + 1}`,
      path: item.path
    }));
}

function cloneDocument(doc: Document): Document {
  const impl = new DOMImplementation();
  const target = impl.createDocument(doc.documentElement.namespaceURI, null, null);
  const clone = target.importNode(doc.documentElement, true);
  target.appendChild(clone);
  return target;
}

function createElement(doc: Document, name: string, attrs: Record<string, string> = {}): Element {
  const element = doc.createElement(name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

export interface ExportInput {
  witnesses: Array<{ id: string; name: string; raw: string }>;
  units: CollationUnit[];
  anchorRanges: (anchorId: string, witnessId: string) => TextRange | undefined;
  eventIdForUnit: (unitId: string) => string | undefined;
  exportEventId: string;
}

export function exportApparatus(input: ExportInput): { xml?: string; issues: XmlIssue[] } {
  const views = input.witnesses.map(witness => ({ witness, view: buildNormalizedView(witness.raw, witness.id) }));
  const issues = views.flatMap(item => item.view.issues);
  if (issues.some(issue => issue.severity === 'blocker')) return { issues };

  if (!views.length) return { issues: [{ path: '/', qualifiedName: '', localName: '', message: '没有可导出的见证', severity: 'blocker' }] };
  const impl = new DOMImplementation();
  const doc = impl.createDocument(null, 'loomExport', null);
  const root = doc.documentElement;
  root.setAttribute('sourceEvent', input.exportEventId);
  const sources = createElement(doc, 'sources');
  views.forEach(({ witness }) => {
    const source = createElement(doc, 'source', { witness: witness.id, name: witness.name });
    const sourceDoc = cloneDocument(parseXml(witness.raw, witness.id));
    source.appendChild(doc.importNode(sourceDoc.documentElement, true));
    sources.appendChild(source);
  });
  root.appendChild(sources);
  const apparatus = createElement(doc, 'apparatus', { 'xml:id': `loom-app-${input.exportEventId}`, sourceEvent: input.exportEventId });

  input.units.forEach(unit => {
    const unitEventId = input.eventIdForUnit(unit.id) || input.exportEventId;
    const app = createElement(doc, 'app', { 'xml:id': unit.id, sourceEvent: unitEventId });
    app.appendChild(createElement(doc, 'label')).appendChild(doc.createTextNode(unit.label));
    Object.entries(unit.readings).forEach(([witnessId, reading]) => {
      const range = input.anchorRanges(reading.anchorId, witnessId);
      if (!range) return;
      const rdgAttrs: Record<string, string> = {
        witness: witnessId,
        type: reading.status,
        anchor: reading.anchorId,
        start: String(range.start),
        end: String(range.end),
        sourceEvent: unitEventId
      };
      const rdg = createElement(doc, 'rdg', rdgAttrs);
      rdg.appendChild(doc.createTextNode(reading.text));
      if (reading.fragments?.length) {
        reading.fragments.forEach((fragment, index) => {
          const seg = createElement(doc, 'seg', {
            order: String(fragment.order),
            reversed: fragment.reversed ? 'true' : 'false',
            fragmentEvent: unitEventId
          });
          seg.appendChild(doc.createTextNode(fragment.text));
          rdg.appendChild(seg);
          if (index === 0 && fragment.text !== reading.text) {
            // metadata carried in seg; no content is inferred here
          }
        });
      }
      if (reading.judgment) {
        const note = createElement(doc, 'note', { type: 'editorial-judgment' });
        note.appendChild(doc.createTextNode(reading.judgment));
        rdg.appendChild(note);
      }
      app.appendChild(rdg);
    });
    apparatus.appendChild(app);
  });
  root.appendChild(apparatus);
  return { xml: new XMLSerializer().serializeToString(doc), issues };
}
