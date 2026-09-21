import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildNormalizedView, codepointSlice, detectAnchors, rangesOverlap, validateRange } from './xml.js';
import type {
  Anchor, CollationUnit, Conflict, EditEvent, NormalizedView, ProjectState,
  TextRange, Witness, WitnessReading
} from './types.js';

export interface CommandContext {
  baseVersion: number;
  actor: string;
}

function initialState(): ProjectState {
  return { version: 0, witnesses: {}, anchors: {}, units: {}, conflicts: {} };
}

function now(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; }

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface RangeRef { witnessId: string; start: number; end: number; snippet: string; }
type RangePayload = { ranges?: RangeRef[] };

function eventRanges(event: EditEvent, state: ProjectState): RangeRef[] {
  const payload = event.payload as RangePayload & { anchor?: { witnessId: string; range: TextRange }; unit?: { readings: Record<string, WitnessReading> } };
  if (payload.ranges) return payload.ranges;
  if (payload.anchor) {
    return [{ ...payload.anchor.range, witnessId: payload.anchor.witnessId, snippet: '' }];
  }
  if (payload.unit?.readings) return readingRanges(payload.unit.readings, state);
  return [];
}

function readingRanges(readings: Record<string, WitnessReading>, state: ProjectState): RangeRef[] {
  return Object.entries(readings).map(([witnessId, reading]) => {
    const anchor = state.anchors[reading.anchorId];
    const range = anchor.current.range;
    return { witnessId, start: range.start, end: range.end, snippet: '' };
  });
}

function enrichRanges(ranges: Array<Omit<RangeRef, 'snippet'>>, views: Map<string, NormalizedView>): RangeRef[] {
  return ranges.map(range => ({
    ...range,
    snippet: codepointSlice(views.get(range.witnessId)?.text || '', range.start, range.end)
  }));
}

function validateUnitAnchorGeometry(state: ProjectState): void {
  const byWitness = new Map<string, Array<{ unitId: string; range: TextRange }>>();
  Object.values(state.units).forEach(unit => {
    Object.entries(unit.readings).forEach(([witnessId, reading]) => {
      const anchor = state.anchors[reading.anchorId];
      if (!anchor || anchor.witnessId !== witnessId) throw new Error('校勘单元引用了不存在或见证不匹配的锚点');
      const list = byWitness.get(witnessId) || [];
      list.push({ unitId: unit.id, range: anchor.current.range });
      byWitness.set(witnessId, list);
    });
  });
  byWitness.forEach(items => {
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i].range;
        const b = items[j].range;
        if (rangesOverlap(a, b)) {
          const contained = (a.start <= b.start && b.end <= a.end) || (b.start <= a.start && a.end <= b.end);
          const identical = a.start === b.start && a.end === b.end;
          if (contained && !identical) {
            throw new Error(`校勘单元 ${items[i].unitId} 与 ${items[j].unitId} 的锚点错误包含；允许交叠但不能包含`);
          }
        }
      }
    }
  });
}

export class LoomStore {
  private state = initialState();
  private events: EditEvent[] = [];
  private views = new Map<string, NormalizedView>();

  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<LoomStore> {
    await mkdir(join(dir, 'raw'), { recursive: true });
    const store = new LoomStore(dir);
    const eventDir = join(dir, 'events');
    await mkdir(eventDir, { recursive: true });
    const files = (await readdir(eventDir)).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
      const event = JSON.parse(await readFile(join(eventDir, file), 'utf8')) as EditEvent;
      store.events.push(event);
      store.apply(event);
    }
    for (const witness of Object.values(store.state.witnesses)) {
      if (!store.views.has(witness.id)) {
        const raw = await readFile(join(dir, witness.rawPath), 'utf8');
        store.views.set(witness.id, buildNormalizedView(raw, witness.id));
      }
    }
    return store;
  }

  getState(): ProjectState { return structuredClone(this.state); }
  getEvents(): EditEvent[] { return structuredClone(this.events); }
  getView(witnessId: string): NormalizedView {
    const view = this.views.get(witnessId);
    if (!view) throw new Error('见证不存在或已不可读');
    return structuredClone(view);
  }

  async getRaw(witnessId: string): Promise<string> {
    const witness = this.state.witnesses[witnessId];
    if (!witness) throw new Error('见证不存在');
    return readFile(join(this.dir, witness.rawPath), 'utf8');
  }

  private appendEvent(event: EditEvent): void {
    this.events.push(event);
    this.apply(event);
  }

  private async persist(event: EditEvent): Promise<void> {
    const path = join(this.dir, 'events', `${String(event.version).padStart(6, '0')}-${event.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(event, null, 2) + '\n', 'utf8');
  }

  private async commit(type: EditEvent['type'], ctx: CommandContext, payload: unknown, incoming: RangeRef[] = []): Promise<EditEvent> {
    if (ctx.baseVersion !== this.state.version) {
      const prior = this.events.filter(event => event.version > ctx.baseVersion).reverse();
      const existingEvent = prior.find(event => eventRanges(event, this.state).length) || prior[0];
      if (existingEvent && incoming.length) {
        const conflictId = id('conflict');
        const conflict: Conflict = {
          id: conflictId,
          at: now(),
          actor: ctx.actor,
          baseVersion: ctx.baseVersion,
          currentVersion: this.state.version,
          incoming: { type, label: (payload as { label?: string }).label || type, ranges: incoming },
          existing: {
            eventId: existingEvent.id,
            actor: existingEvent.actor,
            type: existingEvent.type,
            label: ((existingEvent.payload as { label?: string }).label) || existingEvent.type,
            ranges: enrichRanges(eventRanges(existingEvent, this.state).map(range => ({
              witnessId: range.witnessId,
              start: range.start,
              end: range.end
            })), this.views)
          },
          resolved: false,
          note: '后提交基于旧版本；无论区间是否交叠，均需查看双方片段并刷新后重新提交'
        };
        const conflictEvent: EditEvent = {
          id: conflictId, type: 'conflict.recorded', at: conflict.at, actor: ctx.actor,
          version: this.state.version + 1, baseVersion: ctx.baseVersion, payload: conflict
        };
        this.appendEvent(conflictEvent);
        await this.persist(conflictEvent);
        throw Object.assign(new Error('检测到并发范围冲突，已保留双方范围和文本片段，请刷新后处理'), { status: 409, conflictId });
      }
    }
    const event: EditEvent = {
      id: id('evt'), type, at: now(), actor: ctx.actor,
      version: this.state.version + 1, baseVersion: ctx.baseVersion, payload
    };
    await this.persist(event);
    this.appendEvent(event);
    return event;
  }

  private apply(event: EditEvent): void {
    this.state.version = event.version;
    const payload = event.payload;
    if (event.type === 'witness.imported') {
      const p = payload as { witness: Witness; anchors: Anchor[] };
      this.state.witnesses[p.witness.id] = structuredClone(p.witness);
      p.anchors.forEach(anchor => { this.state.anchors[anchor.id] = structuredClone(anchor); });
    } else if (event.type === 'witness.deleted') {
      const p = payload as { witnessId: string; at: string; actor: string; reason: string };
      const witness = this.state.witnesses[p.witnessId];
      if (witness) witness.deleted = { at: p.at, actor: p.actor, reason: p.reason };
    } else if (event.type === 'anchor.added' || event.type === 'anchor.revised') {
      const p = payload as { anchor: Anchor };
      this.state.anchors[p.anchor.id] = structuredClone(p.anchor);
    } else if (event.type === 'unit.created' || event.type === 'unit.updated') {
      const p = payload as { unit: CollationUnit };
      this.state.units[p.unit.id] = structuredClone(p.unit);
    } else if (event.type === 'conflict.recorded') {
      const p = payload as Conflict;
      this.state.conflicts[p.id] = structuredClone(p);
    } else if (event.type === 'conflict.resolved') {
      const p = payload as { conflictId: string; at: string };
      const conflict = this.state.conflicts[p.conflictId];
      if (conflict) conflict.resolved = true;
    } else if (event.type === 'export.completed') {
      // Export is audit-only; all source edits already have events.
    }
  }

  async importWitness(input: { name: string; filename: string; raw: string }, ctx: CommandContext): Promise<EditEvent> {
    const witnessId = id('witness');
    const safeName = input.filename.replace(/[^A-Za-z0-9._\-\u3400-\u9fff]/g, '_');
    const rawPath = join('raw', `${witnessId}-${safeName}`);
    const view = buildNormalizedView(input.raw, witnessId);
    const witness: Witness = {
      id: witnessId,
      name: input.name || safeName,
      filename: input.filename,
      rawPath,
      sha256: sha256(input.raw),
      importedAt: now()
    };
    const anchors: Anchor[] = detectAnchors(view, witnessId).map((item, index) => {
      const anchorId = `${witnessId}-${item.kind}-${index}`;
      const revision = { version: 1, range: item.range, reason: '导入时自动发现', at: witness.importedAt, actor: ctx.actor, affectedUnitIds: [] };
      return {
        id: anchorId, witnessId, groupId: `${item.kind}:${index}`,
        label: item.label, kind: item.kind, current: revision, history: []
      };
    });
    await writeFile(join(this.dir, rawPath), input.raw, 'utf8');
    this.views.set(witnessId, view);
    return this.commit('witness.imported', ctx, { witness, anchors });
  }

  witnessReferences(witnessId: string) {
    return Object.values(this.state.units)
      .filter(unit => Boolean(unit.readings[witnessId]))
      .map(unit => ({
        unitId: unit.id,
        label: unit.label,
        snippet: unit.readings[witnessId].text,
        anchorId: unit.readings[witnessId].anchorId
      }));
  }

  async deleteWitness(witnessId: string, reason: string, ctx: CommandContext): Promise<EditEvent> {
    const witness = this.state.witnesses[witnessId];
    if (!witness) throw new Error('见证不存在');
    if (witness.deleted) throw new Error('见证已删除');
    const references = this.witnessReferences(witnessId);
    if (references.length) {
      throw Object.assign(new Error(`仍有 ${references.length} 个校勘单元引用该见证，禁止删除`), { references, status: 409 });
    }
    return this.commit('witness.deleted', ctx, { witnessId, reason, at: now(), actor: ctx.actor });
  }

  async addAnchor(input: { witnessId: string; range: TextRange; groupId: string; label: string }, ctx: CommandContext): Promise<EditEvent> {
    const witness = this.state.witnesses[input.witnessId];
    if (!witness || witness.deleted) throw new Error('见证不存在或已删除');
    validateRange(input.range, this.views.get(input.witnessId)!.codePointLength);
    const anchorId = id('anchor');
    const anchor: Anchor = {
      id: anchorId, witnessId: input.witnessId, groupId: input.groupId,
      label: input.label, kind: 'manual',
      current: { version: 1, range: input.range, reason: '手工对齐', at: now(), actor: ctx.actor, affectedUnitIds: [] },
      history: []
    };
    return this.commit('anchor.added', ctx, { anchor });
  }

  async reviseAnchor(anchorId: string, range: TextRange, reason: string, ctx: CommandContext): Promise<EditEvent> {
    const old = this.state.anchors[anchorId];
    if (!old) throw new Error('锚点不存在');
    const witness = this.state.witnesses[old.witnessId];
    if (!witness || witness.deleted) throw new Error('见证不存在或已删除');
    validateRange(range, this.views.get(old.witnessId)!.codePointLength);
    const affectedUnitIds = Object.values(this.state.units)
      .filter(unit => Object.values(unit.readings).some(reading => reading.anchorId === anchorId))
      .map(unit => unit.id);
    const revision = {
      version: old.current.version + 1,
      range,
      reason,
      at: now(),
      actor: ctx.actor,
      affectedUnitIds
    };
    const nextAnchor: Anchor = structuredClone(old);
    nextAnchor.history.push(old.current);
    nextAnchor.current = revision;
    const candidate: ProjectState = structuredClone(this.state);
    candidate.anchors[anchorId] = nextAnchor;
    validateWithState(candidate);
    const incoming = enrichRanges([{ witnessId: old.witnessId, ...range }], this.views);
    return this.commit('anchor.revised', ctx, { anchor: nextAnchor, oldRange: old.current.range }, incoming);
  }

  async createUnit(label: string, readings: Record<string, WitnessReading>, ctx: CommandContext): Promise<EditEvent> {
    const unit: CollationUnit = {
      id: id('unit'), label, readings, createdAt: now(), updatedAt: now()
    };
    const candidate: ProjectState = structuredClone(this.state);
    candidate.units[unit.id] = unit;
    validateWithState(candidate);
    const incoming = enrichRanges(Object.entries(readings).map(([witnessId, reading]) => {
      const range = this.state.anchors[reading.anchorId].current.range;
      return { witnessId, start: range.start, end: range.end };
    }), this.views);
    return this.commit('unit.created', ctx, { unit }, incoming);
  }

  async updateUnit(unitId: string, patch: { label?: string; readings: Record<string, WitnessReading> }, ctx: CommandContext): Promise<EditEvent> {
    const old = this.state.units[unitId];
    if (!old) throw new Error('校勘单元不存在');
    const unit: CollationUnit = {
      ...structuredClone(old),
      label: patch.label ?? old.label,
      readings: patch.readings,
      updatedAt: now()
    };
    const candidate: ProjectState = structuredClone(this.state);
    candidate.units[unitId] = unit;
    validateWithState(candidate);
    const incoming = enrichRanges(Object.entries(patch.readings).map(([witnessId, reading]) => {
      const range = this.state.anchors[reading.anchorId].current.range;
      return { witnessId, start: range.start, end: range.end };
    }), this.views);
    return this.commit('unit.updated', ctx, { unit }, incoming);
  }

  async resolveConflict(conflictId: string, ctx: CommandContext): Promise<EditEvent> {
    if (!this.state.conflicts[conflictId]) throw new Error('冲突不存在');
    return this.commit('conflict.resolved', ctx, { conflictId, at: now(), actor: ctx.actor });
  }

  async recordExport(xml: string, ctx: CommandContext): Promise<EditEvent> {
    return this.commit('export.completed', ctx, { sha256: sha256(xml), at: now() });
  }
}

function validateWithState(state: ProjectState): void {
  validateUnitAnchorGeometry(state);
}
