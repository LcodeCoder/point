// point - dsh client half
//
// One sidebar entry, one main panel, one command. The panel is a read-only
// window onto the Host half: it fetches /point/state (registered by lib/index.js
// on ctx.webServer) and renders what is injected, how much it weighs, which
// rules survived the filter, and every system-prompt assembly the protocol
// actually appeared in.
//
// No build step: this file is the package's `./client` export, loaded through
// window.__ModuleLoader__ exactly like the shipped client plugins.

window.__ModuleLoader__.load({
  id: 'point',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const PANEL_ID = 'point'
    const POLL_MS = 4000

    // ------------------------------------------------------------- language

    const TABS = [
      ['overview', '概览'],
      ['content', '内容'],
      ['results', '成果'],
      ['evolve', '自进化'],
      ['rules', '规则'],
    ]

    const SECTION_LABELS = {
      header: '报头', how: '工作方式', identity: '身份', scope: '范围', priority: '任务优先',
      opening: '开场', review: '草稿审查', category: '类别锁', workflow: '流程', rules: '规则表',
      completion: '完成契约', deliverable: '交付优先', vocabulary: '输出词汇', consistency: '一致性',
      persistence: '持久性', noself: '无自指', placeholders: '占位符', boundary: '边界词',
      bilingual: '双语', intents: '意图映射', canned: '预设工作流', web: 'Web 路由',
      foreign: '外来模式', format: '格式', final: '收尾', house: '内部规则', style: '风格',
    }

    const TIER_LABELS = ['内核', '契约', '路由', '脚手架']
    const MODE_LABELS = { minimal: '极简', core: '核心', routing: '路由', full: '完整' }

    const PRESET_LABELS = { point: 'point（生成）', deva: 'deva（原文）', custom: 'custom（自定义）' }
    const POSITION_LABELS = { head: '头部', tail: '尾部', both: '头 + 尾' }

    // ---------------------------------------------------------------- styles

    const CSS = `
.ptp { display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family); -webkit-font-smoothing: antialiased; }
.ptp-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px;
  padding: 18px 32px 14px;
  background: linear-gradient(var(--dsw-alias-bg-base) 78%, transparent); }
.ptp-mark { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
  color: var(--dsw-alias-state-business-primary); border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); }
.ptp-title { font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
.ptp-sub { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
.ptp-spacer { flex: 1; }
.ptp-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 500;
  padding: 5px 11px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ptp-pill[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary); }
.ptp-pill[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary); }
.ptp-pill[data-tone="bad"] { border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); }
.ptp-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
.ptp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; padding: 6px 12px;
  border-radius: 8px; }
.ptp-btn:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.ptp-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.ptp-btn[disabled] { opacity: .5; cursor: default; }
.ptp-primary { background: var(--dsw-alias-state-business-primary); border-color: transparent; color: #fff; }
.ptp-primary:hover { background: var(--dsw-alias-state-business-primary); color: #fff; filter: brightness(1.08); }
.ptp-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 32px 64px;
  display: flex; flex-direction: column; align-items: center; gap: 28px; }
.ptp-body > * { width: 100%; max-width: 940px; flex: none; }
.ptp-body > .ptp-tabs { width: auto; align-self: flex-start; }
.ptp-wrap { max-width: 940px; margin: 0 auto; display: flex; flex-direction: column; gap: 28px; }
.ptp-hero { display: grid; grid-template-columns: 1.4fr 1fr 1fr;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; overflow: hidden;
  background: linear-gradient(135deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1) 62%); }
.ptp-hero > div { padding: 18px 20px; min-width: 0; }
.ptp-hero > div + div { border-left: 1px solid var(--dsw-alias-border-l1); }
.ptp-hlabel { font-size: 11px; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary);
  text-transform: uppercase; }
.ptp-hvalue { font-size: 22px; font-weight: 600; margin-top: 6px; letter-spacing: -.01em;
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ptp-hvalue small { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary);
  margin-left: 6px; }
.ptp-hint { font-size: 11.5px; color: var(--dsw-alias-label-caption); margin-top: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ptp-tabs { display: inline-flex; align-self: flex-start; gap: 2px; padding: 3px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.ptp-tab { appearance: none; background: none; border: 0; padding: 6px 14px; border-radius: 7px;
  font: inherit; font-size: 12.5px; font-weight: 500; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.ptp-tab:hover { color: var(--dsw-alias-label-primary); }
.ptp-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary); }
.ptp-sect { display: flex; flex-direction: column; gap: 12px; }
.ptp-h { display: flex; align-items: center; gap: 10px; font-size: 12px; font-weight: 600;
  letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.ptp-h:after { content: ""; flex: 1; height: 1px; background: var(--dsw-alias-border-l1); }
.ptp-h span { font-weight: 400; letter-spacing: 0; color: var(--dsw-alias-label-caption); }
.ptp-h .ptp-hright { margin-left: auto; }
.ptp-h .ptp-hright .ptp-btn { padding: 3px 9px; font-size: 11.5px; }
.ptp-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.ptp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.ptp-k { font-size: 11px; color: var(--dsw-alias-label-tertiary); letter-spacing: .02em; }
.ptp-v { font-size: 22px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums;
  margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ptp-v small { font-size: 11.5px; font-weight: 400; color: var(--dsw-alias-label-caption); margin-left: 5px; }
.ptp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 32px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 4px 18px;
  background: var(--dsw-alias-bg-layer-1); }
.ptp-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  font-size: 12.5px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ptp-row:last-child { border-bottom: 0; }
.ptp-row b { font-weight: 400; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ptp-row i { font-style: normal; color: var(--dsw-alias-label-secondary); text-align: right;
  font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ptp-row[data-tone="ok"] i { color: var(--dsw-alias-state-success-primary); }
.ptp-row[data-tone="warn"] i { color: var(--dsw-alias-state-warn-primary); }
.ptp-row[data-tone="bad"] i { color: var(--dsw-alias-state-error-primary); }
.ptp-pre { margin: 0; padding: 14px 16px; border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace);
  font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
  max-height: 420px; overflow: auto; }
.ptp-pre[data-empty="true"] { color: var(--dsw-alias-label-caption); font-style: italic; }
.ptp-bar { height: 5px; border-radius: 999px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.ptp-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--dsw-alias-state-business-primary); }
.ptp-mode { display: grid; grid-template-columns: 56px 1fr 96px; align-items: center; gap: 12px;
  font-size: 12.5px; padding: 5px 0; }
.ptp-mode[data-active="true"] { color: var(--dsw-alias-label-primary); }
.ptp-mode[data-active="false"] { color: var(--dsw-alias-label-tertiary); }
.ptp-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.ptp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ptp-chip { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px; padding: 3px 9px;
  border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.ptp-chip em { font-style: normal; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.ptp-chip[data-tier="0"] { border-color: var(--dsw-alias-state-business-primary); }
.ptp-chip[data-dropped="true"] { opacity: .45; text-decoration: line-through; }
.ptp-table { display: flex; flex-direction: column; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.ptp-thead, .ptp-tr { display: grid; grid-template-columns: 76px 62px 74px 74px 54px 1fr; gap: 10px;
  padding: 9px 14px; align-items: baseline; }
.ptp-thead { color: var(--dsw-alias-label-caption); font-size: 11px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.ptp-tr { border-bottom: 1px solid var(--dsw-alias-border-l1); font-variant-numeric: tabular-nums; }
.ptp-tr:last-child { border-bottom: 0; }
.ptp-tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ptp-mono { font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace); font-size: 11.5px; }
.ptp-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 28px 22px;
  text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; line-height: 1.8; }
.ptp-empty b { display: block; color: var(--dsw-alias-label-secondary); font-weight: 500; margin-bottom: 6px; font-size: 13px; }
.ptp-rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 24px; }
.ptp-rule { display: flex; gap: 10px; font-size: 12.5px; padding: 7px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ptp-rule[data-active="false"] { opacity: .4; }
.ptp-rule em { font-style: normal; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums; min-width: 24px; }
.ptp-rule span { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ptp-log { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-markdown-code-block); }
.ptp-logbar { display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-caption); }
.ptp-log pre { margin: 0; padding: 12px 16px; max-height: 240px; overflow: auto; white-space: pre-wrap;
  word-break: break-word; font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace);
  font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.ptp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ptp-repo { display: flex; gap: 8px; flex-wrap: wrap; }
.ptp-input { flex: 1 1 320px; min-width: 220px; padding: 7px 11px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 12px; }
.ptp-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.ptp-banner { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-radius: 10px;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.ptp-banner .ptp-dot { color: var(--dsw-alias-state-business-primary); }
.ptp-badge { display: inline-flex; align-items: center; font-size: 11px; font-weight: 500;
  padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ptp-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary); }
.ptp-badge[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary); }
.ptp-hist { display: flex; align-items: center; gap: 12px; padding: 10px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; }
.ptp-hist:last-child { border-bottom: 0; }
.ptp-hist .ptp-id { font-family: var(--dsw-font-family-mono, ui-monospace, Menlo, monospace);
  font-size: 11.5px; color: var(--dsw-alias-label-caption); min-width: 34px; }
.ptp-hist .ptp-what { flex: 1; color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.ptp-note { font-size: 12px; line-height: 1.75; color: var(--dsw-alias-label-caption); }
.ptp-toast { font-size: 11.5px; color: var(--dsw-alias-state-success-primary); }
`

    // --------------------------------------------------------------- helpers

    const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—')

    const clock = (ts) => {
      if (!ts) return '—'
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    const errText = (error) => String((error && error.message) || error || 'unknown')

    async function fetchState() {
      const url = new URL('point/state', document.baseURI)
      const res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!data || data.ok !== true) throw new Error('unexpected payload')
      return data
    }

    async function postEvolve(action, extra) {
      const url = new URL('point/evolve', document.baseURI)
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.assign({ action }, extra || {})),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data.result
    }

    function copyText(text, done) {
      const fallback = () => {
        try {
          const node = document.createElement('textarea')
          node.value = text
          node.setAttribute('readonly', '')
          node.style.position = 'fixed'
          node.style.opacity = '0'
          document.body.appendChild(node)
          node.select()
          const ok = document.execCommand && document.execCommand('copy')
          document.body.removeChild(node)
          done(!!ok)
        } catch {
          done(false)
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), fallback)
        return
      }
      fallback()
    }

    // ----------------------------------------------------------- components

    function PointIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
      h('circle', { cx: 8, cy: 8, r: 6.1, stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.85 }),
      h('circle', { cx: 8, cy: 8, r: 1.9, fill: 'currentColor' }),
      h('path', {
        d: 'M8 0.8v2.5M8 12.7v2.5M0.8 8h2.5M12.7 8h2.5',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
      }))
    }

    function Card({ label, value, unit }) {
      return h('div', { className: 'ptp-card' },
        h('div', { className: 'ptp-k' }, label),
        h('div', { className: 'ptp-v' }, value, unit ? h('small', null, unit) : null))
    }

    function Row({ label, value, tone }) {
      return h('div', { className: 'ptp-row', 'data-tone': tone || null },
        h('b', null, label),
        h('i', null, value))
    }

    function SectionTitle({ title, note, right }) {
      return h('div', { className: 'ptp-h' }, title, note ? h('span', null, note) : null,
        right ? h('span', { className: 'ptp-hright' }, right) : null)
    }

    function Overview({ data }) {
      const cfg = data.config
      const max = Math.max(1, ...data.modes.map((m) => m.chars))
      const mode = modeOf(data)
      return h(React.Fragment, null,
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, {
            title: '模式',
            note: mode.scope === 'preset' ? '选中才生效' : '全局常开',
          }),
          h('div', { className: 'ptp-grid' },
            h(Row, {
              label: '作用域',
              value: mode.scope === 'preset' ? '预设 · 破甲模式' : '全局 · 所有会话',
              tone: mode.scope === 'preset' ? 'ok' : 'warn',
            }),
            h(Row, {
              label: '预设',
              value: !mode.probe || mode.probe.available === false
                ? 'Host 没有 agentPresets 服务'
                : mode.registered === true
                  ? `已注册 · ${mode.probe.name || '破甲模式'}`
                  : mode.registered === false ? '未注册 · 模式菜单里没有' : '读取中',
              tone: mode.registered === true ? 'ok' : mode.registered === false ? 'bad' : 'warn',
            }),
            h(Row, { label: '菜单条目', value: mode.probe ? `${mode.probe.count} 个模式` : '—' }),
            h(Row, {
              label: '拒绝重试',
              value: cfg.retryRefusal === false ? '关' : '开 · 仅对带协议的请求',
              tone: cfg.retryRefusal === false ? 'warn' : 'ok',
            }))),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '注入配置' }),
          h('div', { className: 'ptp-grid' },
            h(Row, { label: '预设', value: PRESET_LABELS[cfg.preset] || cfg.preset }),
            h(Row, { label: '档位', value: `${cfg.mode}（${MODE_LABELS[cfg.mode] || cfg.mode}）` }),
            h(Row, { label: '位置', value: POSITION_LABELS[cfg.position] || cfg.position }),
            h(Row, { label: '尾段模式', value: cfg.tailMode === 'full' ? '全文' : '锚点' }),
            h(Row, { label: '头段 order', value: String(cfg.order) }),
            h(Row, { label: '尾段 order', value: String(cfg.tailOrder) }),
            h(Row, { label: 'ChatML 信封', value: cfg.envelope ? '开' : '关' }),
            h(Row, { label: '字符上限', value: cfg.maxChars > 0 ? fmt(cfg.maxChars) : '不限' }),
            h(Row, { label: '身份', value: cfg.identity }),
            h(Row, { label: '操作者', value: cfg.operator }),
            h(Row, { label: '语言', value: cfg.language }),
            h(Row, { label: '开场标记', value: cfg.openingTag }),
            h(Row, { label: '规则过滤', value: cfg.rules }),
            h(Row, {
              label: '路由表',
              value: [
                cfg.includeIntentMap ? '意图' : null,
                cfg.includeCanned ? '预设' : null,
                cfg.includeWebRouting ? 'Web' : null,
              ].filter(Boolean).join(' · ') || '全关',
            }))),
        data.modes.length
          ? h('div', { className: 'ptp-sect' },
            h(SectionTitle, { title: '档位重量', note: '同一份协议，四档裁剪' }),
            h('div', null, data.modes.map((m) => h('div', {
              key: m.mode, className: 'ptp-mode', 'data-active': String(m.mode === cfg.mode),
            },
            h('span', null, MODE_LABELS[m.mode] || m.mode),
            h('span', { className: 'ptp-bar' },
              h('i', { style: { width: `${Math.round((m.chars / max) * 100)}%` } })),
            h('span', { className: 'ptp-num' }, `${fmt(m.chars)} 字符`)))))
          : h('div', { className: 'ptp-note' },
            '当前预设不走生成器（deva / custom），档位裁剪不生效，载荷按原文注入。'),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '界面半（客户端）', note: 'Host 已注入 ≠ 面板已挂载' }),
          h('div', { className: 'ptp-grid' },
            h(Row, {
              label: '状态',
              value: clientOf(data).mounted ? '已挂载到侧栏' : '未挂载 · 重启 dsh 后生效',
              tone: clientOf(data).mounted ? 'ok' : 'warn',
            }),
            h(Row, { label: '模块行', value: clientOf(data).mounted ? (clientOf(data).rev || '—') : '图里没有 point 行' }),
            h(Row, { label: '外部依赖', value: (clientOf(data).external || []).join(' · ') || '无' }),
            h(Row, { label: '资源', value: clientOf(data).path || '—' }))))
    }

    /** Client-graph diagnostic, tolerant of an older Host that does not publish it. */
    function clientOf(data) {
      return data.client || { available: false, mounted: false }
    }

    /** Mode = where the prompt half lives: a preset the operator selects, or this row. */
    function modeOf(data) {
      const status = data.status || {}
      const probe = status.preset || null
      return {
        scope: status.scope || 'global',
        probe,
        registered: probe ? probe.registered : null,
      }
    }

    const PHASES = {
      idle: '空闲', attribution: '定层', canary: '金丝雀', small: '小样本', full: '全量',
      sealed: '密封', guard: '回归', decide: '判定', research: '检索', propose: '提案',
      sandbox: '沙盒', audit: '自检', publish: '推送', done: '完成', blocked: '受阻', error: '出错',
    }
    function phaseLabel(id) { return PHASES[id] || id || '空闲' }

    function modeLabel(data) {
      const m = modeOf(data)
      const enabled = !!(data.status && data.status.enabled)
      if (m.scope === 'global') return enabled ? '全局注入' : '已停用'
      if (!m.probe || m.probe.available === false) return '无模式服务'
      if (m.registered === true) return '破甲模式'
      if (m.registered === false) return '预设缺失'
      return '模式探测中'
    }

    function modeTone(data) {
      const m = modeOf(data)
      const enabled = !!(data.status && data.status.enabled)
      if (m.scope === 'global') return enabled ? 'ok' : 'warn'
      if (!m.probe || m.probe.available === false) return 'warn'
      if (m.registered === true) return 'ok'
      if (m.registered === false) return 'bad'
      return 'warn'
    }

    function Content({ data, onCopy }) {
      const headEmpty = !data.head.text
      const tailEmpty = !data.tail.text
      return h(React.Fragment, null,
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, {
            title: '头段 point',
            note: `${fmt(data.head.chars)} 字符 · ${fmt(data.head.lines)} 行 · order ${data.config.order}`,
            right: h('button', {
              className: 'ptp-btn', type: 'button', onClick: () => onCopy(data.head.text),
            }, '复制'),
          }),
          h('pre', { className: 'ptp-pre', 'data-empty': String(headEmpty) },
            headEmpty ? '未注入：position 不含 head。' : data.head.text)),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, {
            title: '尾锚 point:tail',
            note: `${fmt(data.tail.chars)} 字符 · order ${data.config.tailOrder}`,
            right: h('button', {
              className: 'ptp-btn', type: 'button', onClick: () => onCopy(data.tail.text),
            }, '复制'),
          }),
          h('pre', { className: 'ptp-pre', 'data-empty': String(tailEmpty) },
            tailEmpty ? '未注入：position 不含 tail。' : data.tail.text)),
        data.sections.length
          ? h('div', { className: 'ptp-sect' },
            h(SectionTitle, {
              title: '分段构成',
              note: `${data.sections.filter((s) => !s.dropped).length} 段 · ${fmt(data.head.chars)} 字符`,
            }),
            h('div', { className: 'ptp-chips' }, data.sections.map((s) => h('span', {
              key: s.id, className: 'ptp-chip',
              'data-tier': String(s.tier), 'data-dropped': String(s.dropped),
            },
            `${SECTION_LABELS[s.id] || s.id}`,
            h('em', null, s.dropped ? '裁掉' : fmt(s.chars))))))
          : null)
    }

    function Results({ data, onCopy }) {
      const ev = data.evidence
      const last = ev.rows[0]
      const retry = (data.telemetry && data.telemetry.retry) || {}
      return h(React.Fragment, null,
        h('div', { className: 'ptp-cards' },
          h(Card, { label: '装配观测', value: fmt(ev.count), unit: '次' }),
          h(Card, { label: '覆盖作用域', value: fmt(ev.scopes) }),
          h(Card, { label: '最近装配', value: clock(ev.last) }),
          h(Card, {
            label: 'point 段位次',
            value: last && last.index >= 0 ? `#${last.index}` : '—',
            unit: last && last.next ? `后接 ${last.next}` : '',
          })),
        h('div', { className: 'ptp-cards' },
          h(Card, { label: '拒绝重试', value: fmt(retry.attempts || 0), unit: '次' }),
          h(Card, { label: '重试挽回', value: fmt(retry.recovered || 0) }),
          h(Card, { label: '仍拒绝', value: fmt(retry.refused || 0) }),
          h(Card, {
            label: '最近档位',
            value: retry.lastFrame || '—',
            unit: retry.lastAt ? clock(retry.lastAt) : '',
          })),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '破甲成果', note: '每一次系统提示装配的实测记录' }),
          ev.rows.length
            ? h('div', { className: 'ptp-table' },
              h('div', { className: 'ptp-thead' },
                h('span', null, '时间'), h('span', null, '作用域'), h('span', null, '头段'),
                h('span', null, '尾锚'), h('span', null, '段数'), h('span', null, 'point 后一段')),
              ev.rows.map((r, i) => h('div', { key: `${r.at}-${i}`, className: 'ptp-tr' },
                h('span', { className: 'ptp-mono' }, clock(r.at)),
                h('span', { className: 'ptp-mono' }, r.scope ? `scope#${r.scope}` : 'global'),
                h('span', { className: 'ptp-mono' }, fmt(r.head)),
                h('span', { className: 'ptp-mono' }, fmt(r.tail)),
                h('span', { className: 'ptp-mono' }, fmt(r.sections)),
                h('span', { className: 'ptp-mono' }, r.next || '—'))))
            : h('div', { className: 'ptp-empty' },
              h('b', null, '还没有装配记录'),
              '协议已经就位，等待下一次系统提示装配。',
              h('br'),
              '发一句话、触发一轮对话，这里就会落一行实测数据。'),
          h('div', null, h('button', {
            className: 'ptp-btn', type: 'button', onClick: () => onCopy(JSON.stringify(data, null, 2)),
          }, '复制完整状态 JSON'))),
        h('div', { className: 'ptp-note' },
          '观测点在 system-prompt/assemble 瀑布上，只读不改：它记录 point 段是否在装配结果里、' +
          '占多少字符、排在第几位、后面紧跟哪一段——这是「破甲生效」的唯一硬证据。'))
    }

    function Rules({ data }) {
      const lint = data.lint
      return h(React.Fragment, null,
        h('div', { className: 'ptp-cards' },
          h(Card, { label: '生效规则', value: `${data.rules.active}`, unit: `/ ${data.rules.total}` }),
          h(Card, { label: '词汇自检', value: lint.ok ? '通过' : `${lint.hits.length} 处` }),
          h(Card, { label: '插件版本', value: `v${data.plugin.version}` }),
          h(Card, { label: 'Host PID', value: String(data.plugin.pid) })),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '类别锁规则表', note: `${data.rules.active} 条生效` }),
          h('div', { className: 'ptp-rules' }, data.rules.rows.map((r) => h('div', {
            key: r.id, className: 'ptp-rule', 'data-active': String(r.active),
          },
          h('em', null, `#${r.id}`),
          h('span', null, r.title))))),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '载荷词汇自检', note: '排除引用段后的禁词扫描' }),
          lint.ok
            ? h('div', { className: 'ptp-note' }, '干净：渲染后的头段没有出现禁词。')
            : h('div', { className: 'ptp-table' }, lint.hits.map((hit, i) => h('div', {
              key: `${hit.term}-${i}`, className: 'ptp-tr',
            },
            h('span', { className: 'ptp-mono' }, hit.term),
            h('span', { className: 'ptp-mono' }, hit.section))))))
    }

    function fmtIdle(ms) {
      const value = Number(ms) || 0
      if (value >= 60000) return `${Math.round(value / 60000)} 分钟`
      return `${Math.round(value / 1000)} 秒`
    }

    const trackLabel = (tracks) => (Array.isArray(tracks) && tracks.length ? tracks : ['prompt'])
      .map((id) => (id === 'code' ? '代码' : '提示词')).join(' → ')

    function Evolve({ data, busy, onAction }) {
      const ev = data.evolve || { available: false, stale: true }
      const [repoOpen, setRepoOpen] = useState(false)
      const [repoDraft, setRepoDraft] = useState('')
      if (!ev.available) {
        return h('div', { className: 'ptp-empty' },
          h('b', null, ev.stale ? 'Host 半是旧版本' : '自进化未就绪'),
          ev.stale
            ? '这个页签的开关与台账由 Host 半提供；重启 dsh 后接管。'
            : ev.error || 'Host 半边没有创建 evolve 运行时。',
          h('br'),
          `状态目录：${ev.dir || '—'}`)
      }
      const last = ev.last || null
      const pctOf = (x) => `${Math.round(Number(x || 0) * 100)}%`
      return h(React.Fragment, null,
        ev.running ? h('div', { className: 'ptp-banner' },
          h('i', { className: 'ptp-dot' }),
          `正在跑第 ${ev.round + 1} 轮 · 阶段 ${phaseLabel(ev.phase)} · 一轮要几十到几百次模型调用，跑完会出现在台账里`) : null,
        h('div', { className: 'ptp-cards' },
          h(Card, { label: '开关', value: ev.armed ? '已开启' : '已关闭' }),
          h(Card, { label: '轮次', value: `${ev.round}`, unit: `/ ${ev.maxRounds}` }),
          h(Card, { label: '阶段', value: phaseLabel(ev.phase) }),
          h(Card, { label: '轨道', value: trackLabel(ev.tracks) }),
          h(Card, { label: '保留', value: `${ev.kept}`, unit: `/ ${ev.ledger} 轮` })),
        h('div', { className: 'ptp-actions' },
          h('button', {
            className: 'ptp-btn ptp-primary', type: 'button', disabled: !!busy,
            onClick: () => onAction(ev.armed ? 'stop' : 'start'),
          }, ev.armed ? '关闭自动迭代' : '开启自动迭代'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy || !!ev.running,
            onClick: () => onAction('round'),
          }, busy === 'round' ? '跑一轮…' : '跑一轮'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy || !!ev.running,
            onClick: () => onAction('round', { track: 'code' }),
          }, busy === 'round:code' ? '跑代码轮…' : '跑代码轮'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy,
            onClick: () => onAction('rollback'),
          }, '回滚上一轮'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy || !ev.repo,
            onClick: () => onAction('publish'),
          }, '同步仓库'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy,
            onClick: () => {
              setRepoDraft(ev.repo || '')
              setRepoOpen(!repoOpen)
            },
          }, repoOpen ? '收起仓库设置' : 'GitHub 仓库')),
        h('div', { className: 'ptp-note' },
          ev.phase === 'done'
            ? `本轮预算（${ev.maxRounds} 轮）已用完，链保留；点「开启」开始新一轮，台账会归档。`
            : '提示词轮：定层 → 金丝雀 → 选算子 → 8 个候选 → 小样本 → 全量 → 密封。代码轮：GitHub 检索 → 写完整文件 → 沙盒副本跑全套测试 → 通过才落地。跑完一轮按节奏等下一轮，同时要等你静默。'),
        repoOpen
          ? h('div', { className: 'ptp-repo' },
            h('input', {
              className: 'ptp-input',
              value: repoDraft,
              placeholder: 'https://github.com/<you>/<repo>.git',
              onChange: (event) => setRepoDraft(event.target.value),
            }),
            h('button', {
              className: 'ptp-btn ptp-primary', type: 'button', disabled: !!busy,
              onClick: () => {
                onAction('repo', { repo: repoDraft.trim() }).then((ok) => {
                  if (ok) setRepoOpen(false)
                })
              },
            }, '保存'),
            h('button', {
              className: 'ptp-btn', type: 'button', disabled: !!busy,
              onClick: () => {
                onAction('repo', { repo: '' })
                setRepoOpen(false)
              },
            }, '清除'))
          : null,
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '运行配置' }),
          h('div', { className: 'ptp-grid' },
          h(Row, {
            label: '配置默认',
            value: ev.configured ? '开' : '关（会话内可开）',
            tone: ev.configured ? 'ok' : null,
          }),
          h(Row, {
            label: '节奏',
            value: ev.everyMinutes
              ? `每 ${ev.everyMinutes >= 60 ? `${Math.round(ev.everyMinutes / 60)} 小时` : `${ev.everyMinutes} 分钟`}最多一轮${ev.nextAt ? ` · 下次 ${clock(ev.nextAt)}` : ''}`
              : '不限间隔',
          }),
          h(Row, {
            label: 'GitHub 检索',
            value: ev.research === false ? '关' : '开 · 代码轮先搜参考项目',
            tone: ev.research === false ? 'warn' : 'ok',
          }),
          h(Row, {
            label: '空闲才跑',
            value: ev.idleOnly ? `是 · 静默 ${fmtIdle(ev.idleMs)}` : '否 · 一直跑',
            tone: ev.idleOnly ? 'ok' : 'warn',
          }),
          h(Row, {
            label: '仓库',
            value: ev.repo ? `${ev.repo}${ev.repoSource === 'panel' ? ' · 面板设置' : ''}` : '未配置 · 点上方「GitHub 仓库」填',
            tone: ev.repo ? 'ok' : 'warn',
          }),
          h(Row, { label: '分支 / 推送', value: `${ev.branch || 'main'} · ${ev.push ? 'push' : '仅本地'}` }),
          h(Row, {
            label: '模型',
            value: ev.model ? `${ev.model.provider}/${ev.model.model}` : '未选择',
            tone: ev.model ? null : 'warn',
          }),
          h(Row, {
            label: '探针',
            value: ev.runner ? '可用' : '无模型服务',
            tone: ev.runner ? 'ok' : 'warn',
          }),
          h(Row, { label: '基线', value: `${fmt(ev.baseline ? ev.baseline.chars : 0)} 字符` }),
          h(Row, { label: '状态目录', value: ev.dir || '—' }),
          h(Row, {
            label: 'git',
            value: ev.git && ev.git.ok
              ? `${ev.git.branch || 'main'} @ ${ev.git.commit || '—'}${ev.git.dirty ? ` · ${ev.git.dirty} 未提交` : ''}`
              : (ev.git && ev.git.error) || '未初始化',
            tone: ev.git && ev.git.ok ? 'ok' : 'warn',
          }))),
        (ev.log || []).length ? h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '运行日志', note: '最近 12 行' }),
          h('div', { className: 'ptp-log' },
            h('div', { className: 'ptp-logbar' }, `evolve.log · ${ev.dir || '—'}`),
            h('pre', null, (ev.log || []).join('\n')))) : null,
        last ? h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '上一轮' }),
          h('div', { className: 'ptp-grid' },
          h(Row, {
            label: `第 ${last.round} 轮 · ${last.track === 'code' ? '代码' : '提示词'}`,
            value: `${last.decision || '—'}${last.reason ? ` · ${last.reason}` : ''}`,
            tone: last.decision === 'keep' ? 'ok' : last.decision === 'revert' || last.decision === 'blocked' ? 'warn' : null,
          }),
          last.title ? h(Row, { label: '改动', value: last.title }) : null,
          last.files && last.files.length ? h(Row, { label: '文件', value: last.files.map((file) => file.path).join('、') }) : null,
          last.tests ? h(Row, {
            label: '测试',
            value: `${last.tests.pass || 0} 通过${last.tests.fail ? ` · ${last.tests.fail} 失败` : ''}`,
            tone: last.tests.ok ? 'ok' : 'warn',
          }) : null,
          last.research ? h(Row, { label: '检索', value: `${last.research.hits || 0} 个参考项目` }) : null,
          last.audit ? h(Row, {
            label: '自检',
            value: last.audit.ok === false
              ? `${last.audit.high || 0} 个高危 · ${(last.audit.findings || []).slice(0, 3).map((row) => `${row.rule}@${row.file}:${row.line}`).join('、')}`
              : `通过 · ${(last.audit.scanned || []).every((path) => path === 'payload') ? '载荷' : `${(last.audit.scanned || []).length} 个文件`}`,
            tone: last.audit.ok === false ? 'warn' : 'ok',
          }) : null,
          h(Row, {
            label: '端到端',
            value: last.e2e ? `${pctOf(last.e2e.before)} → ${pctOf(last.e2e.after)}` : '—',
          }))) : null,
        (ev.history || []).length ? h('div', { className: 'ptp-sect' },
          h(SectionTitle, { title: '台账', note: `${ev.history.length} 轮` }),
          h('div', null, ev.history.map((row) => {
            const tone = row.decision === 'keep' ? 'ok' : row.decision === 'revert' ? 'warn' : null
            const what = row.track === 'code'
              ? [row.title, row.tests ? `${row.tests.pass || 0} 测试` : null].filter(Boolean).join(' · ')
              : [row.axis || '提示词', row.reason || (row.eval && row.eval.e2e ? `${pctOf(row.eval.e2e.after)}` : null)]
                .filter(Boolean).join(' · ')
            return h('div', { key: `h${row.round}`, className: 'ptp-hist' },
              h('span', { className: 'ptp-id' }, `#${row.round}`),
              h('span', { className: 'ptp-badge', 'data-tone': tone }, row.decision || '—'),
              h('span', { className: 'ptp-what' }, what || '—'),
              h('span', { className: 'ptp-id' }, clock(row.at)))
          }))) : null)
    }

    function PointPanel() {
      const [tab, setTab] = useState('overview')
      const [view, setView] = useState({ kind: 'loading' })
      const [nonce, setNonce] = useState(0)
      const [toast, setToast] = useState('')
      const [busy, setBusy] = useState('')

      useEffect(() => {
        let alive = true
        let inflight = false
        const tick = () => {
          if (document.hidden || inflight) return
          inflight = true
          fetchState().then((data) => {
            if (alive) setView({ kind: 'ready', data })
          }).catch((error) => {
            if (!alive) return
            setView((prev) => (prev.kind === 'ready'
              ? { kind: 'ready', data: prev.data, stale: errText(error) }
              : { kind: 'error', error: errText(error) }))
          }).then(() => { inflight = false })
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(id) }
      }, [nonce])

      const toastTimer = React.useRef(null)
      const showToast = useCallback((message) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 1600)
      }, [])
      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

      const onEvolve = useCallback((action, extra) => {
        setBusy(extra && extra.track === 'code' ? `${action}:code` : action)
        return postEvolve(action, extra).then((result) => {
          const failed = !!(result && result.error)
          showToast(failed ? `失败：${result.error}` : (action === 'round' ? '已开跑' : '已执行'))
          return !failed
        }).catch((error) => {
          showToast(`失败：${errText(error)}`)
          return false
        }).then((ok) => {
          setBusy('')
          setNonce((n) => n + 1)
          return ok
        })
      }, [showToast])

      const onCopy = useCallback((text) => {
        copyText(String(text || ''), (ok) => {
          showToast(ok ? '已复制' : '复制失败')
        })
      }, [showToast])

      const data = view.kind === 'ready' ? view.data : null

      const tone = useMemo(() => {
        if (view.kind === 'error') return 'bad'
        if (!data) return 'warn'
        return modeTone(data)
      }, [view.kind, data])

      const pill = view.kind === 'error'
        ? 'Host 未连接'
        : !data ? '读取中' : modeLabel(data)

      return h('section', { className: 'ptp', 'aria-label': 'point 破甲协议' },
        h('style', null, CSS),
        h('div', { className: 'ptp-head' },
          h('div', { className: 'ptp-mark' }, h(PointIcon, { size: 18 })),
          h('div', null,
            h('div', { className: 'ptp-title' }, 'point · 破甲协议'),
            h('div', { className: 'ptp-sub' }, '系统提示注入 · 内容与成果')),
          h('div', { className: 'ptp-spacer' }),
          toast ? h('span', { className: 'ptp-toast' }, toast) : null,
          h('span', { className: 'ptp-pill', 'data-tone': tone },
            h('i', { className: 'ptp-dot' }), pill),
          h('button', {
            className: 'ptp-btn', type: 'button', onClick: () => setNonce((n) => n + 1),
          }, '刷新')),
        h('div', { className: 'ptp-body' },
          view.kind === 'loading'
            ? h('div', { className: 'ptp-empty' }, h('b', null, '读取中…'), '正在向 Host 请求 /point/state')
            : null,
          view.kind === 'error'
            ? h('div', { className: 'ptp-empty' },
              h('b', null, 'Host 半未激活'),
              `请求 /point/state 失败：${view.error}`,
              h('br'),
              '面板是只读的浏览器半边；数据由插件 Host 半边经 ctx.webServer 提供。',
              h('br'),
              '重启 dsh（或在 设置 → 插件 里重启 point）后这条路由才会出现。')
            : null,
          data
            ? h(React.Fragment, null,
              view.stale ? h('div', { className: 'ptp-note' }, `最近一次刷新失败：${view.stale}`) : null,
              h('div', { className: 'ptp-hero' },
                h('div', null,
                  h('div', { className: 'ptp-hlabel' }, '模式'),
                  h('div', { className: 'ptp-hvalue' }, modeLabel(data)),
                  h('div', { className: 'ptp-hint' },
                    modeOf(data).scope === 'preset'
                      ? `${modeOf(data).probe ? modeOf(data).probe.count : 0} 个模式可选 · 选中才生效`
                      : '全局注入 · 所有会话')),
                h('div', null,
                  h('div', { className: 'ptp-hlabel' }, '注入头段'),
                  h('div', { className: 'ptp-hvalue' }, fmt(data.head.chars), h('small', null, '字符')),
                  h('div', { className: 'ptp-hint' },
                    `${data.sections.filter((s) => !s.dropped).length} 段 · ${data.rules.active} 条规则`)),
                h('div', null,
                  h('div', { className: 'ptp-hlabel' }, '装配观测'),
                  h('div', { className: 'ptp-hvalue' }, fmt(data.evidence.count), h('small', null, '次')),
                  h('div', { className: 'ptp-hint' },
                    data.evidence.last ? `最近 ${clock(data.evidence.last)}` : '等待下一次装配'))),
              h('div', { className: 'ptp-tabs' }, TABS.map(([id, label]) => h('button', {
                key: id, type: 'button', className: 'ptp-tab', 'data-active': String(tab === id),
                onClick: () => setTab(id),
              }, label))),
              tab === 'overview' ? h(Overview, { data }) : null,
              tab === 'content' ? h(Content, { data, onCopy }) : null,
              tab === 'results' ? h(Results, { data, onCopy }) : null,
              tab === 'evolve' ? h(Evolve, { data, busy, onAction: onEvolve }) : null,
              tab === 'rules' ? h(Rules, { data }) : null)
            : null))
    }

    // ------------------------------------------------------------- the plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PointPanel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          label: 'point',
        }, PointIcon))

        // The command half is optional: a composition without the slash-command
        // surface still gets the sidebar entry and the panel.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['commandUi', 'layout'], (scope) => {
            scope.effect(() => scope.commandUi.register({
              name: 'point',
              label: () => 'point · 破甲协议',
              description: () => '打开 point 面板：注入内容、装配成果与规则表',
              available: () => true,
              ui: {
                kind: 'action',
                run: () => {
                  try {
                    scope.layout.selectPanel(PANEL_ID)
                  } catch {
                    // The panel key is registered in the same apply pass; a
                    // composition that rejected it has nothing to select.
                  }
                },
              },
            }), 'point: /point command')
          })
        }
      },
    }
  },
})
