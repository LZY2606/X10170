export interface ApiConflict {
  code: 'revision-conflict';
  message: string;
  detail: {
    baseRevision: number;
    currentRevision: number;
    attemptedBy: string;
    attemptedKind: string;
    attemptedAfter: unknown;
    interveningEvents: Array<{
      id: string;
      revision: number;
      editor: string;
      kind: string;
      summary: string;
      after: unknown;
    }>;
  };
}

export class ApiError extends Error {
  status: number;
  body: { error: ApiConflict } | unknown;
  constructor(status: number, body: unknown) {
    super((body as { error?: { message?: string } })?.error?.message ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  state: () => request<StateSnapshot>('GET', '/api/state'),
  witness: (id: string) => request<WitnessDetail>('GET', `/api/witness?id=${encodeURIComponent(id)}`),
  importWitness: (input: ImportWitnessInput) => request<MutationResult>('POST', '/api/witness/import', input),
  deleteCheck: (witnessId: string) =>
    request<{ blocked: boolean; referenced: { id: string; title: string }[] }>(
      'POST', '/api/witness/delete-check', { witnessId }),
  deleteWitness: (input: { witnessId: string; editor: string; baseRevision: number }) =>
    request<MutationResult>('POST', '/api/witness/delete', input),
  createUnit: (input: CreateUnitInput) => request<MutationResult & { unitId: string }>('POST', '/api/unit', input),
  updateUnit: (input: UpdateUnitInput) => request<MutationResult>('POST', '/api/unit/update', input),
  deleteUnit: (input: { unitId: string; editor: string; baseRevision: number }) =>
    request<MutationResult>('POST', '/api/unit/delete', input),
  reviseAnchor: (input: ReviseAnchorInput) => request<MutationResult>('POST', '/api/anchor/revise', input),
  precheck: () => request<PrecheckResult>('GET', '/api/export/precheck'),
  doExport: () => request<{ xml: string; witnessCount: number; unitCount: number }>('POST', '/api/export', {}),
  roundtrip: (exportedXml?: string) =>
    request<RoundtripReport>('POST', '/api/roundtrip', { exportedXml }),
  setPolicy: (input: { qname: string; policy: 'keep' | 'unwrap'; editor: string; baseRevision: number }) =>
    request<MutationResult>('POST', '/api/policy', input),
};

export interface MutationResult {
  revision: number;
  event: EditEventDto;
}

export interface EditEventDto {
  id: string;
  revision: number;
  kind: string;
  at: number;
  editor: string;
  before: unknown;
  after: unknown;
  affectedUnits: string[];
  summary: string;
}

export interface StateSnapshot {
  revision: number;
  witnesses: Array<{ id: string; name: string; sha256: string; importedAt: number; size: number }>;
  units: UnitDto[];
  events: EditEventDto[];
  elementPolicy: Record<string, 'keep' | 'unwrap'>;
}

export interface AnchorDto { witnessId: string; start: number; end: number; label?: string }
export interface FragmentDto { start: number; end: number; order: number }
export interface ReadingDto { witnessId: string; type: string; note: string; fragments: FragmentDto[] }
export interface UnitDto {
  id: string;
  title: string;
  anchors: AnchorDto[];
  readings: ReadingDto[];
  createdAt: number;
  updatedAt: number;
}

export interface ImportWitnessInput {
  name: string;
  rawXml: string;
  editor: string;
  baseRevision: number;
}

export interface CreateUnitInput {
  title: string;
  anchors: AnchorDto[];
  readings: ReadingDto[];
  editor: string;
  baseRevision: number;
}

export interface UpdateUnitInput {
  unitId: string;
  title?: string;
  anchors?: AnchorDto[];
  readings?: ReadingDto[];
  editor: string;
  baseRevision: number;
}

export interface ReviseAnchorInput {
  witnessId: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  label?: string;
  editor: string;
  baseRevision: number;
}

export interface PrecheckResult {
  ok: boolean;
  blockers: Array<{
    witnessId: string;
    witnessName: string;
    xpath: string;
    offset: number;
    qname: string;
    reason: string;
  }>;
  normalizedUnitCount: number;
}

export interface RoundtripReport {
  ok: boolean;
  diffs: Array<{
    classification: 'known-edit' | 'lexical' | 'unacceptable-loss';
    witnessId: string;
    witnessName: string;
    path: string;
    kind: string;
    originalSnippet: string;
    exportedSnippet: string;
    sourceOffset: number;
    eventIds: string[];
    explanation: string;
  }>;
  counts: { 'known-edit': number; lexical: number; 'unacceptable-loss': number };
  reparseError: string | null;
}

export interface WitnessDetail {
  id: string;
  name: string;
  rawXml: string;
  sha256: string;
  view: {
    text: string;
    graphemes: Array<{ offset: number; text: string; nodeId: string; start: number; end: number }>;
    markers: Array<{ offset: number; kind: string; label: string; nodeId: string }>;
  };
}
