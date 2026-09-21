export type ReadingType = 'original' | 'omission' | 'transposition' | 'editorial';

export interface Range {
  start: number;
  end: number;
}

export interface Reading {
  witnessId: string;
  type: ReadingType;
  /** 派生文本中的区间；缺文（omission）时缺省 */
  range?: Range;
  /** 异序：按底本逻辑顺序排列的子区间（绝对偏移，须落在 range 内） */
  parts?: Range[];
  note?: string;
  /** 若该读法由锚点创建，记录锚点以便修订联动 */
  anchorId?: string;
}

export interface CollationUnit {
  id: string;
  label: string;
  readings: Reading[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnchorRevision {
  start: number;
  end: number;
  version: number;
  at: string;
}

export interface Anchor {
  id: string;
  witnessId: string;
  start: number;
  end: number;
  version: number;
  history: AnchorRevision[];
}

export interface Witness {
  id: string;
  name: string;
  /** 来源 XML，原样保存，不做任何规范化 */
  rawXml: string;
  addedAt: string;
}

export interface EditEvent {
  id: string;
  at: string;
  kind: string;
  summary: string;
  witnessId?: string;
  unitId?: string;
  anchorId?: string;
  range?: Range;
  affectedUnitIds?: string[];
}

export interface ProjectData {
  witnesses: Witness[];
  anchors: Anchor[];
  units: CollationUnit[];
  events: EditEvent[];
  counters: Record<string, number>;
}

export function emptyProject(): ProjectData {
  return { witnesses: [], anchors: [], units: [], events: [], counters: {} };
}
