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
  font-family: var(--dsw-font-family); }
.ptp-head { display: flex; align-items: center; gap: 10px; padding: 14px 22px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ptp-title { font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.ptp-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ptp-spacer { flex: 1; }
.ptp-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
  padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ptp-pill[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary); }
.ptp-pill[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary); }
.ptp-pill[data-tone="bad"] { border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); }
.ptp-dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
.ptp-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: none;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer;
  padding: 4px 10px; border-radius: var(--dsw-radius-sm); }
.ptp-btn:hover { background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary); }
.ptp-body { flex: 1; min-height: 0; overflow: auto; padding: 16px 22px 48px;
  display: flex; flex-direction: column; gap: 16px; }
.ptp-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.ptp-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  padding: 10px 13px; background: var(--dsw-alias-bg-layer-1); min-width: 0; }
.ptp-k { font-size: 11px; color: var(--dsw-alias-label-tertiary); letter-spacing: .02em; }
.ptp-v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums;
  margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ptp-v small { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-caption);
  margin-left: 4px; }
.ptp-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ptp-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 6px 12px; margin-bottom: -1px; font: inherit; font-size: 13px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); }
.ptp-tab:hover { color: var(--dsw-alias-label-primary); }
.ptp-tab[data-active="true"] { color: var(--dsw-alias-label-primary);
  border-bottom-color: var(--dsw-alias-state-business-primary); }
.ptp-sect { display: flex; flex-direction: column; gap: 8px; }
.ptp-h { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
.ptp-h span { font-weight: 400; color: var(--dsw-alias-label-caption); }
.ptp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 22px; }
.ptp-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  font-size: 12px; padding: 6px 0; border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.ptp-row b { font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.ptp-row i { font-style: normal; color: var(--dsw-alias-label-primary); text-align: right;
  font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
.ptp-row[data-tone="ok"] i { color: var(--dsw-alias-state-success-primary); }
.ptp-row[data-tone="warn"] i { color: var(--dsw-alias-state-warn-primary); }
.ptp-pre { margin: 0; padding: 12px 14px; border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-markdown-code-block);
  color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  max-height: 360px; overflow: auto; }
.ptp-pre[data-empty="true"] { color: var(--dsw-alias-label-caption); font-style: italic; }
.ptp-bar { height: 6px; border-radius: 999px; background: var(--dsw-alias-border-l1); overflow: hidden; }
.ptp-bar > i { display: block; height: 100%; border-radius: 999px;
  background: var(--dsw-alias-state-business-primary); }
.ptp-mode { display: grid; grid-template-columns: 52px 1fr 92px; align-items: center; gap: 10px;
  font-size: 12px; padding: 4px 0; }
.ptp-mode[data-active="true"] { color: var(--dsw-alias-label-primary); }
.ptp-mode[data-active="false"] { color: var(--dsw-alias-label-tertiary); }
.ptp-num { text-align: right; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary); }
.ptp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ptp-chip { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px;
  padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); }
.ptp-chip em { font-style: normal; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums; }
.ptp-chip[data-tier="0"] { border-color: var(--dsw-alias-state-business-primary); }
.ptp-chip[data-dropped="true"] { opacity: .45; text-decoration: line-through; }
.ptp-table { display: flex; flex-direction: column; font-size: 12px; }
.ptp-thead, .ptp-tr { display: grid; grid-template-columns: 76px 62px 74px 74px 54px 1fr;
  gap: 10px; padding: 6px 8px; align-items: baseline; }
.ptp-thead { color: var(--dsw-alias-label-caption); font-size: 11px;
  border-bottom: 1px solid var(--dsw-alias-border-l2); }
.ptp-tr { border-bottom: 1px dashed var(--dsw-alias-border-l1);
  font-variant-numeric: tabular-nums; }
.ptp-tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ptp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.ptp-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  padding: 22px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px;
  line-height: 1.7; }
.ptp-empty b { display: block; color: var(--dsw-alias-label-secondary); font-weight: 500;
  margin-bottom: 4px; }
.ptp-rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 4px 20px; }
.ptp-rule { display: flex; gap: 8px; font-size: 12px; padding: 4px 0;
  border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.ptp-rule[data-active="false"] { opacity: .38; }
.ptp-rule em { font-style: normal; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums; min-width: 22px; }
.ptp-rule span { color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.ptp-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.ptp-primary { border-color: transparent; background: var(--dsw-alias-state-business-primary); color: #fff; }
.ptp-primary:hover { filter: brightness(1.06); }
.ptp-btn[disabled] { opacity: 0.55; cursor: default; }
.ptp-note { font-size: 11.5px; color: var(--dsw-alias-label-caption); line-height: 1.6; }
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

    async function postEvolve(action) {
      const url = new URL('point/evolve', document.baseURI)
      const res = await fetch(url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
      return data.result
    }

    function copyText(text, done) {
      const finish = () => { done() }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(finish, finish)
        return
      }
      finish()
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

    function SectionTitle({ title, note }) {
      return h('div', { className: 'ptp-h' }, title, note ? h('span', null, note) : null)
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

    function modeLabel(data) {
      const m = modeOf(data)
      if (m.scope === 'global') return data.status.enabled ? '全局注入' : '已停用'
      if (!m.probe || m.probe.available === false) return '无模式服务'
      if (m.registered === true) return '破甲模式'
      if (m.registered === false) return '预设缺失'
      return '模式探测中'
    }

    function modeTone(data) {
      const m = modeOf(data)
      if (m.scope === 'global') return data.status.enabled ? 'ok' : 'warn'
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
            title: `头段 point`,
            note: `${fmt(data.head.chars)} 字符 · ${fmt(data.head.lines)} 行 · order ${data.config.order}`,
          }),
          h('div', null, h('button', {
            className: 'ptp-btn', type: 'button', onClick: () => onCopy(data.head.text),
          }, '复制头段')),
          h('pre', { className: 'ptp-pre', 'data-empty': String(headEmpty) },
            headEmpty ? '未注入：position 不含 head。' : data.head.text)),
        h('div', { className: 'ptp-sect' },
          h(SectionTitle, {
            title: '尾锚 point:tail',
            note: `${fmt(data.tail.chars)} 字符 · order ${data.config.tailOrder}`,
          }),
          h('div', null, h('button', {
            className: 'ptp-btn', type: 'button', onClick: () => onCopy(data.tail.text),
          }, '复制尾锚')),
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
        h('div', { className: 'ptp-cards' },
          h(Card, { label: '开关', value: ev.armed ? '已开启' : '已关闭' }),
          h(Card, { label: '轮次', value: `${ev.round}`, unit: `/ ${ev.maxRounds}` }),
          h(Card, { label: '阶段', value: ev.phase || 'idle' }),
          h(Card, { label: '轨道', value: trackLabel(ev.tracks) }),
          h(Card, { label: '保留', value: `${ev.kept}`, unit: `/ ${ev.ledger} 轮` })),
        h('div', { className: 'ptp-note' },
          ev.phase === 'done'
            ? `本轮预算（${ev.maxRounds} 轮）已用完，链保留；点「开启」开始新一轮，台账会归档。`
            : '提示词轮：定层 → 金丝雀 → 选算子 → 8 个候选 → 小样本 → 全量 → 密封。代码轮：GitHub 检索 → 写完整文件 → 沙盒副本跑全套测试 → 通过才落地。跑完一轮按节奏等下一轮，同时要等你静默。'),
        h('div', { className: 'ptp-actions' },
          h('button', {
            className: 'ptp-btn ptp-primary', type: 'button', disabled: !!busy,
            onClick: () => onAction(ev.armed ? 'stop' : 'start'),
          }, ev.armed ? '关闭自动迭代' : '开启自动迭代'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy,
            onClick: () => onAction('round'),
          }, busy === 'round' ? '跑一轮…' : '跑一轮'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy,
            onClick: () => onAction('rollback'),
          }, '回滚上一轮'),
          h('button', {
            className: 'ptp-btn', type: 'button', disabled: !!busy,
            onClick: () => onAction('publish'),
          }, '同步仓库')),
        h('div', { className: 'ptp-list' },
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
            label: '轨道',
            value: `${trackLabel(ev.tracks)}${ev.research === false ? ' · 不检索' : ' · 代码轮先检索 GitHub'}`,
          }),
          h(Row, {
            label: '空闲才跑',
            value: ev.idleOnly ? `是 · 静默 ${fmtIdle(ev.idleMs)}` : '否 · 一直跑',
            tone: ev.idleOnly ? 'ok' : 'warn',
          }),
          h(Row, { label: '仓库', value: ev.repo || '未配置' }),
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
          })),
        last ? h('div', { className: 'ptp-list' },
          h(SectionTitle, { title: '上一轮' }),
          h(Row, { label: `第 ${last.round} 轮 · ${last.track === 'code' ? '代码' : '提示词'}`, value: last.decision || '—' }),
          last.title ? h(Row, { label: '改动', value: last.title }) : null,
          last.files && last.files.length ? h(Row, { label: '文件', value: last.files.map((file) => file.path).join('、') }) : null,
          last.tests ? h(Row, {
            label: '测试',
            value: `${last.tests.pass || 0} 通过${last.tests.fail ? ` · ${last.tests.fail} 失败` : ''}`,
            tone: last.tests.ok ? 'ok' : 'warn',
          }) : null,
          last.research ? h(Row, { label: '检索', value: `${last.research.hits || 0} 个参考项目` }) : null,
          h(Row, {
            label: '端到端',
            value: last.e2e ? `${pctOf(last.e2e.before)} → ${pctOf(last.e2e.after)}` : '—',
          })) : null,
        (ev.history || []).length ? h('div', { className: 'ptp-list' },
          h(SectionTitle, { title: '台账', note: `${ev.history.length} 轮` }),
          ev.history.map((row) => h(Row, {
            key: `h${row.round}`,
            label: `#${row.round} ${row.track === 'code' ? '代码' : (row.axis || '提示词')}`,
            value: row.track === 'code'
              ? `${row.decision || '—'}${row.title ? ` · ${row.title}` : ''}${row.tests ? ` · ${row.tests.pass || 0} 测试` : ''}`
              : `${row.decision || '—'}${row.eval && row.eval.e2e ? ` · ${pctOf(row.eval.e2e.after)}` : ''}`,
            tone: row.decision === 'keep' ? 'ok' : row.decision === 'revert' ? 'warn' : null,
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
        const tick = () => {
          if (document.hidden) return
          fetchState().then((data) => {
            if (alive) setView({ kind: 'ready', data })
          }).catch((error) => {
            if (!alive) return
            setView((prev) => (prev.kind === 'ready'
              ? { kind: 'ready', data: prev.data, stale: errText(error) }
              : { kind: 'error', error: errText(error) }))
          })
        }
        tick()
        const id = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(id) }
      }, [nonce])

      const onEvolve = useCallback((action) => {
        setBusy(action)
        postEvolve(action).then((result) => {
          setToast(action === 'round' ? '已开跑' : '已执行')
          if (result && result.error) setToast(`失败：${result.error}`)
        }).catch((error) => {
          setToast(`失败：${errText(error)}`)
        }).then(() => {
          setBusy('')
          setNonce((n) => n + 1)
        })
      }, [])

      const onCopy = useCallback((text) => {
        copyText(String(text || ''), () => {
          setToast('已复制')
          setTimeout(() => setToast(''), 1400)
        })
      }, [])

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
          h(PointIcon, { size: 18 }),
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
              h('div', { className: 'ptp-cards' },
                h(Card, { label: '头段 point', value: fmt(data.head.chars), unit: '字符' }),
                h(Card, {
                  label: '尾锚 point:tail',
                  value: data.tail.chars ? fmt(data.tail.chars) : '未启用',
                  unit: data.tail.chars ? '字符' : '',
                }),
                h(Card, { label: '生效规则', value: `${data.rules.active}`, unit: `/ ${data.rules.total}` }),
                h(Card, {
                  label: '装配观测',
                  value: fmt(data.evidence.count),
                  unit: `${data.evidence.scopes} 作用域`,
                })),
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
