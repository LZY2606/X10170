import fs from 'node:fs';
import path from 'node:path';
import {
  Anchor,
  CollationUnit,
  EditEvent,
  ProjectData,
  Range,
  Reading,
  Witness,
  emptyProject,
} from './model';
import { parseXml } from './xml';
import { DerivedText, deriveText } from './text';

export class ValidationError extends Error {
  constructor(
    message: string,
    public details: unknown = undefined,
  ) {
    super(message);
  }
}

export interface ConflictPayload {
  entity: 'unit' | 'anchor';
  id: string;
  baseVersion: number;
  currentVersion: number;
  current: unknown;
  incoming: unknown;
  /** 双方各自的范围与文本片段，供页面并排展示 */
  currentFragments: string[];
  incomingFragments: string[];
}

export class ConflictError extends Error {
  constructor(public payload: ConflictPayload) {
    super('版本冲突：他人已修改，拒绝覆盖');
  }
}

export class WitnessInUseError extends Error {
  constructor(public referencingUnits: { id: string; label: string }[]) {
    super('该见证仍被校勘单元引用');
  }
}

export class ProjectStore {
  data: ProjectData = emptyProject();
  private file: string;
  private derivedCache = new Map<string, DerivedText>();

  constructor(private dir: string) {
    this.file = path.join(dir, 'project.json');
  }

  load(): void {
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ProjectData;
    }
    this.derivedCache.clear();
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  private nextId(prefix: string): string {
    const n = (this.data.counters[prefix] ?? 0) + 1;
    this.data.counters[prefix] = n;
    return `${prefix}${n}`;
  }

  private event(e: Omit<EditEvent, 'id' | 'at'>): EditEvent {
    const ev: EditEvent = { ...e, id: this.nextId('e'), at: new Date().toISOString() };
    this.data.events.push(ev);
    return ev;
  }

  // ---- 见证 ----

  addWitness(name: string, rawXml: string): Witness {
    if (!rawXml.trim()) throw new ValidationError('XML 内容为空');
    const { issues } = parseXml(rawXml);
    if (issues.length) {
      throw new ValidationError('XML 解析失败', issues);
    }
    const w: Witness = {
      id: this.nextId('w'),
      name: name || `见证 ${this.data.witnesses.length + 1}`,
      rawXml,
      addedAt: new Date().toISOString(),
    };
    this.data.witnesses.push(w);
    this.event({ kind: 'witness-added', summary: `导入见证 ${w.name}`, witnessId: w.id });
    this.save();
    return w;
  }

  removeWitness(id: string, force = false): void {
    const w = this.data.witnesses.find((x) => x.id === id);
    if (!w) throw new ValidationError(`见证不存在: ${id}`);
    const referencing = this.data.units
      .filter((u) => u.readings.some((r) => r.witnessId === id))
      .map((u) => ({ id: u.id, label: u.label }));
    if (referencing.length && !force) throw new WitnessInUseError(referencing);
    for (const u of this.data.units) {
      u.readings = u.readings.filter((r) => r.witnessId !== id);
    }
    this.data.anchors = this.data.anchors.filter((a) => a.witnessId !== id);
    this.data.witnesses = this.data.witnesses.filter((x) => x.id !== id);
    this.derivedCache.delete(id);
    this.event({
      kind: 'witness-removed',
      summary: `删除见证 ${w.name}${referencing.length ? `（解除 ${referencing.length} 个单元引用）` : ''}`,
      witnessId: id,
    });
    this.save();
  }

  // ---- 派生视图 ----

  derivedOf(witnessId: string): DerivedText {
    const cached = this.derivedCache.get(witnessId);
    if (cached) return cached;
    const w = this.data.witnesses.find((x) => x.id === witnessId);
    if (!w) throw new ValidationError(`见证不存在: ${witnessId}`);
    const { nodes } = parseXml(w.rawXml);
    const d = deriveText(nodes);
    this.derivedCache.set(witnessId, d);
    return d;
  }

  fragment(witnessId: string, range: Range): string {
    const d = this.derivedOf(witnessId);
    return d.text.slice(range.start, range.end);
  }

  private assertRange(witnessId: string, range: Range): void {
    const d = this.derivedOf(witnessId);
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end > d.text.length ||
      range.start >= range.end
    ) {
      throw new ValidationError(`非法区间 [${range.start}, ${range.end})，文本长度 ${d.text.length}`);
    }
  }

  // ---- 锚点 ----

  addAnchor(witnessId: string, start: number, end: number): Anchor {
    this.assertRange(witnessId, { start, end });
    const a: Anchor = {
      id: this.nextId('a'),
      witnessId,
      start,
      end,
      version: 1,
      history: [],
    };
    this.data.anchors.push(a);
    this.event({
      kind: 'anchor-created',
      summary: `创建锚点 ${a.id} [${start}, ${end})`,
      witnessId,
      anchorId: a.id,
      range: { start, end },
    });
    this.save();
    return a;
  }

  reviseAnchor(id: string, start: number, end: number, baseVersion: number): { anchor: Anchor; affectedUnits: CollationUnit[] } {
    const a = this.data.anchors.find((x) => x.id === id);
    if (!a) throw new ValidationError(`锚点不存在: ${id}`);
    if (a.version !== baseVersion) {
      throw new ConflictError({
        entity: 'anchor',
        id,
        baseVersion,
        currentVersion: a.version,
        current: { start: a.start, end: a.end },
        incoming: { start, end },
        currentFragments: [this.fragment(a.witnessId, { start: a.start, end: a.end })],
        incomingFragments: this.safeFragment(a.witnessId, start, end),
      });
    }
    this.assertRange(a.witnessId, { start, end });
    a.history.push({ start: a.start, end: a.end, version: a.version, at: new Date().toISOString() });
    a.start = start;
    a.end = end;
    a.version += 1;
    const affectedUnits = this.data.units.filter((u) =>
      u.readings.some(
        (r) =>
          r.anchorId === id ||
          (r.witnessId === a.witnessId && r.range && r.range.start < end && start < r.range.end),
      ),
    );
    this.event({
      kind: 'anchor-revised',
      summary: `修订锚点 ${id} → [${start}, ${end})，影响 ${affectedUnits.length} 个单元`,
      witnessId: a.witnessId,
      anchorId: id,
      range: { start, end },
      affectedUnitIds: affectedUnits.map((u) => u.id),
    });
    this.save();
    return { anchor: a, affectedUnits };
  }

  private safeFragment(witnessId: string, start: number, end: number): string[] {
    try {
      this.assertRange(witnessId, { start, end });
      return [this.fragment(witnessId, { start, end })];
    } catch {
      return ['(区间越界)'];
    }
  }

  // ---- 校勘单元 ----

  private validateReadings(readings: Reading[]): void {
    if (!readings.length) throw new ValidationError('单元至少需要一条读法');
    for (const r of readings) {
      if (!this.data.witnesses.some((w) => w.id === r.witnessId)) {
        throw new ValidationError(`读法引用了不存在的见证: ${r.witnessId}`);
      }
      if (r.type === 'omission') continue;
      if (!r.range) throw new ValidationError(`见证 ${r.witnessId} 的读法缺少区间`);
      this.assertRange(r.witnessId, r.range);
      if (r.type === 'transposition') {
        if (!r.parts || r.parts.length < 2) {
          throw new ValidationError('异序读法需要至少两个子区间（parts）');
        }
        for (const p of r.parts) {
          if (p.start < r.range.start || p.end > r.range.end || p.start >= p.end) {
            throw new ValidationError('异序子区间必须落在读法区间内');
          }
        }
      }
    }
  }

  /** 交叠允许；同一见证内一个单元完全包含另一个单元的锚点区间则拒绝 */
  private checkContainment(candidateId: string, readings: Reading[]): void {
    for (const r of readings) {
      if (!r.range) continue;
      for (const u of this.data.units) {
        if (u.id === candidateId) continue;
        for (const er of u.readings) {
          if (er.witnessId !== r.witnessId || !er.range) continue;
          const a = r.range;
          const b = er.range;
          const overlaps = a.start < b.end && b.start < a.end;
          if (!overlaps) continue;
          const contains =
            (a.start <= b.start && a.end >= b.end) || (b.start <= a.start && b.end >= a.end);
          if (contains) {
            throw new ValidationError(
              `与单元「${u.label}」在见证 ${r.witnessId} 上的锚点区间互相包含 [${a.start},${a.end}) vs [${b.start},${b.end})`,
            );
          }
        }
      }
    }
  }

  addUnit(label: string, readings: Reading[]): CollationUnit {
    this.validateReadings(readings);
    this.checkContainment('', readings);
    const now = new Date().toISOString();
    const u: CollationUnit = {
      id: this.nextId('u'),
      label: label || `单元 ${this.data.units.length + 1}`,
      readings,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.data.units.push(u);
    const first = readings.find((r) => r.range);
    this.event({
      kind: 'unit-created',
      summary: `创建单元 ${u.label}`,
      unitId: u.id,
      witnessId: first?.witnessId,
      range: first?.range,
    });
    this.save();
    return u;
  }

  updateUnit(id: string, updates: { label?: string; readings?: Reading[] }, baseVersion: number): CollationUnit {
    const u = this.data.units.find((x) => x.id === id);
    if (!u) throw new ValidationError(`单元不存在: ${id}`);
    if (u.version !== baseVersion) {
      throw new ConflictError({
        entity: 'unit',
        id,
        baseVersion,
        currentVersion: u.version,
        current: u,
        incoming: updates,
        currentFragments: u.readings.map((r) => this.readingFragment(r)),
        incomingFragments: (updates.readings ?? []).map((r) => this.readingFragment(r)),
      });
    }
    const nextReadings = updates.readings ?? u.readings;
    this.validateReadings(nextReadings);
    this.checkContainment(id, nextReadings);
    if (updates.label !== undefined) u.label = updates.label;
    u.readings = nextReadings;
    u.version += 1;
    u.updatedAt = new Date().toISOString();
    const first = u.readings.find((r) => r.range);
    this.event({
      kind: 'unit-updated',
      summary: `更新单元 ${u.label}（v${u.version}）`,
      unitId: u.id,
      witnessId: first?.witnessId,
      range: first?.range,
    });
    this.save();
    return u;
  }

  deleteUnit(id: string): void {
    const u = this.data.units.find((x) => x.id === id);
    if (!u) throw new ValidationError(`单元不存在: ${id}`);
    this.data.units = this.data.units.filter((x) => x.id !== id);
    this.event({ kind: 'unit-deleted', summary: `删除单元 ${u.label}`, unitId: id });
    this.save();
  }

  readingFragment(r: Reading): string {
    if (r.type === 'omission' || !r.range) return '∅（缺文）';
    if (r.type === 'transposition' && r.parts?.length) {
      return r.parts.map((p) => this.fragment(r.witnessId, p)).join('');
    }
    return this.fragment(r.witnessId, r.range);
  }
}
