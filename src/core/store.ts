import { createHash } from 'node:crypto';
import {
  createInitialState,
  unitsReferencingWitness,
  validateUnitFragments,
  type Anchor,
  type EditEvent,
  type ProjectState,
  type Reading,
  type Unit,
  type Witness,
} from './model.js';

let idCounter = 0;
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface CommitContext {
  editor: string;
  baseRevision: number;
}

export interface CommitResult {
  state: ProjectState;
  event: EditEvent;
}

export interface ConflictDetail {
  baseRevision: number;
  currentRevision: number;
  attemptedBy: string;
  attemptedKind: string;
  attemptedAfter: unknown;
  interveningEvents: EditEvent[];
  message: string;
}

export class RevisionConflict extends Error {
  detail: ConflictDetail;
  constructor(detail: ConflictDetail) {
    super(detail.message);
    this.name = 'RevisionConflict';
    this.detail = detail;
  }
}

export class ValidationFailure extends Error {}

function logEvent(
  state: ProjectState,
  ctx: CommitContext,
  kind: EditEvent['kind'],
  summary: string,
  before: unknown,
  after: unknown,
  affectedUnits: string[],
): EditEvent {
  state.revision += 1;
  const event: EditEvent = {
    id: makeId('ev'),
    revision: state.revision,
    kind,
    at: Date.now(),
    editor: ctx.editor,
    before,
    after,
    affectedUnits,
    summary,
  };
  state.events.push(event);
  return event;
}

function checkRevision(state: ProjectState, ctx: CommitContext, kind: string, after?: unknown): void {
  if (ctx.baseRevision !== state.revision) {
    const intervening = state.events.filter((e) => e.revision > ctx.baseRevision);
    throw new RevisionConflict({
      baseRevision: ctx.baseRevision,
      currentRevision: state.revision,
      attemptedBy: ctx.editor,
      attemptedKind: kind,
      attemptedAfter: after ?? null,
      interveningEvents: intervening,
      message:
        `修订冲突：${ctx.editor} 基于 r${ctx.baseRevision} 提交，但当前已为 r${state.revision}；` +
        `期间发生 ${intervening.length} 个事件，拒绝以最后保存覆盖`,
    });
  }
}

export class ProjectStore {
  state: ProjectState;

  constructor(initial?: ProjectState) {
    this.state = initial ? structuredClone(initial) : createInitialState();
  }

  private witness(id: string): Witness {
    const w = this.state.witnesses.find((x) => x.id === id);
    if (!w) throw new ValidationFailure(`见证 ${id} 不存在`);
    return w;
  }

  private unit(id: string): Unit {
    const u = this.state.units.find((x) => x.id === id);
    if (!u) throw new ValidationFailure(`校勘单元 ${id} 不存在`);
    return u;
  }

  importWitness(input: { name: string; rawXml: string }, ctx: CommitContext): CommitResult {
    checkRevision(this.state, ctx, 'witness.import', input);
    const witness: Witness = {
      id: makeId('w'),
      name: input.name,
      rawXml: input.rawXml,
      sha256: sha256Hex(input.rawXml),
      importedAt: Date.now(),
    };
    this.state.witnesses.push(witness);
    const event = logEvent(
      this.state,
      ctx,
      'witness.import',
      `导入见证「${input.name}」(${witness.id})，原文 ${input.rawXml.length} 字符，sha256=${witness.sha256.slice(0, 12)}…`,
      null,
      { id: witness.id, name: witness.name, sha256: witness.sha256, size: witness.rawXml.length },
      [],
    );
    return { state: this.state, event };
  }

  /** 删除前预检：返回仍引用该见证的单元；存在引用时拒绝 */
  checkDeleteWitness(witnessId: string): { blocked: boolean; referenced: Unit[] } {
    this.witness(witnessId);
    const referenced = unitsReferencingWitness(this.state, witnessId);
    return { blocked: referenced.length > 0, referenced };
  }

  deleteWitness(witnessId: string, ctx: CommitContext): CommitResult {
    checkRevision(this.state, ctx, 'witness.delete', { witnessId });
    const witness = this.witness(witnessId);
    const referenced = unitsReferencingWitness(this.state, witnessId);
    if (referenced.length > 0) {
      throw new ValidationFailure(
        `删除被拒绝：仍有 ${referenced.length} 个校勘单元引用见证「${witness.name}」：` +
          referenced.map((u) => `${u.title}(${u.id})`).join('、'),
      );
    }
    const snapshot = structuredClone(witness);
    this.state.witnesses = this.state.witnesses.filter((w) => w.id !== witnessId);
    const event = logEvent(
      this.state,
      ctx,
      'witness.delete',
      `删除见证「${witness.name}」(${witnessId})`,
      snapshot,
      null,
      [],
    );
    return { state: this.state, event };
  }

  createUnit(
    input: { title: string; anchors: Anchor[]; readings: Reading[] },
    ctx: CommitContext,
  ): CommitResult {
    checkRevision(this.state, ctx, 'unit.create', input);
    for (const anchor of input.anchors) this.witness(anchor.witnessId);
    const unit: Unit = {
      id: makeId('u'),
      title: input.title,
      anchors: structuredClone(input.anchors),
      readings: structuredClone(input.readings),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const err = validateUnitFragments(this.state.units, unit);
    if (err) throw new ValidationFailure(err);
    this.state.units.push(unit);
    const event = logEvent(
      this.state,
      ctx,
      'unit.create',
      `创建校勘单元「${unit.title}」(${unit.id})，${unit.anchors.length} 个锚点`,
      null,
      { id: unit.id, title: unit.title, anchors: unit.anchors },
      [unit.id],
    );
    return { state: this.state, event };
  }

  updateUnit(
    unitId: string,
    patch: { title?: string; anchors?: Anchor[]; readings?: Reading[] },
    ctx: CommitContext,
  ): CommitResult {
    checkRevision(this.state, ctx, 'unit.update', { unitId, ...patch });
    const unit = this.unit(unitId);
    if (patch.anchors) for (const anchor of patch.anchors) this.witness(anchor.witnessId);
    const candidate: Unit = {
      ...unit,
      title: patch.title ?? unit.title,
      anchors: patch.anchors ? structuredClone(patch.anchors) : unit.anchors,
      readings: patch.readings ? structuredClone(patch.readings) : unit.readings,
    };
    const others = this.state.units.filter((u) => u.id !== unitId);
    const err = validateUnitFragments(others, candidate);
    if (err) throw new ValidationFailure(err);
    const before = structuredClone({ title: unit.title, anchors: unit.anchors, readings: unit.readings });
    unit.title = candidate.title;
    unit.anchors = candidate.anchors;
    unit.readings = candidate.readings;
    unit.updatedAt = Date.now();
    const event = logEvent(
      this.state,
      ctx,
      'unit.update',
      `更新校勘单元「${unit.title}」(${unitId})`,
      before,
      { title: unit.title, anchors: unit.anchors, readings: unit.readings },
      [unitId],
    );
    return { state: this.state, event };
  }

  deleteUnit(unitId: string, ctx: CommitContext): CommitResult {
    checkRevision(this.state, ctx, 'unit.delete', { unitId });
    const unit = this.unit(unitId);
    const snapshot = structuredClone(unit);
    this.state.units = this.state.units.filter((u) => u.id !== unitId);
    const event = logEvent(
      this.state,
      ctx,
      'unit.delete',
      `删除校勘单元「${unit.title}」(${unitId})`,
      snapshot,
      null,
      [unitId],
    );
    return { state: this.state, event };
  }

  /**
   * 修订锚点：保留旧版本，并把受影响的单元范围一并迁移。
   */
  reviseAnchor(
    witnessId: string,
    oldRange: { start: number; end: number },
    newRange: { start: number; end: number; label?: string },
    ctx: CommitContext,
  ): CommitResult {
    checkRevision(this.state, ctx, 'anchor.revise', { witnessId, oldRange, newRange });
    this.witness(witnessId);
    const oldAnchor: Anchor = { witnessId, start: oldRange.start, end: oldRange.end };
    const affected = this.state.units.filter(
      (u) =>
        u.anchors.some(
          (a) => a.witnessId === witnessId && a.start === oldRange.start && a.end === oldRange.end,
        ),
    );
    const newAnchor: Anchor = {
      witnessId,
      start: newRange.start,
      end: newRange.end,
      label: newRange.label,
    };
    for (const unit of this.state.units) {
      for (const anchor of unit.anchors) {
        if (anchor.witnessId === witnessId && anchor.start === oldRange.start && anchor.end === oldRange.end) {
          anchor.start = newRange.start;
          anchor.end = newRange.end;
          anchor.label = newRange.label ?? anchor.label;
        }
      }
    }
    const event = logEvent(
      this.state,
      ctx,
      'anchor.revise',
      `修订见证 ${witnessId} 锚点 [${oldRange.start},${oldRange.end}) → [${newRange.start},${newRange.end})，影响 ${affected.length} 个单元`,
      oldAnchor,
      newAnchor,
      affected.map((u) => u.id),
    );
    return { state: this.state, event };
  }

  setElementPolicy(qname: string, policy: 'keep' | 'unwrap', ctx: CommitContext): CommitResult {
    checkRevision(this.state, ctx, 'policy.update', { qname, policy });
    const before = this.state.elementPolicy[qname] ?? null;
    this.state.elementPolicy[qname] = policy;
    const event = logEvent(
      this.state,
      ctx,
      'policy.update',
      `登记未知元素策略 ${qname} = ${policy}`,
      { qname, policy: before },
      { qname, policy },
      [],
    );
    return { state: this.state, event };
  }
}
