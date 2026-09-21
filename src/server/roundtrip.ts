/**
 * 往返核验：重新解析导出的 XML，与内存中的语义状态逐项比对，
 * 把差异分为三类：
 *   known-edit        已知编辑（对应编辑事件，可追溯）
 *   lexical-only      仅词法变化（实体写法 / 空白 / 属性顺序等，规范化后相等）
 *   unacceptable-loss 不可接受丢失（语义对不上且无编辑事件支撑）
 */
import { parseDocument } from './xml/model.js';
import { canon } from './xml/normalize.js';
import { exportXml } from './exportXml.js';
import type { Store } from './store.js';

export type DiffCategory = 'known-edit' | 'lexical-only' | 'unacceptable-loss';

export interface RoundtripDiff {
  id: string;
  category: DiffCategory;
  unitId: string;
  unitName: string;
  witnessId: string;
  expected: string;
  actual: string;
  editEventId: string | null;
  message: string;
}

export interface RoundtripReport {
  ok: boolean;
  diffs: RoundtripDiff[];
  counts: Record<DiffCategory, number>;
}

interface ExportedReading {
  unitId: string;
  witnessId: string;
  type: string;
  text: string;
}

/** 从导出 XML 中抽取 app/lem/rdg 结构。 */
export function parseExportedApparatus(xml: string): ExportedReading[] {
  const doc = parseDocument(xml);
  const out: ExportedReading[] = [];
  const textOf = (el: import('./xml/model.js').ElementNode): string =>
    el.children.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('');
  for (const el of doc.elements) {
    if (el.localName !== 'app') continue;
    const unitId = el.attrs.find((a) => a.name === 'xml:id')?.value ?? '';
    for (const child of el.children) {
      if (child.type !== 'element') continue;
      if (child.localName !== 'lem' && child.localName !== 'rdg') continue;
      const wit = child.attrs.find((a) => a.name === 'wit')?.value?.replace(/^#/, '') ?? '';
      const type = child.attrs.find((a) => a.name === 'type')?.value ?? 'original';
      out.push({ unitId, witnessId: wit, type, text: textOf(child) });
    }
  }
  return out;
}

export function roundtripVerify(store: Store): RoundtripReport {
  const xml = exportXml(store);
  const exported = parseExportedApparatus(xml);
  const diffs: RoundtripDiff[] = [];
  let seq = 0;

  for (const unit of store.units.values()) {
    for (const reading of unit.readings) {
      const expected = store.resolveReading(unit, reading);
      const found = exported.find((e) => e.unitId === unit.id && e.witnessId === reading.witnessId);
      const lastEvent = store.lastEventForUnit(unit.id);
      const base = {
        id: `diff-${++seq}`,
        unitId: unit.id,
        unitName: unit.name,
        witnessId: reading.witnessId,
        expected,
      };
      if (!found) {
        diffs.push({
          ...base,
          category: 'unacceptable-loss',
          actual: '',
          editEventId: null,
          message: `单元「${unit.name}」在见证 ${reading.witnessId} 的读法未出现在导出中`,
        });
        continue;
      }
      if (found.text === expected) continue; // 完全一致
      if (canon(found.text) === canon(expected)) {
        diffs.push({
          ...base,
          category: 'lexical-only',
          actual: found.text,
          editEventId: null,
          message: `单元「${unit.name}」仅词法层面不同（实体/组合字符写法），规范化后相等`,
        });
        continue;
      }
      if ((reading.type === 'editorial' || reading.type === 'transposition') && lastEvent) {
        diffs.push({
          ...base,
          category: 'known-edit',
          actual: found.text,
          editEventId: lastEvent.id,
          message: `单元「${unit.name}」的文本差异对应编辑事件 ${lastEvent.id}（${lastEvent.summary}）`,
        });
        continue;
      }
      diffs.push({
        ...base,
        category: 'unacceptable-loss',
        actual: found.text,
        editEventId: null,
        message: `单元「${unit.name}」导出文本与记录不符，且无对应编辑事件`,
      });
    }
  }

  const counts: Record<DiffCategory, number> = { 'known-edit': 0, 'lexical-only': 0, 'unacceptable-loss': 0 };
  for (const d of diffs) counts[d.category]++;
  return { ok: counts['unacceptable-loss'] === 0, diffs, counts };
}
