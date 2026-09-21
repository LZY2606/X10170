import { esc } from './format.js';

export function renderExport(app: any, preflight?: any): string {
  const issues = preflight?.issues || preflight?.preflight || [];
  return `<div class="card">
    <h2>导出预检</h2>
    <p class="muted">预检会克隆已知源节点并追加 apparatus；任何未知元素都给出 XPath 式定位并以 422 阻止导出，不做静默丢弃。</p>
    <div class="row"><button class="primary" data-action="run-preflight">运行预检</button>
    <button class="secondary" data-action="do-export" ${issues.some((i: any) => i.severity === 'blocker') ? 'disabled' : ''}>生成并保存导出事件</button></div>
    ${issues.length ? `<table style="margin-top:12px"><thead><tr><th>级别</th><th>见证</th><th>定位</th><th>元素</th><th>原因</th></tr></thead><tbody>${issues.map((i: any) => `<tr><td><span class="pill bad">${esc(i.severity)}</span></td><td>${esc(i.witnessId)}</td><td><code>${esc(i.path)}</code></td><td>${esc(i.qualifiedName)}</td><td>${esc(i.message)}</td></tr>`).join('')}</tbody></table>` : '<p><span class="pill ok">当前没有阻断项</span></p>'}
  </div>
  <div class="card"><h3>Apparatus XML</h3><pre>${esc(preflight?.xml || '运行预检后显示')}</pre></div>`;
}

export function renderRoundtrip(app: any, result?: any): string {
  const differences = result?.differences || [];
  const label: Record<string, string> = {
    'known-edit': '已知编辑',
    'lexical-only': '仅词法变化',
    'unacceptable-loss': '不可接受丢失'
  };
  const cls: Record<string, string> = {
    'known-edit': 'ok',
    'lexical-only': 'warn',
    'unacceptable-loss': 'bad'
  };
  return `<div class="card">
    <h2>往返核验</h2>
    <p class="muted">将原始 XML 与导出 XML 重新解析后的语义结果比较；每项差异分为三类，并链接到造成变化的编辑或导出事件。</p>
    <div class="row"><button class="primary" data-action="run-roundtrip">用当前预检结果核验</button><button class="secondary" data-action="parse-export-xml">核验下方 XML</button></div>
    <textarea id="manual-export" placeholder="也可以粘贴导出 XML 后重新解析核验"></textarea>
  </div>
  <div class="card"><table><thead><tr><th>分类</th><th>见证/路径</th><th>期望</th><th>实际</th><th>事件</th><th>解释</th></tr></thead><tbody>
  ${differences.map((d: any) => `<tr><td><span class="pill ${cls[d.classification]}">${label[d.classification]}</span></td><td>${esc(d.witnessId || '')}<br><code>${esc(d.path)}</code></td><td><pre>${esc(d.expected)}</pre></td><td><pre>${esc(d.actual)}</pre></td><td><code>${esc(d.eventId || '')}</code></td><td>${esc(d.explanation)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
