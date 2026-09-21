import './style.css';
import { api, actor } from './api.js';

type View = 'import' | 'align' | 'overlap' | 'units' | 'history' | 'export' | 'roundtrip';

interface App {
  view: View;
  state: any;
  events: any[];
  views: Record<string, any>;
  selection: Record<string, { start: number; end: number } | undefined>;
  selectedReadings: Record<string, string>;
  message: string;
  error: boolean;
}

const app: App = {
  view: 'import', state: { version: 0, witnesses: {}, anchors: {}, units: {}, conflicts: {} },
  events: [], views: {}, selection: {}, selectedReadings: {}, message: '', error: false
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char] as string));
}

function toast(message: string, error = false): void {
  app.message = message;
  app.error = error;
  render();
  setTimeout(() => { if (app.message === message) { app.message = ''; render(); } }, 5200);
}

async function refresh(): Promise<void> {
  const data = await api<{ state: any; events: any[] }>('state');
  app.state = data.state;
  app.events = data.events;
  await loadViews();
  render();
}

async function loadViews(): Promise<void> {
  const active = Object.values(app.state.witnesses).filter((w: any) => !w.deleted);
  await Promise.all(active.map(async (witness: any) => {
    if (!app.views[witness.id]) app.views[witness.id] = await api(`witnesses/${witness.id}/view`);
  }));
}

function requestOptions(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify({ ...(body as object), baseVersion: app.state.version, actor }), headers: { 'content-type': 'application/json' } };
}

function activeWitnesses(): any[] {
  return Object.values(app.state.witnesses).filter((w: any) => !w.deleted);
}

function anchorsForWitness(witnessId: string): any[] {
  return Object.values(app.state.anchors).filter((anchor: any) => anchor.witnessId === witnessId);
}

function unitsForWitness(witnessId: string): any[] {
  return Object.values(app.state.units).filter((unit: any) => Boolean(unit.readings[witnessId]));
}

function rangeStatus(witnessId: string, range: { start: number; end: number }): string {
  const sameUnits = unitsForWitness(witnessId);
  for (const unit of sameUnits) {
    const reading = unit.readings[witnessId];
    const other = app.state.anchors[reading.anchorId].current.range;
    const contains = range.start <= other.start && other.end <= range.end || other.start <= range.start && range.end <= other.end;
    const equal = range.start === other.start && range.end === other.end;
    if (contains && !equal) return 'contain';
  }
  for (const unit of sameUnits) {
    const reading = unit.readings[witnessId];
    const other = app.state.anchors[reading.anchorId].current.range;
    if (range.start < other.end && other.start < range.end) return 'overlap';
  }
  return 'unit';
}

function highlightedText(witnessId: string): string {
  const view = app.views[witnessId];
  if (!view) return '';
  const chars = Array.from(view.text) as string[];
  const marks: Array<[number, number, string, string]> = [];
  anchorsForWitness(witnessId).forEach((anchor: any) => {
    marks.push([anchor.current.range.start, anchor.current.range.end, rangeStatus(witnessId, anchor.current.range), anchor.label]);
  });
  marks.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]) || a[0] - b[0] || a[1] - b[1]);
  const open: Array<[string, string]>[] = chars.map(() => []);
  const close: string[][] = chars.map(() => []);
  marks.forEach(([start, end, kind, label]) => {
    open[start]?.push([kind, label]);
    close[end - 1]?.push('</span>');
  });
  return chars.map((char, index) => {
    const starts = (open[index] || []).map(([kind, label]) => `<span class="marker ${kind}" title="${esc(label)}">`).join('');
    return starts + esc(char) + (close[index] || []).join('');
  }).join('');
}

function captureSelection(witnessId: string, container: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !container.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = Array.from(before.toString()).length;
  const end = start + Array.from(range.toString()).length;
  if (end > start) {
    app.selection[witnessId] = { start, end };
    const snippet = Array.from(range.toString()).join('').slice(0, 24);
    toast(`已选码位 ${start}–${end}：${snippet}`);
  }
}
import { renderImport, renderAlign, renderOverlap } from './views.js';
import { renderUnits, renderHistory } from './views2.js';
import { renderExport, renderRoundtrip } from './views3.js';

let preflightResult: any;
let roundtripResult: any;

const tabs: Array<[View, string]> = [
  ['import', '见证导入'], ['align', '锚点对齐'], ['overlap', '交叠区间'],
  ['units', '校勘单元'], ['history', '版本历史'], ['export', '导出预检'], ['roundtrip', '往返核验']
];

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value || '';
}

function render(): void {
  const root = document.getElementById('app')!;
  const body = {
    import: renderImport, align: renderAlign, overlap: renderOverlap,
    units: renderUnits, history: renderHistory,
    export: () => renderExport(app, preflightResult), roundtrip: () => renderRoundtrip(app, roundtripResult)
  }[app.view](app);
  root.innerHTML = `<header><h1>异文织机</h1><p>本地 XML 见证校勘工作台 · 当前项目版本 v${app.state.version}</p></header>
  <nav>${tabs.map(([view, label]) => `<button class="${app.view === view ? 'active' : ''}" data-tab="${view}">${label}</button>`).join('')}</nav>
  <main>${body}${app.message ? `<div class="toast ${app.error ? 'error' : ''}">${esc(app.message)}</div>` : ''}</main>`;
  bind();
}

function sampleXml(name: string, body: string, extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><TEI xmlns="http://www.tei-c.org/ns/1.0" xmlns:ed="http://example.org/editor"><teiHeader><fileDesc><titleStmt><title>${name}</title></titleStmt><publicationStmt ed:sig="A">local</publicationStmt><sourceDesc><p>source</p></sourceDesc></fileDesc></teiHeader><text><body>${body}${extra}</body></text></TEI>`;
}

function readingsFromForm(): Record<string, any> {
  const readings: Record<string, any> = {};
  activeWitnesses().forEach(witness => {
    const anchorId = value(`reading-anchor-${witness.id}`);
    const status = value(`status-${witness.id}`) as any;
    const text = value(`reading-${witness.id}`);
    const rawFragments = value(`fragments-${witness.id}`);
    if (!anchorId || !text) return;
    readings[witness.id] = {
      anchorId, status, text,
      fragments: rawFragments ? JSON.parse(rawFragments) : undefined,
      judgment: status === 'editorial' ? text : undefined
    };
  });
  return readings;
}

async function handleAction(action: string, id: string): Promise<void> {
  try {
    if (action === 'fill-sample') {
      (document.getElementById('witness-name') as HTMLInputElement).value = '甲本';
      (document.getElementById('witness-file') as HTMLInputElement).value = 'a.xml';
      (document.getElementById('witness-xml') as HTMLTextAreaElement).value = sampleXml('甲本', '<pb n="1r"/><p ed:hand="main">子曰學而時習之</p><p>不亦說乎</p>');
      toast('已填入甲本；可再导入乙本示例。');
      return;
    }
    if (action === 'import-witness') {
      await api('witnesses', requestOptions('POST', {
        name: value('witness-name'), filename: value('witness-file'), raw: value('witness-xml')
      }));
      await refresh(); toast('原始 XML 已原样保存，派生视图已建立。'); return;
    }
    if (action === 'delete-witness') {
      const reason = window.prompt('删除原因（原件仍会保留在 data/raw）', '完成核校');
      if (reason === null) return;
      await api(`witnesses/${id}`, requestOptions('DELETE', { reason }));
      await refresh(); toast('见证已标记删除，原件保留。'); return;
    }
    if (action === 'add-anchor') {
      const range = app.selection[id];
      if (!range) throw new Error('请先在该见证正文中拖选字符范围');
      await api('anchors', requestOptions('POST', {
        witnessId: id, range, groupId: value(`group-${id}`) || `manual-${range.start}-${range.end}`,
        label: value(`label-${id}`) || `手工锚点 ${range.start}-${range.end}`
      }));
      await refresh(); toast('对齐锚点已保存。'); return;
    }
    if (action === 'show-raw') {
      const raw = await api<string>(`witnesses/${id}/raw`);
      const status = document.getElementById(`raw-status-${id}`);
      if (status) status.innerHTML = `<pre>${esc(raw)}</pre>`;
      return;
    }
    if (action === 'create-unit') {
      const readings = readingsFromForm();
      if (!Object.keys(readings).length) throw new Error('请至少填写一个见证的录文');
      await api('units', requestOptions('POST', { label: value('unit-label') || `单元 ${Object.keys(app.state.units).length + 1}`, readings }));
      await refresh(); toast('校勘单元已建立；交叠几何已通过服务端校验。'); return;
    }
    if (action === 'revise-anchor') {
      const range = { start: Number(value(`rev-start-${id}`)), end: Number(value(`rev-end-${id}`)) };
      await api(`anchors/${id}`, requestOptions('PATCH', { range, reason: value(`rev-reason-${id}`) || '编辑修订' }));
      await refresh(); toast('锚点已修订，旧版本和受影响单元清单已保留。'); return;
    }
    if (action === 'resolve-conflict') {
      await api(`conflicts/${id}/resolve`, requestOptions('POST', {}));
      await refresh(); toast('冲突已标记为人工处理。'); return;
    }
    if (action === 'run-preflight') {
      preflightResult = await api('export/preview', requestOptions('POST', {}));
      roundtripResult = undefined; render();
      toast(preflightResult.issues.some((i: any) => i.severity === 'blocker') ? '预检发现阻断项，导出已阻止。' : '预检通过，可以导出。', preflightResult.issues.length > 0);
      return;
    }
    if (action === 'do-export') {
      const result = await api('export', requestOptions('POST', {}));
      preflightResult = { xml: result.xml, issues: [] };
      await refresh(); preflightResult = { xml: result.xml, issues: [] }; render();
      toast(`导出成功，事件 ${result.event.id} 已进入历史。`); return;
    }
    if (action === 'run-roundtrip' || action === 'parse-export-xml') {
      const body = action === 'parse-export-xml' ? { exportedXml: value('manual-export') } : { exportedXml: preflightResult?.xml };
      roundtripResult = await api('roundtrip', requestOptions('POST', body));
      render(); toast('往返核验完成，差异均带事件追踪。'); return;
    }
  } catch (error: any) {
    let message = error.message;
    if (error.references?.length) message += '：' + error.references.map((ref: any) => `${ref.unitId}(${ref.snippet})`).join('、');
    if (error.conflictId) message += ` 冲突记录：${error.conflictId}`;
    toast(message, true);
  }
}

function bind(): void {
  document.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => { app.view = (button as HTMLElement).dataset.tab as View; render(); });
  });
  document.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', () => handleAction((button as HTMLElement).dataset.action!, (button as HTMLElement).dataset.id || ''));
  });
  document.querySelectorAll('[data-reader]').forEach(element => {
    element.addEventListener('mouseup', () => captureSelection((element as HTMLElement).dataset.reader!, element as HTMLElement));
  });
  document.getElementById('witness-upload')?.addEventListener('change', async event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    (document.getElementById('witness-name') as HTMLInputElement).value = file.name.replace(/\.xml$/i, '');
    (document.getElementById('witness-file') as HTMLInputElement).value = file.name;
    (document.getElementById('witness-xml') as HTMLTextAreaElement).value = await file.text();
    toast('已读取文件；点击导入后才会写入项目目录。');
  });
}

refresh().catch(error => toast(error.message, true));
