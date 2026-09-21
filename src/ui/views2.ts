import { esc } from './format.js';

export function renderUnits(app: any): string {
  const witnesses = Object.values(app.state.witnesses).filter((w: any) => !w.deleted) as any[];
  const units = Object.values(app.state.units) as any[];
  return `<div class="card">
    <h2>校勘单元编辑</h2>
    <p class="muted">为每个见证记录原文、缺文、倒置片段或编辑判断。倒置可提供两个片段及其顺序。</p>
    <div class="grid3">
      <input id="unit-label" placeholder="单元名称，例如 U1 首句" />
      <input id="common-group" placeholder="限定对齐组（可空）" />
      <button class="primary" data-action="create-unit">为所选锚点建立单元</button>
    </div>
    <div class="grid2" style="margin-top:12px">
      ${witnesses.map(w => `<label>${esc(w.name)} 锚点
        <select id="reading-anchor-${w.id}">${(Object.values(app.state.anchors) as any[]).filter(a => a.witnessId === w.id && a.current.range.end > a.current.range.start).map(a => `<option value="${a.id}">${esc(a.label)} (${a.current.range.start}-${a.current.range.end})</option>`).join('')}</select>
      </label>`).join('')}
    </div>
    <div class="grid2" style="margin-top:10px">
      ${witnesses.map(w => `<div class="card" style="margin:0"><strong>${esc(w.name)}</strong>
        <select id="status-${w.id}"><option value="original">原文</option><option value="lacuna">缺文</option><option value="transposition">异序/倒置</option><option value="editorial">编辑判断</option></select>
        <textarea id="reading-${w.id}" placeholder="录文或说明"></textarea>
        <input id="fragments-${w.id}" placeholder='倒置片段 JSON：[{"text":"甲乙","order":2},{"text":"丙丁","order":1}]' />
      </div>`).join('')}
    </div>
  </div>
  <div class="card"><h3>现有单元</h3><table><thead><tr><th>单元</th><th>见证与状态</th><th>录文/判断</th><th>倒置片段</th></tr></thead><tbody>
  ${units.map(unit => `<tr><td><strong>${esc(unit.label)}</strong><div class="muted">${esc(unit.id)}</div></td>
    <td>${Object.entries(unit.readings).map(([wid, r]: [string, any]) => `${esc(app.state.witnesses[wid]?.name)} <span class="pill warn">${esc(r.status)}</span>`).join('<br>')}</td>
    <td>${Object.entries(unit.readings).map(([wid, r]: [string, any]) => `<strong>${esc(app.state.witnesses[wid]?.name)}:</strong> ${esc(r.text)}${r.judgment ? `<div class="muted">${esc(r.judgment)}</div>` : ''}`).join('<hr>')}</td>
    <td>${Object.values(unit.readings).flatMap((r: any) => r.fragments || []).map((f: any) => `${esc(f.text)}#${f.order}${f.reversed ? '↩' : ''}`).join('<br>')}</td>
  </tr>`).join('')}</tbody></table></div>`;
}

export function renderHistory(app: any): string {
  const anchors = Object.values(app.state.anchors) as any[];
  const conflicts = Object.values(app.state.conflicts) as any[];
  return `<div class="card"><h2>锚点修订与版本历史</h2>
    <h3>修订锚点</h3>${anchors.map(a => `<div class="card" style="background:white">
      <div class="row"><strong>${esc(app.state.witnesses[a.witnessId]?.name)} / ${esc(a.label)}</strong><span class="muted">当前 ${a.current.range.start}-${a.current.range.end}，版本 ${a.current.version}</span></div>
      <div class="row"><input type="number" id="rev-start-${a.id}" value="${a.current.range.start}" min="0"/><input type="number" id="rev-end-${a.id}" value="${a.current.range.end}" min="1"/><input id="rev-reason-${a.id}" placeholder="修订原因"/><button class="secondary" data-action="revise-anchor" data-id="${a.id}">修订并保留旧版</button></div>
      ${a.current.affectedUnitIds.length ? `<div class="muted">当前版本影响单元：${a.current.affectedUnitIds.join(', ')}</div>` : ''}
      <details><summary>历史版本（${a.history.length}）</summary>${a.history.map((h: any) => `<p><span class="pill ok">v${h.version}</span> ${h.range.start}–${h.range.end}；${esc(h.reason)}；${esc(h.at)}；影响：${h.affectedUnitIds.join(', ') || '无'}</p>`).join('')}</details>
    </div>`).join('')}</div>
  <div class="card"><h3>并发冲突</h3><table><thead><tr><th>时间</th><th>提交者</th><th>双方范围与片段</th><th>状态</th><th></th></tr></thead><tbody>
  ${conflicts.map(c => `<tr><td>${esc(c.at)}</td><td>${esc(c.actor)}<br><span class="muted">基于 v${c.baseVersion}，当前 v${c.currentVersion}</span></td>
    <td><strong>后提交：</strong>${esc(c.incoming.label)}<br>${c.incoming.ranges.map((r: any) => `${esc(app.state.witnesses[r.witnessId]?.name)} ${r.start}-${r.end} “${esc(r.snippet)}”`).join('<br>')}
    <br><strong>已存在：</strong>${esc(c.existing.actor)} / ${esc(c.existing.label)}<br>${c.existing.ranges.map((r: any) => `${esc(app.state.witnesses[r.witnessId]?.name)} ${r.start}-${r.end} “${esc(r.snippet)}”`).join('<br>')}</td>
    <td>${c.resolved ? '<span class="pill ok">已处理</span>' : '<span class="pill bad">待处理，未覆盖</span>'}</td><td>${c.resolved ? '' : `<button class="secondary" data-action="resolve-conflict" data-id="${c.id}">确认已人工合并</button>`}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="card"><h3>完整事件日志</h3><table><thead><tr><th>版本</th><th>类型</th><th>操作者</th><th>时间</th><th>事件</th></tr></thead><tbody>
  ${app.events.map((e: any) => `<tr><td>${e.version}</td><td>${esc(e.type)}</td><td>${esc(e.actor)}</td><td>${esc(e.at)}</td><td><code>${esc(e.id)}</code></td></tr>`).join('')}
  </tbody></table></div>`;
}
