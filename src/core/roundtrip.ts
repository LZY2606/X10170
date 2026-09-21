import { parseXml, qname, attrValue } from './xml.js';
import type { AttributeNode, ElementNode, Node, TextNode } from './types.js';
import type { XmlDocument } from './types.js';
import { LOOM_NS } from './export.js';
import type { ProjectState } from './model.js';

export type DiffClass = 'known-edit' | 'lexical' | 'unacceptable-loss';

export interface SemanticDiff {
  classification: DiffClass;
  witnessId: string;
  witnessName: string;
  path: string;
  kind: 'element-added' | 'element-removed' | 'text-changed' | 'attribute-added'
      | 'attribute-removed' | 'attribute-value' | 'comment-removed' | 'pi-removed'
      | 'cdata-changed' | 'entity-changed' | 'apparatus-added';
  originalSnippet: string;
  exportedSnippet: string;
  sourceOffset: number;
  eventIds: string[];
  explanation: string;
}

export interface RoundtripReport {
  ok: boolean;
  diffs: SemanticDiff[];
  counts: Record<DiffClass, number>;
  reparseError: string | null;
}

function isLoomElement(doc: XmlDocument, el: ElementNode, local: string): boolean {
  const uri = nsUriOfPrefix(doc, el.prefix);
  return el.local === local && uri === LOOM_NS;
}

function nsUriOfPrefix(doc: XmlDocument, prefix: string | null): string | null {
  if (!prefix) return findDefaultNs(doc.root) ?? null;
  const found = findPrefixNs(doc.root, prefix);
  return found ?? null;
}

function findDefaultNs(el: ElementNode): string | null {
  const decl = el.nsDecls.find((a) => a.local === 'xmlns' && a.prefix === null);
  if (decl) return attrValue(decl);
  for (const child of el.children) if (child.kind === 'element') return findDefaultNs(child);
  return null;
}

function findPrefixNs(el: ElementNode, prefix: string): string | null {
  const decl = el.nsDecls.find((a) => a.local === prefix);
  if (decl) return attrValue(decl);
  for (const child of el.children) if (child.kind === 'element') {
    const hit = findPrefixNs(child, prefix);
    if (hit) return hit;
  }
  return null;
}

function attrKey(doc: XmlDocument, attr: AttributeNode): string {
  const uri = nsUriOfPrefix(doc, attr.prefix);
  return `${uri ?? ''}#${attr.local}`;
}

function textOf(node: Node): string {
  if (node.kind === 'text') return node.value;
  if (node.kind === 'cdata') return node.text;
  if (node.kind === 'element') return node.children.map(textOf).join('');
  return '';
}

function attrMap(doc: XmlDocument, el: ElementNode): Map<string, AttributeNode> {
  const map = new Map<string, AttributeNode>();
  for (const attr of el.attributes) map.set(attrKey(doc, attr), attr);
  return map;
}

function nodeKindKey(node: Node): string {
  switch (node.kind) {
    case 'element': return `el:${qname(node)}`;
    case 'text': return 'text';
    case 'comment': return 'comment';
    case 'pi': return `pi:${node.target}`;
    case 'cdata': return 'cdata';
    default: return node.kind;
  }
}

function sameSemantics(a: Node, b: Node): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') return a.value === b.value;
  if (a.kind === 'cdata' && b.kind === 'cdata') return a.text === b.text;
  if (a.kind === 'comment' && b.kind === 'comment') return a.text === b.text;
  if (a.kind === 'pi' && b.kind === 'pi') return a.target === b.target && a.body === b.body;
  return false;
}

function compareAttributes(
  origDoc: XmlDocument,
  newDoc: XmlDocument,
  orig: ElementNode,
  now: ElementNode,
  path: string,
  witnessId: string,
  witnessName: string,
): SemanticDiff[] {
  const diffs: SemanticDiff[] = [];
  const oMap = attrMap(origDoc, orig);
  const nMap = attrMap(newDoc, now);
  for (const [key, oa] of oMap) {
    const na = nMap.get(key);
    if (!na) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind: 'attribute-removed',
        originalSnippet: `${qname(oa)}=${oa.quote}${oa.rawValue}${oa.quote}`,
        exportedSnippet: '',
        sourceOffset: oa.start,
        eventIds: [],
        explanation: `属性 ${qname(oa)} 在导出后消失`,
      });
    } else if (attrValue(oa) !== attrValue(na)) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind: 'attribute-value',
        originalSnippet: attrValue(oa),
        exportedSnippet: attrValue(na),
        sourceOffset: oa.start,
        eventIds: [],
        explanation: `属性 ${qname(oa)} 的值被改动`,
      });
    } else if (oa.rawValue !== na.rawValue) {
      diffs.push({
        classification: 'lexical',
        witnessId, witnessName, path,
        kind: 'entity-changed',
        originalSnippet: oa.rawValue,
        exportedSnippet: na.rawValue,
        sourceOffset: oa.start,
        eventIds: [],
        explanation: `属性 ${qname(oa)} 语义相同，仅实体写法不同（词法变化）`,
      });
    }
  }
  for (const [key, na] of nMap) {
    if (!oMap.has(key)) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind: 'attribute-added',
        originalSnippet: '',
        exportedSnippet: `${qname(na)}="${attrValue(na)}"`,
        sourceOffset: na.start,
        eventIds: [],
        explanation: `导出后多出属性 ${qname(na)}`,
      });
    }
  }
  return diffs;
}

function lcsAlign(orig: Node[], now: Node[]): Array<{ o: Node | null; n: Node | null }> {
  const m = orig.length;
  const k = now.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] =
        nodeKindKey(orig[i]) === nodeKindKey(now[j])
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<{ o: Node | null; n: Node | null }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < k) {
    if (nodeKindKey(orig[i]) === nodeKindKey(now[j])) {
      pairs.push({ o: orig[i], n: now[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push({ o: orig[i], n: null });
      i++;
    } else {
      pairs.push({ o: null, n: now[j] });
      j++;
    }
  }
  while (i < m) pairs.push({ o: orig[i++], n: null });
  while (j < k) pairs.push({ o: null, n: now[j++] });
  return pairs;
}

function snippet(doc: XmlDocument, node: Node, len = 60): string {
  const raw = doc.source.slice(node.start, node.end);
  return raw.length > len ? `${raw.slice(0, len)}…` : raw;
}

function compareChildren(
  origDoc: XmlDocument,
  newDoc: XmlDocument,
  origChildren: Node[],
  newChildren: Node[],
  path: string,
  witnessId: string,
  witnessName: string,
): SemanticDiff[] {
  const diffs: SemanticDiff[] = [];
  for (const pair of lcsAlign(origChildren, newChildren)) {
    const { o, n } = pair;
    if (o && !n) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind: o.kind === 'element' ? 'element-removed'
          : o.kind === 'comment' ? 'comment-removed'
          : o.kind === 'pi' ? 'pi-removed'
          : 'text-changed',
        originalSnippet: snippet(origDoc, o),
        exportedSnippet: '',
        sourceOffset: o.start,
        eventIds: [],
        explanation:
          o.kind === 'element'
            ? `元素 <${qname(o as ElementNode)}> 在导出后丢失`
            : `原始 ${o.kind} 节点在导出后丢失`,
      });
      continue;
    }
    if (!o && n) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind: n.kind === 'element' ? 'element-added' : 'text-changed',
        originalSnippet: '',
        exportedSnippet: snippet(newDoc, n),
        sourceOffset: n.start,
        eventIds: [],
        explanation:
          n.kind === 'element'
            ? `导出后多出元素 <${qname(n as ElementNode)}>`
            : `导出后多出 ${n.kind} 内容`,
      });
      continue;
    }
    if (!o || !n) continue;
    if (o.kind === 'element' && n.kind === 'element') {
      const childPath = `${path}/${qname(o)}`;
      diffs.push(...compareAttributes(origDoc, newDoc, o, n, childPath, witnessId, witnessName));
      diffs.push(...compareChildren(origDoc, newDoc, o.children, n.children, childPath, witnessId, witnessName));
    } else if (!sameSemantics(o, n)) {
      const kind: SemanticDiff['kind'] =
        o.kind === 'cdata' || n.kind === 'cdata' ? 'cdata-changed' : 'text-changed';
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId, witnessName, path,
        kind,
        originalSnippet: textOf(o),
        exportedSnippet: textOf(n),
        sourceOffset: o.start,
        eventIds: [],
        explanation: '文本内容发生了没有编辑记录支撑的改变',
      });
    } else if (o.kind === 'text' && n.kind === 'text' && hasOnlyEntityLexDiff(o, n)) {
      diffs.push({
        classification: 'lexical',
        witnessId, witnessName, path,
        kind: 'entity-changed',
        originalSnippet: origDoc.source.slice(o.start, o.end),
        exportedSnippet: newDoc.source.slice(n.start, n.end),
        sourceOffset: o.start,
        eventIds: [],
        explanation: '文本语义相同，仅实体引用写法不同（词法变化）',
      });
    }
  }
  return diffs;
}

function hasOnlyEntityLexDiff(a: TextNode, b: TextNode): boolean {
  return a.value === b.value &&
    a.entities.map((e) => e.raw).join('') !== b.entities.map((e) => e.raw).join('');
}

function findWitnessElements(corpus: ElementNode, doc: XmlDocument): ElementNode[] {
  const out: ElementNode[] = [];
  for (const child of corpus.children) {
    if (child.kind === 'element' && isLoomElement(doc, child, 'witness')) out.push(child);
  }
  return out;
}

function findApparatus(corpus: ElementNode, doc: XmlDocument): ElementNode | null {
  for (const child of corpus.children) {
    if (child.kind === 'element' && isLoomElement(doc, child, 'apparatus')) return child;
  }
  return null;
}

function linkEvents(diffs: SemanticDiff[], state: ProjectState): SemanticDiff[] {
  return diffs.map((diff) => {
    if (diff.classification === 'unacceptable-loss') return { ...diff, eventIds: [] };
    if (diff.classification === 'lexical') {
      return { ...diff, eventIds: state.events.filter((e) => e.kind === 'witness.import').map((e) => e.id) };
    }
    return diff;
  });
}

export function runRoundtrip(state: ProjectState, exportedXml: string): RoundtripReport {
  const counts: Record<DiffClass, number> = {
    'known-edit': 0,
    lexical: 0,
    'unacceptable-loss': 0,
  };
  let reparseError: string | null = null;
  let exported: XmlDocument;
  try {
    exported = parseXml(exportedXml);
  } catch (err) {
    return {
      ok: false,
      diffs: [],
      counts,
      reparseError: `导出 XML 无法重新解析：${(err as Error).message}`,
    };
  }
  const witnessEls = findWitnessElements(exported.root, exported);
  const diffs: SemanticDiff[] = [];
  for (const witness of state.witnesses) {
    const original = parseXml(witness.rawXml);
    const match = witnessEls.find((el) => {
      const idAttr = el.attributes.find((a) => a.local === 'id' && nsUriOfPrefix(exported, a.prefix) === LOOM_NS);
      return idAttr && attrValue(idAttr) === witness.id;
    });
    if (!match) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId: witness.id,
        witnessName: witness.name,
        path: '/',
        kind: 'element-removed',
        originalSnippet: qname(original.root),
        exportedSnippet: '',
        sourceOffset: 0,
        eventIds: [],
        explanation: '导出文档中找不到该见证',
      });
      continue;
    }
    const exportedWitnessRoot = match.children.find((c): c is ElementNode => c.kind === 'element');
    if (!exportedWitnessRoot) {
      diffs.push({
        classification: 'unacceptable-loss',
        witnessId: witness.id,
        witnessName: witness.name,
        path: '/',
        kind: 'element-removed',
        originalSnippet: '',
        exportedSnippet: '',
        sourceOffset: 0,
        eventIds: [],
        explanation: '导出的见证缺少根元素',
      });
      continue;
    }
    diffs.push(
      ...compareChildren(
        original,
        exported,
        [original.root],
        [exportedWitnessRoot],
        '',
        witness.id,
        witness.name,
      ),
    );
  }
  const apparatus = findApparatus(exported.root, exported);
  if (apparatus && state.units.length > 0) {
    diffs.push({
      classification: 'known-edit',
      witnessId: '',
      witnessName: '(apparatus)',
      path: '/loom:apparatus',
      kind: 'apparatus-added',
      originalSnippet: '',
      exportedSnippet: `${state.units.length} 个校勘单元`,
      sourceOffset: apparatus.start,
      eventIds: state.events
        .filter((e) => e.kind.startsWith('unit.') || e.kind === 'anchor.revise')
        .map((e) => e.id),
      explanation: 'apparatus 是已知编辑操作的派生产物，属于已知编辑',
    });
  }
  const linked = linkEvents(diffs, state);
  for (const diff of linked) counts[diff.classification] += 1;
  reparseError = null;
  return {
    ok: counts['unacceptable-loss'] === 0 && reparseError === null,
    diffs: linked,
    counts,
    reparseError,
  };
}
