export type ReadingStatus = 'original' | 'lacuna' | 'transposition' | 'editorial';

export interface TextRange {
  start: number;
  end: number;
}

export interface TranscribedFragment {
  text: string;
  order: number;
  reversed?: boolean;
}

export interface WitnessReading {
  anchorId: string;
  status: ReadingStatus;
  text: string;
  fragments?: TranscribedFragment[];
  judgment?: string;
  note?: string;
}

export interface AnchorRevision {
  version: number;
  range: TextRange;
  reason: string;
  at: string;
  actor: string;
  affectedUnitIds: string[];
}

export interface Anchor {
  id: string;
  witnessId: string;
  groupId: string;
  label: string;
  kind: 'paragraph' | 'page' | 'manual' | 'unit';
  current: AnchorRevision;
  history: AnchorRevision[];
}

export interface Witness {
  id: string;
  name: string;
  filename: string;
  rawPath: string;
  sha256: string;
  importedAt: string;
  deleted?: { at: string; actor: string; reason: string };
}

export interface CollationUnit {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  readings: Record<string, WitnessReading>;
}

export interface Conflict {
  id: string;
  at: string;
  actor: string;
  baseVersion: number;
  currentVersion: number;
  incoming: {
    type: string;
    label: string;
    ranges: Array<{ witnessId: string; start: number; end: number; snippet: string }>;
  };
  existing: {
    eventId: string;
    actor: string;
    type: string;
    label: string;
    ranges: Array<{ witnessId: string; start: number; end: number; snippet: string }>;
  };
  resolved: boolean;
  note?: string;
}

export type EventType =
  | 'witness.imported'
  | 'witness.deleteProposed'
  | 'witness.deleted'
  | 'anchor.added'
  | 'anchor.revised'
  | 'unit.created'
  | 'unit.updated'
  | 'conflict.recorded'
  | 'conflict.resolved'
  | 'export.completed';

export interface EditEvent {
  id: string;
  type: EventType;
  at: string;
  actor: string;
  version: number;
  baseVersion: number;
  payload: unknown;
}

export interface ProjectState {
  version: number;
  witnesses: Record<string, Witness>;
  anchors: Record<string, Anchor>;
  units: Record<string, CollationUnit>;
  conflicts: Record<string, Conflict>;
}

export interface XmlIssue {
  witnessId?: string;
  path: string;
  qualifiedName: string;
  localName: string;
  message: string;
  severity: 'blocker' | 'warning';
}

export interface TextSegment {
  text: string;
  start: number;
  end: number;
  path: string;
  kind: 'text';
}

export interface NormalizedView {
  text: string;
  codePointLength: number;
  segments: TextSegment[];
  structures: Array<{
    path: string;
    qualifiedName: string;
    localName: string;
    start: number;
    end: number;
    known: boolean;
  }>;
  issues: XmlIssue[];
}

export interface RoundTripDifference {
  id: string;
  classification: 'known-edit' | 'lexical-only' | 'unacceptable-loss';
  witnessId?: string;
  path: string;
  expected: string;
  actual: string;
  eventId?: string;
  explanation: string;
}
