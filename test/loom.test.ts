import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LoomStore } from '../src/core/store.js';
import { exportApparatus, buildNormalizedView } from '../src/core/xml.js';
import { classifyRoundTrip } from '../src/core/roundtrip.js';

const dirs: string[] = [];
async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-'));
  dirs.push(dir);
  return { dir, store: await LoomStore.open(dir) };
}

const tei = (label: string, body: string, declaration = '<?xml version="1.0" encoding="UTF-8"?>') =>
  `${declaration}<TEI xmlns="http://www.tei-c.org/ns/1.0" xmlns:ed="http://example.org/editor"><teiHeader><fileDesc><titleStmt><title>${label}</title></titleStmt><publicationStmt ed:hand="h1">  local text  </publicationStmt><sourceDesc><p/></sourceDesc></fileDesc></teiHeader><text><body>${body}</body></text></TEI>`;

async function importPair(store: LoomStore) {
  const a = await store.importWitness({
    name: '甲本', filename: 'a.xml',
    raw: tei('甲本', '<pb n="1r"/><p>子曰學而時習之</p><p>不亦說乎</p>')
  }, { baseVersion: 0, actor: 'A' });
  const b = await store.importWitness({
    name: '乙本', filename: 'b.xml',
    raw: tei('乙本', '<p>子曰學而時習之</p><p>不亦說乎</p>', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
  }, { baseVersion: 1, actor: 'A' });
  await store.importWitness({
    name: '丙本实体', filename: 'c.xml',
    raw: tei('丙&#x672c;', '<p>实体词法</p>')
  }, { baseVersion: 2, actor: 'A' });
  await store.importWitness({
    name: '丁本属性序', filename: 'd.xml',
    raw: tei('丁本', '<p n="D1" type="variant" ed:order="9">属性顺序</p>')
  }, { baseVersion: 3, actor: 'A' });
  const state = store.getState();
  return { a, b, witnesses: Object.values(state.witnesses), anchors: Object.values(state.anchors) };
}

async function manualAnchor(store: LoomStore, witnessId: string, label: string, range: { start: number; end: number }): Promise<string> {
  await store.addAnchor({ witnessId, groupId: label, label, range }, { baseVersion: store.getState().version, actor: 'A' });
  const anchor = Object.values(store.getState().anchors).find(item => item.witnessId === witnessId && item.label === label);
  if (!anchor) throw new Error('manual anchor missing');
  return anchor.id;
}

afterEach(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

describe('XML witnesses', () => {
  it('preserves namespaces, attributes, whitespace and combining code points in derived views', async () => {
    const { dir, store } = await tempStore();
    const raw = tei('甲本', '<p ed:mark="x">e\u0301  子曰</p>');
    await store.importWitness({ name: '甲', filename: 'a.xml', raw }, { baseVersion: 0, actor: 'A' });
    const witness = store.getState().witnesses;
    const id = Object.keys(witness)[0];
    const view = store.getView(id);
    expect(view.text).toContain('e\u0301  子曰');
    expect(view.text.includes('e\u0301')).toBe(true);
    expect(await readFile(join(dir, witness[id].rawPath), 'utf8')).toBe(raw);
    expect(exportApparatus({
      witnesses: [{ id, name: '甲', raw }], units: [], anchorRanges: () => undefined,
      eventIdForUnit: () => undefined, exportEventId: 'evt-export'
    }).xml).toContain('ed:mark="x"');
  });

  it('supports anchors spanning multiple elements and detects textual unknown structures with locations', () => {
    const raw = tei('甲', '<p>甲乙</p><collation:gap xmlns:collation="http://example.org/x"/>');
    const view = buildNormalizedView(raw, 'w1');
    expect(view.segments.length).toBeGreaterThan(1);
    expect(view.text.slice(view.segments[0].start)).toContain('甲乙');
    const issue = view.issues.find(item => item.localName === 'gap');
    expect(issue?.path).toContain(':gap');
    expect(issue?.severity).toBe('blocker');
  });
});

describe('collation geometry and readings', () => {
  it('allows crossing overlap but rejects containment between units in one witness', async () => {
    const { store } = await tempStore();
    const { witnesses } = await importPair(store);
    const [a, b] = witnesses;
    const anchor1 = await store.addAnchor({ witnessId: a.id, groupId: 'g1', label: 'A1', range: { start: 0, end: 8 } }, { baseVersion: store.getState().version, actor: 'A' });
    const anchor2 = await store.addAnchor({ witnessId: a.id, groupId: 'g2', label: 'A2', range: { start: 5, end: 12 } }, { baseVersion: store.getState().version, actor: 'A' });
    const anchorB = await store.addAnchor({ witnessId: b.id, groupId: 'g1', label: 'B1', range: { start: 0, end: 8 } }, { baseVersion: store.getState().version, actor: 'A' });
    const ids = Object.keys(store.getState().anchors);
    const id1 = (anchor1.payload as any).anchor.id;
    const id2 = (anchor2.payload as any).anchor.id;
    const idB = (anchorB.payload as any).anchor.id;
    expect(ids).toContain(id1);
    await store.createUnit('U1', { [a.id]: { anchorId: id1, status: 'original', text: ' crossing ' }, [b.id]: { anchorId: idB, status: 'original', text: 'x' } }, { baseVersion: store.getState().version, actor: 'A' });
    await store.createUnit('U2', { [a.id]: { anchorId: id2, status: 'original', text: 'crossing overlap' } }, { baseVersion: store.getState().version, actor: 'A' });
    const anchor3 = await store.addAnchor({ witnessId: a.id, groupId: 'g3', label: 'A3', range: { start: 2, end: 4 } }, { baseVersion: store.getState().version, actor: 'A' });
    const id3 = (anchor3.payload as any).anchor.id;
    await expect(store.createUnit('U3', { [a.id]: { anchorId: id3, status: 'original', text: 'contained crossing' } }, { baseVersion: store.getState().version, actor: 'A' })).rejects.toThrow(/不能互相包含|错误包含/);
  });

  it('records reversed transposition fragments, lacuna and editorial judgments', async () => {
    const { store } = await tempStore();
    const { witnesses } = await importPair(store);
    const a = witnesses[0];
    const anchorId = await manualAnchor(store, a.id, '倒', { start: 0, end: 7 });
    await store.createUnit('倒置', {
      [a.id]: {
        anchorId, status: 'transposition', text: '丙丁甲乙',
        fragments: [{ text: '甲乙', order: 2, reversed: true }, { text: '丙丁', order: 1 }],
        judgment: '乙本将后段倒置于前'
      }
    }, { baseVersion: store.getState().version, actor: 'A' });
    const state = store.getState();
    const unit = Object.values(state.units)[0];
    expect(unit.readings[a.id].fragments).toEqual([
      { text: '甲乙', order: 2, reversed: true }, { text: '丙丁', order: 1 }
    ]);
  });
});

describe('history, deletion, persistence and conflicts', () => {
  it('retains anchor revisions, affected units, references before deletion, and restores', async () => {
    const { dir, store } = await tempStore();
    const { witnesses } = await importPair(store);
    const a = witnesses[0];
    const anchorId = await manualAnchor(store, a.id, 'A', { start: 0, end: 5 });
    await store.createUnit('U', { [a.id]: { anchorId, status: 'lacuna', text: '缺三字' } }, { baseVersion: store.getState().version, actor: 'A' });
    await store.reviseAnchor(anchorId, { start: 1, end: 6 }, '页码校正', { baseVersion: store.getState().version, actor: 'A' });
    expect(store.getState().anchors[anchorId].history[0].range).toEqual({ start: 0, end: 5 });
    expect(store.getState().anchors[anchorId].current.affectedUnitIds).toHaveLength(1);
    await expect(store.deleteWitness(a.id, 'remove', { baseVersion: store.getState().version, actor: 'A' })).rejects.toMatchObject({ references: expect.arrayContaining([expect.objectContaining({ snippet: '缺三字' })]) });
    const reopened = await LoomStore.open(dir);
    expect(reopened.getState().version).toBe(store.getState().version);
    expect(reopened.getState().anchors[anchorId].history).toHaveLength(1);
    expect(await reopened.getRaw(a.id)).toContain('子曰');
  });

  it('records a conflict with both ranges and snippets instead of last-write overwrite', async () => {
    const { store } = await tempStore();
    const { witnesses } = await importPair(store);
    const a = witnesses[0];
    await store.addAnchor({ witnessId: a.id, groupId: 'g1', label: 'first', range: { start: 0, end: 5 } }, { baseVersion: store.getState().version, actor: 'A' });
    const staleVersion = store.getState().version;
    const firstId = await manualAnchor(store, a.id, 'first', { start: 0, end: 5 });
    await store.addAnchor({ witnessId: a.id, groupId: 'g2', label: 'second', range: { start: 6, end: 9 } }, { baseVersion: store.getState().version, actor: 'B' });
    await expect(store.reviseAnchor(firstId, { start: 1, end: 4 }, 'stale edit', { baseVersion: staleVersion, actor: 'C' })).rejects.toMatchObject({ status: 409 });
    const conflict = Object.values(store.getState().conflicts)[0];
    expect(conflict.incoming.ranges[0].snippet).toBeTruthy();
    expect(conflict.existing.ranges[0].snippet).toBeTruthy();
    expect(store.getState().anchors[firstId].current.range).toEqual({ start: 0, end: 5 });
  });
});

describe('export and round trip', () => {
  it('blocks unknown nodes and otherwise classifies lexical, known and unacceptable changes', async () => {
    const { store } = await tempStore();
    const { witnesses } = await importPair(store);
    const [a, b] = witnesses;
    const idA = await manualAnchor(store, a.id, 'A', { start: 0, end: 4 });
    const idB = await manualAnchor(store, b.id, 'B', { start: 0, end: 4 });
    const unitEvent = await store.createUnit('U', {
      [a.id]: { anchorId: idA, status: 'original', text: '子曰' },
      [b.id]: { anchorId: idB, status: 'editorial', text: '当作子曰', judgment: '当作子曰' }
    }, { baseVersion: store.getState().version, actor: 'A' });

    const unknownRaw = tei('丙', '<p>丙</p><mystery xmlns="urn:unknown">勿失</mystery>');
    const blocked = exportApparatus({
      witnesses: [{ id: 'c', name: '丙', raw: unknownRaw }], units: [],
      anchorRanges: () => undefined, eventIdForUnit: () => undefined, exportEventId: 'preview'
    });
    expect(blocked.xml).toBeUndefined();
    expect(blocked.issues[0].path).toContain('mystery');

    const witnessesById = Object.values(store.getState().witnesses);
    const c = witnessesById.find(w => w.filename === 'c.xml')!;
    const d = witnessesById.find(w => w.filename === 'd.xml')!;
    const rawA = await store.getRaw(a.id);
    const rawB = await store.getRaw(b.id);
    const rawC = await store.getRaw(c.id);
    const rawD = await store.getRaw(d.id);
    const exported = exportApparatus({
      witnesses: [{ id: a.id, name: a.name, raw: rawA }, { id: b.id, name: b.name, raw: rawB }, { id: c.id, name: c.name, raw: rawC }, { id: d.id, name: d.name, raw: rawD }],
      units: Object.values(store.getState().units),
      anchorRanges: anchorId => store.getState().anchors[anchorId]?.current.range,
      eventIdForUnit: () => unitEvent.id,
      exportEventId: 'evt-export'
    });
    expect(exported.issues).toEqual([]);
    const xml = exported.xml!;
    expect(xml).toContain('<source witness="');
    expect(xml).toContain('sourceEvent');
    const diffs = classifyRoundTrip({ originals: [{ witnessId: a.id, raw: rawA }, { witnessId: b.id, raw: rawB }, { witnessId: c.id, raw: rawC }], exportedXml: xml, exportEventId: 'evt-export', events: store.getEvents() });
    expect(diffs.some(d => d.classification === 'known-edit' && d.eventId === unitEvent.id)).toBe(true);
    expect(diffs.some(d => d.classification === 'lexical-only' && d.witnessId === b.id)).toBe(true);
    expect(diffs.some(d => d.classification === 'lexical-only' && d.witnessId === c.id && d.explanation.includes('实体'))).toBe(true);
    expect(xml).toContain('n="D1" type="variant" ed:order="9"');
    const damaged = xml.replace('不亦說乎', '不亦樂乎');
    const damagedDiffs = classifyRoundTrip({ originals: [{ witnessId: a.id, raw: rawA }, { witnessId: b.id, raw: rawB }, { witnessId: c.id, raw: rawC }], exportedXml: damaged, exportEventId: 'evt-export', events: store.getEvents() });
    expect(damagedDiffs.some(d => d.classification === 'unacceptable-loss')).toBe(true);
  });
});
