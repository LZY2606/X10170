import { ProjectStore } from './store';
import { localName, parseXml, XmlNode } from './xml';
import { deriveText } from './text';
import { Reading } from './model';

export type DiffKind = 'known-edit' | 'lexical-only' | 'unacceptable-loss';

export interface RoundTripDiff {
  kind: DiffKind;
  description: string;
  location?: string;
  /** 已知编辑可追溯到的事件 id */
  eventId?: string;
  unitId?: string;
}

function findAll(nodes: XmlNode[], pred: (n: XmlNode) => boolean, out: XmlNode[] = []): XmlNode[] {
  for (const n of nodes) {
    if (pred(n)) out.push(n);
    if (n.kind === 'element') findAll(n.children, pred, out);
  }
  return out;
}

function el(name: string) {
  return (n: XmlNode) => n.kind === 'element' && localName(n.name).toLowerCase() === name;
}

function derivedOfEl(node: XmlNode): string {
  if (node.kind !== 'element') return '';
  return deriveText(node.children).text;
}

function canonical(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ');
}

/**
 * 往返核验：重新解析导出 XML，与项目内原始见证对比。
 * 差异分三类：已知编辑（可追溯到编辑事件）、仅词法变化、不可接受丢失。
 */
export function roundtripDiffs(store: ProjectStore, exportedXml: string): RoundTripDiff[] {
  const diffs: RoundTripDiff[] = [];
  const { nodes, issues } = parseXml(exportedXml);
  if (issues.length) {
    diffs.push({ kind: 'unacceptable-loss', description: `导出 XML 无法解析: ${issues[0].message}` });
    return diffs;
  }
  const base = store.data.witnesses[0];
  if (!base) return diffs;
  const baseText = store.derivedOf(base.id).text;

  // 1. 底本文本核对
  const pEls = findAll(nodes, el('p')) as Extract<XmlNode, { kind: 'element' }>[];
  const baseP = pEls.find((p) => p.attrs.some((a) => a.name === 'n' && a.value === 'base'));
  if (!baseP) {
    diffs.push({ kind: 'unacceptable-loss', description: '导出结果中找不到底本段落 <p n="base">' });
  } else {
    const exportedBase = derivedOfEl(baseP);
    if (exportedBase !== baseText) {
      if (canonical(exportedBase) === canonical(baseText)) {
        diffs.push({
          kind: 'lexical-only',
          description: '底本文本仅存在词法层差异（空白或实体写法），语义一致',
        });
      } else {
        let k = 0;
        while (k < Math.min(exportedBase.length, baseText.length) && exportedBase[k] === baseText[k]) k++;
        diffs.push({
          kind: 'unacceptable-loss',
          description: `底本文本在偏移 ${k} 处发生无法解释的丢失：原文「${baseText.slice(k, k + 12)}…」导出「${exportedBase.slice(k, k + 12)}…」`,
          location: `底本偏移 ${k}`,
        });
      }
    } else {
      // 语义一致；检查原始写法是否仅为词法差异（实体/转义形式）
      const origRawText = collectRawText(base.rawXml);
      const exportedRawText = collectRawTextFromNodes(baseP.children);
      if (origRawText !== exportedRawText) {
        diffs.push({
          kind: 'lexical-only',
          description: '实体写法或转义形式不同（如 &amp; 与 &#38;），解码后语义一致',
        });
      }
    }
  }

  // 2. 逐单元核对读法
  const appEls = findAll(nodes, el('app')) as Extract<XmlNode, { kind: 'element' }>[];
  for (const app of appEls) {
    const unitId = app.attrs.find((a) => a.name === 'xml:id')?.value;
    const unit = store.data.units.find((u) => u.id === unitId);
    if (!unit) {
      diffs.push({ kind: 'unacceptable-loss', description: `导出包含未知单元 ${unitId}` });
      continue;
    }
    const rdgs = findAll(app.children, el('rdg')) as Extract<XmlNode, { kind: 'element' }>[];
    for (const rdg of rdgs) {
      const wit = rdg.attrs.find((a) => a.name === 'wit')?.value?.replace(/^#/, '');
      const reading = unit.readings.find((r) => r.witnessId === wit);
      if (!reading) {
        diffs.push({
          kind: 'unacceptable-loss',
          description: `单元「${unit.label}」中见证 ${wit} 的读法无法对应`,
          unitId: unit.id,
        });
        continue;
      }
      checkReading(store, unit.id, unit.label, reading, rdg, diffs);
    }
  }
  return diffs;
}

function checkReading(
  store: ProjectStore,
  unitId: string,
  label: string,
  reading: Reading,
  rdg: Extract<XmlNode, { kind: 'element' }>,
  diffs: RoundTripDiff[],
): void {
  let actual: string;
  if (reading.type === 'transposition') {
    const segs = findAll(rdg.children, el('seg')) as Extract<XmlNode, { kind: 'element' }>[];
    actual = segs.map((s) => derivedOfEl(s)).join('');
  } else if (reading.type === 'omission') {
    actual = '';
  } else {
    const noteTexts = findAll(rdg.children, el('note')).map(() => '');
    void noteTexts;
    actual = deriveText(rdg.children.filter((c) => !(c.kind === 'element' && localName(c.name) === 'note'))).text;
  }
  const expected = reading.type === 'omission' ? '' : store.readingFragment(reading);
  const ev = store.data.events.find((e) => e.unitId === unitId);
  if (actual !== expected) {
    diffs.push({
      kind: 'unacceptable-loss',
      description: `单元「${label}」见证 ${reading.witnessId} 的读法在往返后改变：「${expected}」→「${actual}」`,
      unitId,
      eventId: ev?.id,
    });
    return;
  }
  if (reading.type !== 'original') {
    diffs.push({
      kind: 'known-edit',
      description: `单元「${label}」见证 ${reading.witnessId} 的${typeLabel(reading.type)}为已知编辑，往返一致`,
      unitId,
      eventId: ev?.id,
    });
  }
}

function typeLabel(t: string): string {
  return { omission: '缺文', transposition: '异序', editorial: '编辑判断' }[t] ?? t;
}

function collectRawText(rawXml: string): string {
  const { nodes } = parseXml(rawXml);
  return collectRawTextFromNodes(nodes);
}

function collectRawTextFromNodes(nodes: XmlNode[]): string {
  let out = '';
  const walk = (ns: XmlNode[]) => {
    for (const n of ns) {
      if (n.kind === 'text' || n.kind === 'cdata') out += n.raw;
      else if (n.kind === 'element') walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
