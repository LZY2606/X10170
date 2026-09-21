import { DOMParser, XMLSerializer, DOMImplementation } from '@xmldom/xmldom';
import type { EditEvent, RoundTripDifference, XmlIssue } from './types.js';
import { buildNormalizedView } from './xml.js';

function parse(raw: string): Document {
  return new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: e => { throw new Error(e); },
      fatalError: e => { throw new Error(e); }
    }
  }).parseFromString(raw, 'application/xml');
}

function name(node: Node): string {
  const element = node as Element;
  return element.prefix ? `${element.prefix}:${element.localName}` : (element.localName || element.nodeName);
}

function path(node: Node): string {
  const parts: string[] = [];
  let current: Node | null = node;
  while (current && current.nodeType === 1) {
    parts.unshift(name(current));
    current = current.parentNode;
  }
  return '/' + parts.join('/');
}

function removeApparatus(doc: Document): void {
  Array.from(doc.getElementsByTagName('*')).forEach(node => {
    const local = (node as Element).localName || node.nodeName;
    if (local === 'apparatus') node.parentNode?.removeChild(node);
  });
}

function cloneDoc(doc: Document): Document {
  const target = new DOMImplementation().createDocument(doc.documentElement.namespaceURI, null, null);
  target.appendChild(target.importNode(doc.documentElement, true));
  return target;
}

function directText(node: Node): string {
  let value = '';
  Array.from(node.childNodes).forEach(child => {
    if (child.nodeType === 3 || child.nodeType === 4) value += child.nodeValue || '';
  });
  return value;
}

function attrMap(node: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < node.attributes.length; i += 1) {
    const attr = node.attributes.item(i);
    if (attr) result[`${attr.namespaceURI || ''}|${attr.localName || attr.nodeName}`] = attr.nodeValue || '';
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function elementIdentity(node: Node): string {
  const element = node as Element;
  return `${element.namespaceURI || ''}|${element.localName || node.nodeName}`;
}

function elementChildren(node: Node): Element[] {
  return Array.from(node.childNodes).filter(child => child.nodeType === 1) as Element[];
}

function semanticCompare(expected: Node, actual: Node, basePath = ''): RoundTripDifference | undefined {
  const currentPath = expected.nodeType === 1 ? path(expected) : basePath;
  const expectedText = directText(expected);
  const actualText = directText(actual);
  if (expectedText !== actualText) {
    return {
      id: `loss-text-${currentPath}`,
      classification: 'unacceptable-loss',
      path: currentPath,
      expected: JSON.stringify(expectedText),
      actual: JSON.stringify(actualText),
      explanation: '重新解析后的文本内容不同于原始 XML'
    };
  }
  if (expected.nodeType === 1 && actual.nodeType === 1) {
    const expectedAttrs = attrMap(expected as Element);
    const actualAttrs = attrMap(actual as Element);
    if (JSON.stringify(expectedAttrs) !== JSON.stringify(actualAttrs)) {
      return {
        id: `loss-attr-${currentPath}`,
        classification: 'unacceptable-loss',
        path: currentPath,
        expected: JSON.stringify(expectedAttrs, null, 2),
        actual: JSON.stringify(actualAttrs, null, 2),
        explanation: '重新解析后的属性语义不同于原始 XML'
      };
    }
  }
  if (elementIdentity(expected) !== elementIdentity(actual)) {
    return {
      id: `loss-name-${currentPath}`,
      classification: 'unacceptable-loss',
      path: currentPath,
      expected: name(expected),
      actual: name(actual),
      explanation: '重新解析后的元素名称不同于原始 XML'
    };
  }
  const expectedChildren = elementChildren(expected);
  const actualChildren = elementChildren(actual);
  if (expectedChildren.length !== actualChildren.length) {
    return {
      id: `loss-children-${currentPath}`,
      classification: 'unacceptable-loss',
      path: currentPath,
      expected: `${expectedChildren.length} 个已知子元素`,
      actual: `${actualChildren.length} 个已知子元素`,
      explanation: '重新解析后出现不可接受的已知节点数量变化'
    };
  }
  for (let i = 0; i < expectedChildren.length; i += 1) {
    const mismatch = semanticCompare(expectedChildren[i], actualChildren[i], currentPath);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function entityReferenceCount(raw: string): number {
  const match = raw.match(/&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z_][\w.-]*);/g) || [];
  return match.filter(item => !['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'].includes(item)).length;
}

function lexicalDeclarationDifference(raw: string, serialized: string): boolean {
  const declaration = raw.match(/^<\?xml[^>]*\?>/);
  if (!declaration) return false;
  const serializedDeclaration = serialized.match(/^<\?xml[^>]*\?>/);
  if (!serializedDeclaration) return true;
  const attributes = (value: string) => Array.from(value.matchAll(/(\w[\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)).map(match => `${match[1]}=${match[2] ?? match[3]}`).sort();
  return JSON.stringify(attributes(declaration[0])) !== JSON.stringify(attributes(serializedDeclaration[0]));
}

function rawRootLexicalForm(raw: string): string {
  return raw.replace(/^<\?xml[^>]*\?>/, '').trim();
}

export interface RoundTripInput {
  originals: Array<{ witnessId: string; raw: string }>;
  exportedXml: string;
  exportEventId: string;
  events: EditEvent[];
}

export function classifyRoundTrip(input: RoundTripInput): RoundTripDifference[] {
  const exported = parse(input.exportedXml);
  const apparatus = Array.from(exported.getElementsByTagName('*')).find(node => (node as Element).localName === 'apparatus');
  const findings: RoundTripDifference[] = [];
  const exportedSources = new Map<string, Element>();
  Array.from(exported.getElementsByTagName('source')).forEach(source => {
    exportedSources.set(source.getAttribute('witness') || '', source);
  });

  input.originals.forEach(original => {
    const preflight = buildNormalizedView(original.raw, original.witnessId).issues
      .filter(issue => issue.severity === 'blocker');
    preflight.forEach((issue, index) => findings.push({
      id: `blocked-${original.witnessId}-${index}`,
      classification: 'unacceptable-loss',
      witnessId: original.witnessId,
      path: issue.path,
      expected: issue.qualifiedName,
      actual: '未导出',
      eventId: input.exportEventId,
      explanation: issue.message
    }));

    const exportedSource = exportedSources.get(original.witnessId);
    const expectedDoc = cloneDoc(parse(original.raw));
    if (!exportedSource) {
      findings.push({
        id: `missing-source-${original.witnessId}`,
        classification: 'unacceptable-loss',
        witnessId: original.witnessId,
        path: '/loomExport/sources',
        expected: '完整见证源 XML',
        actual: '导出中缺少该见证 source',
        eventId: input.exportEventId,
        explanation: '导出 XML 重新解析后丢失整个见证'
      });
    } else {
      const actualRoot = elementChildren(exportedSource)[0];
      const serializedActual = new XMLSerializer().serializeToString(actualRoot);
      if (rawRootLexicalForm(original.raw) !== serializedActual) {
      const mismatch = semanticCompare(expectedDoc.documentElement, actualRoot);
      if (mismatch) {
          findings.push({ ...mismatch, witnessId: original.witnessId, path: `/source[@witness="${original.witnessId}"]${mismatch.path}`, eventId: input.exportEventId });
      } else {
        const references = entityReferenceCount(original.raw);
        findings.push({
          id: `lexical-${original.witnessId}`,
          classification: 'lexical-only',
          witnessId: original.witnessId,
          path: `/source[@witness="${original.witnessId}"]`,
          expected: '原始词法（实体、空白或属性书写）',
          actual: '语义等价的规范化 XML 词法',
          eventId: input.exportEventId,
          explanation: references > 0
            ? `检测到 ${references} 处字符/命名实体写法变化；解析后的语义一致`
            : '检测到词法形式变化；解析后的元素、属性和文本语义一致'
        });
      }
    }
      const fullSerialized = new XMLSerializer().serializeToString(exported);
      if (lexicalDeclarationDifference(original.raw, fullSerialized)) {
        findings.push({
          id: `lexical-declaration-${original.witnessId}`,
          classification: 'lexical-only',
          witnessId: original.witnessId,
          path: '/xml-declaration',
          expected: '原始 XML 声明或其他树外词法',
          actual: '重新序列化后的 XML 声明',
          eventId: input.exportEventId,
          explanation: 'XML 声明/standalone 等树外写法变化；重新解析后的语义一致'
        });
      }
    }
  });

  if (apparatus) {
    elementChildren(apparatus).forEach(app => {
      if ((app.localName || app.nodeName) !== 'app') return;
      const eventId = app.getAttribute('sourceEvent') || input.exportEventId;
      const event = input.events.find(item => item.id === eventId);
      findings.push({
        id: `known-${app.getAttribute('xml:id') || Math.random()}`,
        classification: 'known-edit',
        path: path(app),
        expected: '原始见证不含 apparatus',
        actual: directText(app.getElementsByTagName('label')[0] || app),
        eventId,
        explanation: event ? `由编辑事件 ${event.type} 添加的校勘单元` : '由导出的校勘单元添加'
      });
    });
  }
  return findings;
}

export function preflightExport(rawByWitness: Array<{ witnessId: string; raw: string }>): XmlIssue[] {
  return rawByWitness.flatMap(item => buildNormalizedView(item.raw, item.witnessId).issues);
}
