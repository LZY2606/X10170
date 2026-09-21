import './styles.css';
import {
  api,
  ApiError,
  type AnchorDto,
  type EditEventDto,
  type FragmentDto,
  type ReadingDto,
  type StateSnapshot,
  type UnitDto,
  type WitnessDetail,
} from './api.js';

type TabId = 'import' | 'align' | 'overlap' | 'units' | 'history' | 'export' | 'roundtrip';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'import', label: '见证导入' },
  { id: 'align', label: '锚点对齐' },
  { id: 'overlap', label: '交叠区间' },
  { id: 'units', label: '校勘单元' },
  { id: 'history', label: '版本历史' },
  { id: 'export', label: '导出预检' },
  { id: 'roundtrip', label: '往返核验' },
];

interface AppState {
  snapshot: StateSnapshot | null;
  details: Map<string, WitnessDetail>;
  tab: TabId;
  editor: string;
  /** 每个见证当前“正在框选”的临时锚点 */
  draft: Map<string, { start: number; end: number }>;
  /** 建单元时勾选的锚点 witness 集合（默认全部） */
  selectedWitnesses: Set<string>;
}

const state: AppState = {
  snapshot: null,
  details: new Map(),
  tab: 'import',
  editor: localStorage.getItem('loom-editor') || '编者甲',
  draft: new Map(),
  selectedWitnesses: new Set(),
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

async function refresh(): Promise<void> {
  state.snapshot = await api.state();
  for (const witness of state.snapshot.witnesses) {
    if (!state.details.has(witness.id)) {
      state.details.set(witness.id, await api.witness(witness.id));
    }
  }
  render();
}

async function mutate(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    await refresh();
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      showConflict((err.body as { error: { detail: Parameters<typeof showConflict>[0] } }).error.detail);
      await refresh();
    } else {
      toast(err instanceof Error ? err.message : String(err), 'err');
    }
    return false;
  }
}

function showConflict(detail: {
  baseRevision: number;
  currentRevision: number;
  attemptedBy: string;
  attemptedKind: string;
  attemptedAfter: unknown;
  interveningEvents: EditEventDto[];
}): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>修订冲突：拒绝以最后保存覆盖</h3>
      <p>提交者 <b>${esc(detail.attemptedBy)}</b> 基于版本 r${detail.baseRevision} 执行
      <code>${esc(detail.attemptedKind)}</code>，但项目当前已是 r${detail.currentRevision}。</p>
      <div class="conflict-block">
        <b>你的范围与片段</b>
        <pre class="raw">${esc(safeStringify(detail.attemptedAfter))}</pre>
      </div>
      <div class="conflict-block">
        <b>期间对方提交的范围与文本片段（${detail.interveningEvents.length}）</b>
        ${detail.interveningEvents.map((e) => `
          <div style="margin:6px 0">
            <div>r${e.revision} · ${esc(e.editor)} · ${esc(e.kind)} — ${esc(e.summary)}</div>
            <pre class="raw">范围: ${esc(rangeSummary(e.after))}\n片段: ${esc(snippetOf(e))}</pre>
          </div>`).join('')}
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="secondary" data-close>我知道了，刷新后重新编辑</button>
      </div>
    </div>`;
  backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove());
  document.body.appendChild(backdrop);
}

function rangeSummary(after: unknown): string {
  if (!after || typeof after !== 'object') return '—';
  const a = after as Record<string, unknown>;
  if (typeof a.start === 'number' && typeof a.end === 'number') return `[${a.start},${a.end})`;
  if (Array.isArray(a.anchors)) {
    return (a.anchors as AnchorDto[]).map((x) => `${x.witnessId}:[${x.start},${x.end})`).join(' ');
  }
  if (typeof a.oldStart === 'number') return `[${a.oldStart},${a.oldEnd}) → [${a.newStart},${a.newEnd})`;
  return '—';
}

function snippetOf(event: EditEventDto): string {
  const snapshot = state.snapshot;
  if (!snapshot) return '—';
  const after = event.after as { anchors?: AnchorDto[]; witnessId?: string; start?: number; end?: number } | null;
  const anchors = after?.anchors ?? (after && typeof after.start === 'number'
    ? [{ witnessId: after.witnessId ?? '', start: after.start, end: after.end }]
    : []);
  return anchors.map((an) => {
    const detail = state.details.get(an.witnessId);
    if (!detail) return `${an.witnessId}:（文本未载入）`;
    return `${detail.name}:「${detail.view.text.slice(an.start, an.end)}」`;
  }).join(' / ') || '—';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function render(): void {
  const snap = state.snapshot;
  app.innerHTML = `
    <header class="app-header">
      <h1>异文织机</h1>
      <div class="sub">本地校勘工作台 · 原始 XML 逐字节保存，规范化文本仅为派生视图</div>
    </header>
    <div class="toolbar">
      <div class="tabs">
        ${TABS.map((t) => `<button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>
      <label class="field" style="margin:0">编者
        <input type="text" data-editor value="${esc(state.editor)}" style="width:90px" />
      </label>
      <span class="rev-badge">当前版本：<b>r${snap?.revision ?? 0}</b> · 见证 ${snap?.witnesses.length ?? 0} · 单元 ${snap?.units.length ?? 0}</span>
    </div>
    <main id="tab-root"></main>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab as TabId;
      render();
    }),
  );
  app.querySelector<HTMLInputElement>('[data-editor]')!.addEventListener('input', (e) => {
    state.editor = (e.target as HTMLInputElement).value;
    localStorage.setItem('loom-editor', state.editor);
  });
  const root = app.querySelector<HTMLElement>('#tab-root')!;
  const renderers: Record<TabId, (el: HTMLElement) => void> = {
    import: renderImport,
    align: renderAlign,
    overlap: renderOverlap,
    units: renderUnits,
    history: renderHistory,
    export: renderExport,
    roundtrip: renderRoundtrip,
  };
  renderers[state.tab](root);
}

function renderImport(el: HTMLElement): void {
  const snap = state.snapshot!;
  el.innerHTML = `
    <div class="panel">
      <h2>导入见证（原始 XML 原样落盘）</h2>
      <label class="field">见证名称 <input type="text" data-name placeholder="如：甲本 / 敦煌 P.3456" style="width:240px"/></label>
      <label class="field">粘贴 XML 原文（空白、未知元素、实体写法、属性序全部保留）</label>
      <textarea data-xml placeholder='<?xml version="1.0"?><TEI ...>...</TEI>'></textarea>
      <div class="row" style="margin-top:8px">
        <button data-import>导入</button>
        <span class="muted">服务端会重新解析校验，原文另存于项目目录 .loom-project/raw/</span>
      </div>
    </div>
    <div class="panel">
      <h2>已导入见证</h2>
      <table class="table">
        <thead><tr><th>名称</th><th>sha256</th><th>字节数</th><th>导入时间</th><th>操作</th></tr></thead>
        <tbody>
          ${snap.witnesses.map((w) => `
            <tr>
              <td>${esc(w.name)}</td>
              <td><code>${w.sha256.slice(0, 16)}…</code></td>
              <td>${w.size}</td>
              <td>${new Date(w.importedAt).toLocaleString()}</td>
              <td>
                <button class="secondary" data-raw="${w.id}">查看原文</button>
                <button class="danger" data-del="${w.id}">删除</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  el.querySelector<HTMLButtonElement>('[data-import]')!.addEventListener('click', async () => {
    const name = el.querySelector<HTMLInputElement>('[data-name]')!.value.trim();
    const rawXml = el.querySelector<HTMLTextAreaElement>('[data-xml]')!.value;
    if (!name || !rawXml.trim()) return toast('名称与 XML 不能为空', 'err');
    await mutate(() => api.importWitness({ name, rawXml, editor: state.editor, baseRevision: snap.revision }));
  });
  el.querySelectorAll<HTMLButtonElement>('[data-raw]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const detail = state.details.get(btn.dataset.raw!)!;
      openModal(`原始 XML — ${detail.name}`, `<pre class="raw">${esc(detail.rawXml)}</pre>`);
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const witnessId = btn.dataset.del!;
      const check = await api.deleteCheck(witnessId);
      const witness = snap.witnesses.find((w) => w.id === witnessId)!;
      if (check.blocked) {
        openModal('删除被阻止', `
          <p>见证「${esc(witness.name)}」仍被 ${check.referenced.length} 个校勘单元引用，必须先处理这些单元：</p>
          <ul>${check.referenced.map((r) => `<li>${esc(r.title)} <code>(${r.id})</code></li>`).join('')}</ul>`);
        return;
      }
      if (!confirm(`确认删除见证「${witness.name}」？删除事件会留在版本历史中。`)) return;
      await mutate(() => api.deleteWitness({ witnessId, editor: state.editor, baseRevision: snap.revision }));
    }),
  );
}

function openModal(title: string, bodyHtml: string): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal"><h3 style="color:var(--accent)">${esc(title)}</h3>${bodyHtml}
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button data-close>关闭</button></div></div>`;
  backdrop.querySelector('[data-close]')!.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

function unitColorClass(unitIndex: number): string {
  return `unit-${unitIndex % 3}`;
}

function renderWitnessPane(detail: WitnessDetail, clickable: boolean): HTMLElement {
  const snap = state.snapshot!;
  const draft = state.draft.get(detail.id);
  const unitIndexOf = new Map<string, number>();
  snap.units.forEach((u, i) => unitIndexOf.set(u.id, i));
  const cross = computeCrossPairs(snap.units, detail.id);
  const crossSet = new Set<number>();
  for (const pair of cross) {
    for (let o = Math.max(pair[0], pair[2]); o < Math.min(pair[1], pair[3]); o++) crossSet.add(o);
  }

  const markerAt = new Map<number, string>();
  for (const marker of detail.view.markers) {
    markerAt.set(marker.offset, marker.kind === 'page' ? `⻚${marker.label}` : `◇${marker.label}`);
  }

  const chars: string[] = [];
  for (const g of detail.view.graphemes) {
    const classes = ['g'];
    if (draft && g.offset >= draft.start && g.offset < draft.end) classes.push('sel-a');
    const units = unitsAt(snap.units, detail.id, g.offset);
    if (units.length > 0) classes.push(unitColorClass(unitIndexOf.get(units[0].id) ?? 0));
    if (crossSet.has(g.offset)) classes.push('unit-cross');
    const title = units.map((u) => u.title).join('、');
    chars.push(
      `<span class="${classes.join(' ')}" data-off="${g.offset}"${title ? ` title="${esc(title)}"` : ''}>${esc(g.text)}</span>`,
    );
  }
  const ordered: string[] = [];
  let cursor = 0;
  for (const g of detail.view.graphemes) {
    if (markerAt.has(g.offset)) ordered.push(`<span class="page-marker">${esc(markerAt.get(g.offset)!)}</span>`);
    ordered.push(chars[cursor]);
    cursor++;
  }
  for (const marker of detail.view.markers.filter((m) => m.offset === detail.view.graphemes.length)) {
    ordered.push(`<span class="page-marker">${esc(marker.kind === 'page' ? `⻚${marker.label}` : `◇${marker.label}`)}</span>`);
  }

  const pane = document.createElement('div');
  pane.className = 'witness-pane';
  pane.innerHTML = `
    <div class="pane-head">
      <span><b>${esc(detail.name)}</b> <span class="muted">${detail.id}</span></span>
      <span class="muted">${draft ? `选区 [${draft.start},${draft.end}) = 「${detail.view.text.slice(draft.start, draft.end)}」` : '点按首尾字符框选'}</span>
    </div>
    <div class="text-body" data-pane>${ordered.join('')}</div>`;
  if (clickable) {
    let clickStage: 0 | 1 = 0;
    let clickStart = -1;
    pane.querySelector('[data-pane]')!.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('.g');
      if (!target) return;
      const off = Number(target.dataset.off);
      if (clickStage === 0) {
        clickStart = off;
        clickStage = 1;
        toast(`起点 ${clickStart}，再点选终点`);
      } else {
        const s = Math.min(clickStart, off);
        const en = Math.max(clickStart, off) + 1;
        if (s === en) return;
        state.draft.set(detail.id, { start: s, end: en });
        clickStage = 0;
        render();
      }
    });
  }
  return pane;
}

function unitsAt(units: UnitDto[], witnessId: string, offset: number): UnitDto[] {
  return units.filter((u) =>
    u.anchors.some((a) => a.witnessId === witnessId && offset >= a.start && offset < a.end));
}

/** 计算同一见证内真正交叉（互相不包含）的锚点对，返回 [s1,e1,s2,e2] */
function computeCrossPairs(units: UnitDto[], witnessId: string): Array<[number, number, number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const u of units) {
    for (const a of u.anchors) {
      if (a.witnessId === witnessId) ranges.push([a.start, a.end]);
    }
  }
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const [s1, e1] = ranges[i];
      const [s2, e2] = ranges[j];
      const overlaps = s1 < e2 && s2 < e1;
      const contains = s1 <= s2 && e2 <= e1;
      const contained = s2 <= s1 && e1 <= e2;
      if (overlaps && !contains && !contained) out.push([s1, e1, s2, e2]);
    }
  }
  return out;
}

function renderAlign(el: HTMLElement): void {
  const snap = state.snapshot!;
  if (snap.witnesses.length === 0) {
    el.innerHTML = '<div class="panel muted">请先在「见证导入」页导入至少一个见证。</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'witness-grid';
  for (const meta of snap.witnesses) {
    grid.appendChild(renderWitnessPane(state.details.get(meta.id)!, true));
  }
  const drafts = snap.witnesses
    .map((w) => ({ w, d: state.draft.get(w.id) }))
    .filter((x): x is { w: StateSnapshot['witnesses'][number]; d: { start: number; end: number } } => Boolean(x.d));

  el.innerHTML = `
    <div class="panel">
      <h2>锚点对齐与校勘单元创建</h2>
      <p class="muted">在每个见证中点选首尾字符框选范围；范围可跨元素，但不能切断组合字符。同一见证内单元允许交叉、不允许包含。</p>
      <div id="panes"></div>
    </div>
    <div class="panel">
      <h2>用当前选区建立校勘单元</h2>
      <label class="field">单元标题 <input type="text" data-title style="width:300px" placeholder="如：首句异文"/></label>
      <div id="draft-anchors"></div>
      <div id="readings"></div>
      <div class="row" style="margin-top:8px">
        <button data-add-rdg class="secondary">为某见证补充异读（缺文/倒置/判断）</button>
        <button data-create>建立校勘单元</button>
      </div>
      <p class="muted">默认每个见证记录一条 original 原文异读；倒置请添加两个片段并给出阅读顺序。</p>
    </div>`;
  el.querySelector('#panes')!.appendChild(grid);

  const anchorsBox = el.querySelector<HTMLDivElement>('#draft-anchors')!;
  anchorsBox.innerHTML = drafts.length
    ? `<table class="table"><thead><tr><th>见证</th><th>范围</th><th>文本片段</th></tr></thead><tbody>
      ${drafts.map(({ w, d }) => {
        const detail = state.details.get(w.id)!;
        return `<tr><td>${esc(detail.name)}</td><td>[${d.start},${d.end})</td><td>「${esc(detail.view.text.slice(d.start, d.end))}」</td></tr>`;
      }).join('')}</tbody></table>`
    : '<p class="muted">尚未框选任何范围。</p>';

  const extraReadings: ReadingDto[] = [];
  const readingsBox = el.querySelector<HTMLDivElement>('#readings')!;
  const drawReadings = (): void => {
    readingsBox.innerHTML = extraReadings.length
      ? `<table class="table"><thead><tr><th>见证</th><th>类型</th><th>片段(start,end,order)</th><th>按语</th><th></th></tr></thead><tbody>
        ${extraReadings.map((r, i) => `<tr>
          <td>${esc(snap.witnesses.find((w) => w.id === r.witnessId)?.name ?? r.witnessId)}</td>
          <td>${r.type}</td>
          <td>${r.fragments.map((f) => `${f.start},${f.end},序${f.order}`).join('；')}</td>
          <td>${esc(r.note)}</td>
          <td><button class="danger" data-rm="${i}">移除</button></td>
        </tr>`).join('')}</tbody></table>`
      : '';
    readingsBox.querySelectorAll('[data-rm]').forEach((btn) =>
      btn.addEventListener('click', () => {
        extraReadings.splice(Number((btn as HTMLElement).dataset.rm), 1);
        drawReadings();
      }),
    );
  };
  drawReadings();

  el.querySelector('[data-add-rdg]')!.addEventListener('click', () => {
    const options = snap.witnesses.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    openModal('添加异读', `
      <label class="field">见证 <select data-w>${options}</select></label>
      <label class="field">类型
        <select data-type>
          <option value="lacuna">lacuna 缺文</option>
          <option value="transposition">transposition 异序/倒置</option>
          <option value="judgment">judgment 编辑判断</option>
          <option value="original">original 原文</option>
        </select>
      </label>
      <label class="field">片段（每行一段：start,end,order；倒置两段顺序互调）</label>
      <textarea data-frag placeholder="12,18,2&#10;0,6,1"></textarea>
      <label class="field">按语 <input type="text" data-note style="width:100%"/></label>`);
    const modal = document.querySelector('.modal:last-of-type') as HTMLElement;
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确认添加';
    confirmBtn.style.marginTop = '10px';
    modal.appendChild(confirmBtn);
    confirmBtn.addEventListener('click', () => {
      const witnessId = modal.querySelector<HTMLSelectElement>('[data-w]')!.value;
      const type = modal.querySelector<HTMLSelectElement>('[data-type]')!.value as ReadingDto['type'];
      const note = modal.querySelector<HTMLInputElement>('[data-note]')!.value;
      const fragments: FragmentDto[] = modal.querySelector<HTMLTextAreaElement>('[data-frag]')!.value
        .split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const [s, en, ord] = line.split(',').map((x) => Number(x.trim()));
          return { start: s, end: en, order: ord };
        });
      const draft = state.draft.get(witnessId);
      const frags = fragments.length
        ? fragments
        : draft
          ? [{ start: draft.start, end: draft.end, order: 0 }]
          : [];
      extraReadings.push({ witnessId, type, note, fragments: frags });
      modal.closest(".modal-backdrop")?.remove();
      drawReadings();
    });
  });

  el.querySelector('[data-create]')!.addEventListener('click', async () => {
    const title = (el.querySelector<HTMLInputElement>('[data-title]')!).value.trim();
    if (!title) return toast('请填写单元标题', 'err');
    const anchors: AnchorDto[] = [];
    const readings: ReadingDto[] = [];
    for (const { w, d } of drafts) {
      anchors.push({ witnessId: w.id, start: d.start, end: d.end });
      const overridden = extraReadings.find((r) => r.witnessId === w.id);
      readings.push(overridden ?? {
        witnessId: w.id,
        type: 'original',
        note: '',
        fragments: [{ start: d.start, end: d.end, order: 0 }],
      });
    }
    for (const r of extraReadings) {
      if (!anchors.some((a) => a.witnessId === r.witnessId) && !readings.some((x) => x.witnessId === r.witnessId)) {
        readings.push(r);
      }
    }
    if (anchors.length === 0) return toast('至少在一个见证中框选范围', 'err');
    const ok = await mutate(() => api.createUnit({
      title, anchors, readings, editor: state.editor, baseRevision: snap.revision,
    }));
    if (ok) {
      state.draft.clear();
      toast('校勘单元已建立');
    }
  });
}

function renderOverlap(el: HTMLElement): void {
  const snap = state.snapshot!;
  const rows: string[] = [];
  for (const witness of snap.witnesses) {
    const detail = state.details.get(witness.id)!;
    const anchors: Array<{ unit: UnitDto; start: number; end: number }> = [];
    for (const unit of snap.units) {
      for (const a of unit.anchors) {
        if (a.witnessId === witness.id) anchors.push({ unit, start: a.start, end: a.end });
      }
    }
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = anchors[i];
        const b = anchors[j];
        const overlap = a.start < b.end && b.start < a.end;
        const contains = a.start <= b.start && b.end <= a.end;
        const contained = b.start <= a.start && a.end <= b.end;
        if (overlap) {
          const status = contains || contained ? '错误包含（不允许）' : '合法交叉';
          rows.push(`<tr>
            <td>${esc(detail.name)}</td>
            <td>${esc(a.unit.title)} [${a.start},${a.end})</td>
            <td>${esc(b.unit.title)} [${b.start},${b.end})</td>
            <td><span class="tag ${contains || contained ? 'tag-loss' : 'tag-known'}">${status}</span></td>
            <td>共 ${Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))} 字符</td>
          </tr>`);
        }
      }
    }
  }
  el.innerHTML = `
    <div class="panel">
      <h2>交叠区间可视化</h2>
      <p class="legend">
        <span><span class="swatch" style="background:#345d8c"></span>单元 0</span>
        <span><span class="swatch" style="background:#9a3b2e"></span>单元 1</span>
        <span><span class="swatch" style="background:#3f7a4e"></span>单元 2</span>
        <span><span class="swatch" style="outline:2px dashed #b58a3c;background:transparent"></span>金色虚线 = 合法交叉区域</span>
      </p>
      <div id="panes" class="witness-grid"></div>
    </div>
    <div class="panel">
      <h2>交叠判定</h2>
      <table class="table">
        <thead><tr><th>见证</th><th>锚点 A</th><th>锚点 B</th><th>关系</th><th>规模</th></tr></thead>
        <tbody>${rows.join('') || '<tr><td colspan="5" class="muted">暂无交叠锚点</td></tr>'}</tbody>
      </table>
    </div>`;
  const panes = el.querySelector<HTMLElement>('#panes')!;
  for (const w of snap.witnesses) {
    panes.appendChild(renderWitnessPane(state.details.get(w.id)!, false));
  }
}

function renderUnits(el: HTMLElement): void {
  const snap = state.snapshot!;
  el.innerHTML = `
    <div class="panel">
      <h2>校勘单元编辑</h2>
      <table class="table">
        <thead><tr><th>标题</th><th>锚点与片段</th><th>异读</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody>
          ${snap.units.map((u) => `
            <tr>
              <td><b>${esc(u.title)}</b><br/><span class="muted">${u.id}</span></td>
              <td>${u.anchors.map((a) => {
                const name = snap.witnesses.find((w) => w.id === a.witnessId)?.name ?? a.witnessId;
                const detail = state.details.get(a.witnessId);
                const text = detail ? `「${detail.view.text.slice(a.start, a.end)}」` : '';
                return `<div>${esc(name)} [${a.start},${a.end}) ${esc(text)}</div>`;
              }).join('')}</td>
              <td>${u.readings.map((r) => {
                const name = snap.witnesses.find((w) => w.id === r.witnessId)?.name ?? r.witnessId;
                return `<div><span class="tag tag-${r.type}">${r.type}</span> ${esc(name)}
                  ${r.fragments.map((f) => `[${f.start},${f.end})序${f.order}`).join(' ')}
                  ${r.note ? `<span class="muted">${esc(r.note)}</span>` : ''}</div>`;
              }).join('')}</td>
              <td>${new Date(u.updatedAt).toLocaleString()}</td>
              <td>
                <button class="secondary" data-revise="${u.id}">修订锚点</button>
                <button class="danger" data-del="${u.id}">删除</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无校勘单元，请到「锚点对齐」页建立。</td></tr>'}
        </tbody>
      </table>
    </div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('删除该单元？删除事件会保留在版本历史。')) return;
      await mutate(() => api.deleteUnit({ unitId: btn.dataset.del!, editor: state.editor, baseRevision: snap.revision }));
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-revise]').forEach((btn) =>
    btn.addEventListener('click', () => reviseAnchorDialog(snap.units.find((u) => u.id === btn.dataset.revise)!)),
  );
}

function reviseAnchorDialog(unit: UnitDto): void {
  const snap = state.snapshot!;
  const first = unit.anchors[0];
  if (!first) return toast('该单元没有锚点', 'err');
  const detail = state.details.get(first.witnessId)!;
  openModal(`修订锚点 — ${unit.title}`, `
    <p class="muted">修订会保留旧版本，并自动迁移受影响单元；冲突时返回 409。</p>
    <label class="field">见证
      <select data-w>
        ${unit.anchors.map((a) => `<option value="${a.witnessId}|${a.start}|${a.end}">
          ${esc(snap.witnesses.find((w) => w.id === a.witnessId)?.name ?? a.witnessId)} [${a.start},${a.end})</option>`).join('')}
      </select>
    </label>
    <div class="row">
      <label class="field">新起点 <input type="number" data-ns value="${first.start}" style="width:80px"/></label>
      <label class="field">新终点 <input type="number" data-ne value="${first.end}" style="width:80px"/></label>
    </div>
    <p>当前片段：「${esc(detail.view.text.slice(first.start, first.end))}」</p>
    <p data-preview class="muted"></p>`);
  const modal = document.querySelector('.modal:last-of-type') as HTMLElement;
  const wSelect = modal.querySelector<HTMLSelectElement>('[data-w]')!;
  const ns = modal.querySelector<HTMLInputElement>('[data-ns]')!;
  const ne = modal.querySelector<HTMLInputElement>('[data-ne]')!;
  const preview = modal.querySelector('[data-preview]')!;
  const updatePreview = (): void => {
    const [wid] = wSelect.value.split('|');
    const d = state.details.get(wid)!;
    const s = Number(ns.value);
    const e = Number(ne.value);
    preview.textContent = Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= d.view.text.length && s < e
      ? `新片段：「${d.view.text.slice(s, e)}」`
      : '范围非法';
  };
  [ns, ne].forEach((i) => i.addEventListener('input', updatePreview));
  wSelect.addEventListener('change', () => {
    const [, os, oe] = wSelect.value.split('|');
    ns.value = os;
    ne.value = oe;
    updatePreview();
  });
  updatePreview();
  const btn = document.createElement('button');
  btn.textContent = '提交修订';
  btn.style.marginTop = '10px';
  modal.appendChild(btn);
  btn.addEventListener('click', async () => {
    const [wid, os, oe] = wSelect.value.split('|');
    const ok = await mutate(() => api.reviseAnchor({
      witnessId: wid,
      oldStart: Number(os),
      oldEnd: Number(oe),
      newStart: Number(ns.value),
      newEnd: Number(ne.value),
      editor: state.editor,
      baseRevision: snap.revision,
    }));
    if (ok) modal.closest(".modal-backdrop")?.remove();
  });
}

function renderHistory(el: HTMLElement): void {
  const snap = state.snapshot!;
  el.innerHTML = `
    <div class="panel">
      <h2>版本历史（r0 → r${snap.revision}）</h2>
      <p class="muted">每次成功提交产生一个事件并令版本号 +1；锚点修订保留旧范围；删除见证前必须清空引用。</p>
      <table class="table">
        <thead><tr><th>版本</th><th>类型</th><th>编者</th><th>摘要</th><th>旧版本 → 新版本</th><th>受影响单元</th><th>时间</th></tr></thead>
        <tbody>
          ${snap.events.slice().reverse().map((e) => `
            <tr>
              <td>r${e.revision}</td>
              <td><code>${esc(e.kind)}</code></td>
              <td>${esc(e.editor)}</td>
              <td>${esc(e.summary)}</td>
              <td>
                <details>
                  <summary class="muted">查看 before/after</summary>
                  <p class="muted">旧：</p><pre class="raw">${esc(safeStringify(e.before))}</pre>
                  <p class="muted">新：</p><pre class="raw">${esc(safeStringify(e.after))}</pre>
                </details>
              </td>
              <td>${e.affectedUnits.map((id) => {
                const u = snap.units.find((x) => x.id === id);
                return u ? esc(u.title) : `<span class="muted">${id}</span>`;
              }).join('、') || '—'}</td>
              <td>${new Date(e.at).toLocaleString()}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="muted">尚无事件</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

async function renderExport(el: HTMLElement): Promise<void> {
  el.innerHTML = `
    <div class="panel">
      <h2>导出预检</h2>
      <div id="precheck" class="muted">检查中…</div>
      <div class="row" style="margin-top:10px">
        <button data-check class="secondary">重新预检</button>
        <button data-export>生成带 apparatus 的 XML</button>
      </div>
    </div>
    <div class="panel" id="result-panel" hidden>
      <h2>导出结果</h2>
      <pre class="raw" id="export-xml"></pre>
    </div>`;
  const box = el.querySelector<HTMLDivElement>('#precheck')!;
  async function run(): Promise<void> {
    const result = await api.precheck();
    if (result.ok) {
      box.innerHTML = `✅ 预检通过：${result.normalizedUnitCount} 个单元，未知结构 0 个，可以安全导出。`;
    } else {
      box.innerHTML = `⛔ <b>${result.blockers.length} 个结构无法安全映射，导出已被阻止：</b>
        <table class="table" style="margin-top:8px">
          <thead><tr><th>见证</th><th>定位 XPath</th><th>原始偏移</th><th>结构</th><th>原因</th><th>策略</th></tr></thead>
          <tbody>
            ${result.blockers.map((b) => `<tr>
              <td>${esc(b.witnessName)}</td>
              <td><code>${esc(b.xpath)}</code></td>
              <td>${b.offset}</td>
              <td>${esc(b.qname)}</td>
              <td>${esc(b.reason)}</td>
              <td>${b.qname.startsWith('#') || b.qname === '!DOCTYPE' ? '' :
                `<select data-policy="${esc(b.qname)}"><option value="">选择…</option><option value="keep">keep 保留</option><option value="unwrap">unwrap 仅去标签</option></select>`}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      box.querySelectorAll<HTMLSelectElement>('[data-policy]').forEach((sel) =>
        sel.addEventListener('change', async () => {
          if (!sel.value) return;
          await mutate(() => api.setPolicy({
            qname: sel.dataset.policy!,
            policy: sel.value as 'keep' | 'unwrap',
            editor: state.editor,
            baseRevision: state.snapshot!.revision,
          }));
          await run();
        }),
      );
    }
  }
  await run();
  el.querySelector('[data-check]')!.addEventListener('click', () => void run());
  el.querySelector('[data-export]')!.addEventListener('click', async () => {
    try {
      const result = await api.doExport();
      const panel = el.querySelector<HTMLElement>('#result-panel')!;
      panel.hidden = false;
      el.querySelector('#export-xml')!.textContent = result.xml;
      toast(`已导出 ${result.witnessCount} 个见证、${result.unitCount} 个单元，并写入 .loom-project/export.xml`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'err');
      await run();
    }
  });
}

async function renderRoundtrip(el: HTMLElement): Promise<void> {
  el.innerHTML = `
    <div class="panel">
      <h2>往返核验</h2>
      <p class="muted">流程：原始 XML → 导出 XML → 重新解析 → 与原始语义对齐，差异分为
      <span class="tag tag-known">已知编辑</span>
      <span class="tag tag-lex">仅词法变化</span>
      <span class="tag tag-loss">不可接受丢失</span> 三类，每项差异均可下钻到编辑事件。</p>
      <div class="row">
        <button data-run>执行往返核验（基于当前数据即时导出再解析）</button>
      </div>
      <div id="report" class="muted" style="margin-top:10px">尚未执行。</div>
    </div>`;
  el.querySelector('[data-run]')!.addEventListener('click', async () => {
    const reportBox = el.querySelector<HTMLDivElement>('#report')!;
    reportBox.textContent = '核验中…';
    try {
      const report = await api.roundtrip();
      const clsName = { 'known-edit': 'tag-known', lexical: 'tag-lex', 'unacceptable-loss': 'tag-loss' } as const;
      const clsLabel = { 'known-edit': '已知编辑', lexical: '仅词法变化', 'unacceptable-loss': '不可接受丢失' } as const;
      reportBox.innerHTML = `
        <h3 style="color:${report.ok ? 'var(--green)' : 'var(--red)'}">${report.ok ? '✅ 无不可接受丢失' : '⛔ 存在不可接受丢失'}</h3>
        <p>已知编辑 ${report.counts['known-edit']} · 仅词法变化 ${report.counts.lexical} · 不可接受丢失 ${report.counts['unacceptable-loss']}${report.reparseError ? ` · ${esc(report.reparseError)}` : ''}</p>
        <table class="table">
          <thead><tr><th>分类</th><th>见证</th><th>路径</th><th>类型</th><th>原文片段</th><th>导出片段</th><th>编辑事件</th><th>说明</th></tr></thead>
          <tbody>
            ${report.diffs.map((d) => `
              <tr>
                <td><span class="tag ${clsName[d.classification]}">${clsLabel[d.classification]}</span></td>
                <td>${esc(d.witnessName || '—')}</td>
                <td><code>${esc(d.path)}</code><br/><span class="muted">@${d.sourceOffset}</span></td>
                <td>${esc(d.kind)}</td>
                <td><pre class="raw" style="max-height:80px">${esc(d.originalSnippet)}</pre></td>
                <td><pre class="raw" style="max-height:80px">${esc(d.exportedSnippet)}</pre></td>
                <td>${d.eventIds.length ? d.eventIds.map((id) => {
                  const ev = state.snapshot!.events.find((x) => x.id === id);
                  return ev ? `<details><summary><code>${id.slice(0, 10)}</code></summary>
                    r${ev.revision} ${esc(ev.editor)} ${esc(ev.kind)}<br/>${esc(ev.summary)}</details>` : `<code>${id}</code>`;
                }).join('') : '<span class="muted">无（丢失即无事件支撑）</span>'}</td>
                <td>${esc(d.explanation)}</td>
              </tr>`).join('') || '<tr><td colspan="8" class="muted">没有差异：导出在语义上与原文完全一致（apparatus 除外）。</td></tr>'}
          </tbody>
        </table>`;
    } catch (err) {
      reportBox.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

void refresh().catch((err) => {
  app.innerHTML = `<div class="panel">初始化失败：${esc(err instanceof Error ? err.message : String(err))}</div>`;
});
