import { api } from './api.js';

type AppLike = any;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char] as string));
}

export function renderImport(app: AppLike): string {
  const witnesses = Object.values(app.state.witnesses) as any[];
  return `<div class="card">
    <h2>见证导入</h2>
    <p class="muted">原始 XML 以 UTF-8 原样保存到项目目录；正文视图保留所有空白，未知结构只作派生标记并阻止导出。</p>
    <div class="row">
      <input id="witness-name" placeholder="见证名称，例如 甲本" />
      <input id="witness-file" placeholder="原始文件名，例如 a.xml" />
      <input id="witness-upload" type="file" accept=".xml,application/xml,text/xml" />
    </div>
    <textarea id="witness-xml" placeholder="粘贴 XML，或使用下面的示例"></textarea>
    <div class="row" style="margin-top:10px">
      <button class="primary" data-action="import-witness">导入见证</button>
      <button class="secondary" data-action="fill-sample">填入双见证示例</button>
    </div>
  </div>
  <div class="card"><h3>已保存原件</h3><table><thead><tr><th>名称</th><th>文件</th><th>SHA-256</th><th>状态</th><th>操作</th></tr></thead><tbody>
  ${witnesses.map(w => `<tr><td>${esc(w.name)}</td><td>${esc(w.filename)}</td><td><code>${esc(w.sha256.slice(0, 16))}…</code></td><td>${w.deleted ? '<span class="pill bad">已删除但原件保留</span>' : '<span class="pill ok">可编辑</span>'}</td><td><button class="danger" data-action="delete-witness" data-id="${w.id}">删除前检查</button></td></tr>`).join('')}
  </tbody></table></div>`;
}

export function readerPanel(app: AppLike, witness: any): string {
  const view = app.views[witness.id];
  const blocks = view ? Array.from(view.text) : [];
  const activeMarks: string[] = [];
  const markInfo = new Map<string, { start: number; end: number; kind: string; label: string }>();
  (Object.values(app.state.anchors) as any[]).filter(a => a.witnessId === witness.id).forEach(a => {
    const kind = rangeStatus(app, witness.id, a.current.range);
    markInfo.set(a.id, { ...a.current.range, kind, label: a.label });
  });
  const marks = [...markInfo.values()].sort((a, b) => a.start - b.start || b.end - a.end);
  let html = '';
  (blocks as string[]).forEach((char, index) => {
    const wanted = marks.filter(m => m.start <= index && index < m.end).map(m => m.kind);
    while (activeMarks.length && activeMarks[activeMarks.length - 1] !== wanted[activeMarks.length - 1]) {
      html += '</span>';
      activeMarks.pop();
    }
    wanted.forEach((kind, depth) => {
      if (activeMarks[depth] !== kind) {
        while (activeMarks.length > depth) { html += '</span>'; activeMarks.pop(); }
        html += `<span class="marker ${kind}">`;
        activeMarks.push(kind);
      }
    });
    while (activeMarks.length > wanted.length) { html += '</span>'; activeMarks.pop(); }
    html += esc(char);
  });
  while (activeMarks.length) { html += '</span>'; activeMarks.pop(); }
  const selected = app.selection[witness.id];
  return `<section class="witness">
    <h3><span>${esc(witness.name)}</span><span class="muted">${blocks.length} 码位</span></h3>
    ${view?.issues?.length ? `<div class="card" style="margin:10px;border-color:#a94438;background:#fff3f0;border-radius:8px"><strong>派生视图结构提示</strong>${view.issues.map((issue: any) => `<p><span class="pill bad">${esc(issue.severity)}</span> <code>${esc(issue.path)}</code>：${esc(issue.message)}</p>`).join('')}</div>` : '<div class="muted" style="padding:8px 12px">未发现阻断导出的未知元素</div>'}
    <div class="row" style="padding:0 12px 10px"><button class="secondary" data-action="show-raw" data-id="${witness.id}">查看原始 XML</button><span id="raw-status-${witness.id}" class="muted">原件独立保存，不被规范化视图改写</span></div>
    <div class="card" style="margin:10px;border-radius:8px">
      <div class="row"><strong>选区</strong><span>${selected ? `${selected.start}–${selected.end}` : '在正文中拖选字符'}</span></div>
      <div class="row" style="margin-top:8px"><input id="group-${witness.id}" placeholder="对齐组，例如 para-1" style="width:130px"/><input id="label-${witness.id}" placeholder="锚点说明" style="width:160px"/><button class="secondary" data-action="add-anchor" data-id="${witness.id}">建立对齐锚点</button></div>
    </div>
    <div class="reader" data-reader="${witness.id}">${html || '尚未导入'}</div>
  </section>`;
}

function rangeStatus(app: AppLike, witnessId: string, range: { start: number; end: number }): string {
  const units = Object.values(app.state.units) as any[];
  for (const unit of units) {
    const reading = unit.readings[witnessId];
    if (!reading) continue;
    const other = app.state.anchors[reading.anchorId]?.current.range;
    const contains = range.start <= other.start && other.end <= range.end || other.start <= range.start && range.end <= other.end;
    const equal = range.start === other.start && range.end === other.end;
    if (contains && !equal) return 'contain';
  }
  for (const unit of units) {
    const reading = unit.readings[witnessId];
    if (!reading) continue;
    const other = app.state.anchors[reading.anchorId]?.current.range;
    if (range.start < other.end && other.start < range.end) return 'overlap';
  }
  return 'manual';
}

export function renderAlign(app: AppLike): string {
  const witnesses = (Object.values(app.state.witnesses) as any[]).filter(w => !w.deleted);
  return `<div class="card"><h2>锚点对齐</h2><p class="muted">在每个见证中选择同一语义位置，使用相同“对齐组”保存。蓝/黄表示交叠，红色表示不允许的包含锚点。</p></div>
  <div class="grid2">${witnesses.map(w => readerPanel(app, w)).join('')}</div>`;
}

export function renderOverlap(app: AppLike): string {
  const anchors = Object.values(app.state.anchors) as any[];
  const witnesses = Object.values(app.state.witnesses) as any[];
  return `<div class="card"><h2>交叠区间可视化</h2><p>同一见证允许交叉交叠；后一个区间完整落入前一个区间时，服务端会拒绝建立或修订。</p>
  <table><thead><tr><th>见证</th><th>锚点</th><th>区间</th><th>相对其他单元</th><th>片段</th></tr></thead><tbody>
  ${anchors.map(a => {
    const view = app.views[a.witnessId];
    const snippet = view ? Array.from(view.text).slice(a.current.range.start, a.current.range.end).join('') : '';
    return `<tr><td>${esc(app.state.witnesses[a.witnessId]?.name)}</td><td>${esc(a.label)}</td><td>${a.current.range.start}–${a.current.range.end}</td><td><span class="pill ${rangeStatus(app, a.witnessId, a.current.range) === 'contain' ? 'bad' : 'warn'}">${rangeStatus(app, a.witnessId, a.current.range)}</span></td><td>${esc(snippet)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
