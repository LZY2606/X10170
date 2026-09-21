export type ReadingType = 'original' | 'lacuna' | 'transposition' | 'judgment';

export interface Fragment {
  start: number;
  end: number;
  /** 该片段在该见证内部的阅读顺序；倒置时顺序与文档顺序相反 */
  order: number;
}

export interface Anchor {
  witnessId: string;
  start: number;
  end: number;
  label?: string;
}

export interface Reading {
  witnessId: string;
  type: ReadingType;
  note: string;
  fragments: Fragment[];
}

export interface Unit {
  id: string;
  title: string;
  anchors: Anchor[];
  readings: Reading[];
  createdAt: number;
  updatedAt: number;
}

export type EventKind =
  | 'witness.import'
  | 'witness.delete'
  | 'anchor.create'
  | 'anchor.revise'
  | 'unit.create'
  | 'unit.update'
  | 'unit.delete'
  | 'policy.update';

export interface EditEvent {
  id: string;
  revision: number;
  kind: EventKind;
  at: number;
  editor: string;
  /** 旧版本负载（锚点修订时为旧锚点，删除时为被删对象快照） */
  before?: unknown;
  after?: unknown;
  /** 本次事件影响到的校勘单元 id 列表 */
  affectedUnits: string[];
  summary: string;
}

export interface Witness {
  id: string;
  name: string;
  /** 原始 XML 原文（逐字节保存） */
  rawXml: string;
  sha256: string;
  importedAt: number;
}

export interface ProjectState {
  revision: number;
  witnesses: Witness[];
  units: Unit[];
  events: EditEvent[];
  elementPolicy: Record<string, 'keep' | 'unwrap'>;
}

export function createInitialState(): ProjectState {
  return {
    revision: 0,
    witnesses: [],
    units: [],
    events: [],
    elementPolicy: {},
  };
}

type Interval = { start: number; end: number };

export function rangesOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function rangeContains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * 同一见证内，两个锚点集“交叠但互不包含”才合法：
 * 既不允许完全分离之外的错误嵌套（包含），也允许真正的交叉。
 * 返回 null 表示通过，否则返回错误说明。
 */
export function checkAnchorPair(a: Anchor, b: Anchor): string | null {
  if (a.witnessId !== b.witnessId) return null;
  const af = { start: a.start, end: a.end };
  const bf = { start: b.start, end: b.end };
  if (!rangesOverlap(af, bf)) return null;
  if (rangeContains(af, bf) || rangeContains(bf, af)) {
    if (af.start === bf.start && af.end === bf.end) return '两个锚点范围完全相同，应复用同一锚点';
    return '交叠锚点不允许互相包含（仅允许交叉）';
  }
  return null;
}

/** 单元内每个见证的片段不得彼此交叠（倒置片段也要互不包含、互不交叉） */
export function validateUnitFragments(units: Unit[], candidate: Unit): string | null {
  for (const reading of candidate.readings) {
    const frags = [...reading.fragments].sort((x, y) => x.start - y.start);
    for (let i = 1; i < frags.length; i++) {
      if (rangesOverlap(frags[i - 1], frags[i])) {
        return `见证 ${reading.witnessId} 的倒置片段彼此交叠，位置不合法`;
      }
    }
  }
  for (const other of units) {
    if (other.id === candidate.id) continue;
    for (const anchor of candidate.anchors) {
      for (const otherAnchor of other.anchors) {
        const err = checkAnchorPair(anchor, otherAnchor);
        if (err) return `与单元「${other.title}」(${other.id}) 的锚点冲突：${err}`;
      }
    }
  }
  return null;
}

export function unitsReferencingWitness(state: ProjectState, witnessId: string): Unit[] {
  return state.units.filter(
    (u) =>
      u.anchors.some((a) => a.witnessId === witnessId) ||
      u.readings.some((r) => r.witnessId === witnessId),
  );
}

export function shiftRange(
  value: number,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): number {
  if (value <= oldStart) return value;
  if (value >= oldEnd) return value + (newEnd - newStart) - (oldEnd - oldStart);
  const ratio = (value - oldStart) / (oldEnd - oldStart);
  return Math.round(newStart + ratio * (newEnd - newStart));
}
