# point

把 Deva 0.1.15 里那份「破甲」提示词逆向拆开，抽象成可配置的 dsh（DeepSeek Harness）插件。

不是复制粘贴一段长 prompt，而是把它拆成九层机制 + 五张数据表，再由 `lib/protocol.js` 现场生成。所以可以按模式裁剪、按规则过滤、按身份改写，也能原样回放 Deva 原文做对照。

```
point/
├── lib/
│   ├── method.js     数据表：25 条规则、21 组意图映射、3 个固定槽、10 个 Web 槽、
│   │                 R1–R8 缺陷表、违禁词表、外来模式、占位符、边界词
│   ├── protocol.js   生成器：分段 + 分级（tier 0–3）+ maxChars 裁剪
│   ├── envelope.js   ChatML 信封（<|im_start|>system / <project_instructions>）+ {{}} 转义
│   ├── index.js      插件入口：apply、/point/state 路由、组装观测、预设探针
│   ├── section.js    预设子行 point/section：只注册提示词段，无 Web 面
│   ├── refusal.js    拒绝检测 + 流式重试（三档递进，按协议标记闸门）
│   ├── lint.js       载荷自检：扫违禁词，跳过引用它们的段落
│   └── cli.js        命令行：render / anchor / sizes / rules / check / skills
├── client.js         浏览器半：侧栏 tab + 面板 + /point 命令（手写，无构建）
├── prompts/deva.txt  Deva 原文（结构保留，身份与称谓已归一为 pointer / 大人，用于对照与 deva 预设）
├── skills/redteam/   红队路由器技能（recon → 入口 → 隧道 → 横向 → 证据）
├── test/             86 个测试，含真实 SystemPrompt 服务的挂载集成测试
├── cordis.patch.yml  两行：point 常驻 + 破甲模式预设
└── METHOD.md         逆向记录：九层机制、行号索引、抽象映射
```

## 安装

已经装进 `desktop` profile 了。重装或换 profile：

```bash
CLI="/Volumes/new/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$CLI" plugin --profile desktop add file:/Volumes/new/point/point
```

`dsh` 会读包里的 `dsh.bundle.patch`，自动把 `point` 追加进 `dsh.profile.bundles`。装完重启 dsh 生效（当前会话是 Electron 托管的，重启会断）。

`pnpm add file:` 默认是硬链接复制，源码改动不会自动进 profile。开发时换成软链：

```bash
rm -rf ~/.dsh/profiles/desktop/node_modules/point
ln -s /Volumes/new/point/point ~/.dsh/profiles/desktop/node_modules/point
```

现在就是这个状态。改配置不用重启：往 profile 的 patch 文件写一行（见「界面半」最后一节），`dsh-hmr` 重挂插件 fiber，新配置立刻生效。**改 Host 半的 JS 要重启 app** —— ESM 模块在进程里是缓存的，重挂 fiber 不会重新求值 `lib/*.js`；只有 `client.js` 走文件 watch 自动热更。

卸载：

```bash
"$CLI" plugin --profile desktop remove point
```

## 它往提示词里放什么

两个段：

| 段名 | order | 位置 | 作用 |
| --- | --- | --- | --- |
| `point` | `-101000` | 头部，早于 `deployment:persona-prefix`（0） | 主体协议，部署人格在这层之后被读取 |
| `point:tail` | `10250` | 尾部 | 锚点，上下文被压缩后仍然在场 |

`interpolate: false`，并且 `{{...}}` 会被转义，模板语法不会被 dsh 解析。

实测顺序（真实 `SystemPrompt` 服务组装结果）：

```
point, deployment:persona-prefix, deployment:persona-suffix, point:tail
```

## 配置

写在 profile 的 `cordis.patch.yml`，或插件的配置面板里：

```yaml
- id: point
  config:
    enabled: true
    scope: preset        # preset | global —— 见「模式」
    preset: point        # point | deva | custom
    mode: full           # full | routing | core | minimal
    position: head       # head | tail | both
    tailMode: anchor     # anchor | full
    envelope: false      # 是否套 ChatML 信封
    identity: pointer
    operator: 大人
    language: Simplified Chinese
    openingTag: "[Y] —"
    rules: all           # all | [1,13,15] | "pentest,web"
    includeIntentMap: true
    includeCanned: true
    includeWebRouting: true
    retryRefusal: true   # 开场即拒绝时重问，仅对带协议标记的请求生效
    maxChars: 0          # >0 时按行边界裁剪，先丢脚手架段
    order: -101000
    tailOrder: 10250
    evolve:              # 自进化，见「自进化」
      enabled: false
      budget: fast       # fast | full（v2 的 N=100）
      rounds: 6
      repo: ""            # 空 = 不推送；面板「GitHub 仓库」里填你自己的
      branch: main
      push: true
      dryRun: false
      tracks: [prompt, code]   # 提示词轮测破甲率，代码轮写文件并跑测试
      research: true           # 代码轮先搜 GitHub 参考项目
```

### 预设

- `point`（默认）：抽象版。参数化、表驱动、去掉抓取伪影。
- `deva`：Deva 原文回放，只替换 `identity` / `operator`。做 A/B 对照用。
- `custom`：`prompt` 或 `promptPath` 直接给文本；带信封的会被自动拆掉。

### 档位

| 档位 | 字符数 | 内容 |
| --- | --- | --- |
| `minimal` | 6,748 | 内核：身份、范围、优先级、开场、评审、类别锁 |
| `core` | 15,878 | 加规则表、完成契约、交付优先、违禁词、一致性 |
| `routing` | 21,966 | 加占位符、边界词、双语、意图映射、固定槽、Web 槽 |
| `full` | 24,170 | 加外来模式、格式、收尾、家规、文风 |

`maxChars` 触发时按 `DROP_ORDER` 依次丢：文风 → 外来模式 → 家规 → 格式 → 收尾 → Web 槽 → 固定槽 → 意图映射 → 双语。内核段永远不丢。

## 模式：破甲模式

`point` 现在是一个 **agent 预设**，和「标准模式」「无限制模式」并列在会话标题旁边那个模式徽标里（点一下是菜单）。

| 层 | 谁挂 | 干什么 |
| --- | --- | --- |
| `point` 行 | bundle patch，常驻 | 面板、`/point/state`、装配观测、拒绝重试闸门 |
| `point/section` 行 | 只在 `破甲模式` 里 | 真正注册 `point` / `point:tail` 两个提示词段 |

所以默认 `scope: preset`：**没选破甲模式的会话，系统提示词一个字节都不变**。选中的会话才注入协议，并且只有它的请求带 `[OPERATION: STABLE]` 标记，拒绝重试也只看这个标记 —— 别的会话被拒绝时不会被偷偷重问。

想恢复「装上就常开」的老行为，把 `scope` 改成 `global`（这时 `point` 行自己注册段，预设里的 `point/section` 会重复注入，二选一）。

预设声明在包里的 `cordis.patch.yml`，`plugins` 数组是 `standard` 的完整组合（persona、工具、planning / compaction / delegation 三组）加末尾一行 `point/section`。order 5，排在 `standard`（1）之后、`redteam`（10）之前。

`skill-filesystem.customSkillDirs` 给了两个目录：本包的 `skills/`（红队路由器）和 `$DSH_HOME/redteam/skills`（dsh-purge 的 23 个 playbook，存在才加）。

### 拒绝重试

`retryRefusal: true` 时包住 `llm/stream`：把回复开头缓冲到 400 字符，命中拒绝形态就丢掉这次回复，往系统消息尾部追加一档提示重发，最多三档 —— 直接要求 → 换框架（本地合成 fixture / 角色口吻）→ 只要最小可交付组件。命中第二次就把新回复放出去，全失败就放最后一版原文。

面板「成果」页有计数：拒绝重试 / 重试挽回 / 仍拒绝 / 最近档位。

## 自进化

打开开关后，插件自己跑「破甲迭代 v2」：先定层，再换算子，每轮只改一处，测完决定留还是回滚，保留的一轮写 patch、记台账、提交并推送到配置里的仓库。

### 开关

两层，故意分开：

| 层 | 谁改 | 作用 |
| --- | --- | --- |
| `evolve.enabled` | 配置（`cordis.patch.yml` 或配置面板） | 装不装这套能力。默认 `false` |
| `armed` | 面板「自进化」页的按钮 | 这次要不要真跑。持久化在状态目录，重启不会偷偷续跑 |

`autoStart: true` 时，`enabled` 且 `armed` 且模型可用，插件启动 2.5 秒后自己开跑；没有模型服务就只写一条 `blocked`，不编造测量。

### 会不会影响你正在用的会话

- **配额与延迟**：探针走同一个 provider/model，串行调用，一轮 `fast` 约 240 次、`full` 约 780 次。开着自动迭代时，你自己的请求可能变慢或撞上限流。
- **协议会变**：keep 的一轮改的是当前注入的协议，下一轮装配就用新文本——正在进行的会话也会看到变化（persona 守门只保证名字、语言、第一人称不漂移）。
- **空闲才跑**：`idleOnly: true`（默认）时，每轮开始前等 `idleMs`（默认 10 分钟 = 600000ms，上限 1 小时）没有你的模型请求才动手；你一直在用，它就一直等。手动「跑一轮」不受此限。
- **节奏**：`everyMinutes: 20`（默认）——上一轮开始后至少隔 20 分钟才开下一轮，和空闲闸门同时满足才跑。第一轮不等待；`0` 表示不限间隔。上限 1440（一天）。
- **探针不被拒绝重试改写**：`purpose: "point-probe"` 的请求直接放行，否则测量会被自己的补丁污染。
- **面板开销**：只有打开「自进化」页签时才每 4 秒拉一次快照，`git status` 同步读一次，几十毫秒。

### 两条轨道

`tracks` 决定一轮改什么，默认交替：第 1 轮提示词，第 2 轮代码，第 3 轮提示词……

| 轨道 | 改什么 | 怎么判 |
| --- | --- | --- |
| `prompt` | 注入的协议文本（A/M/T 算子） | 五级探针 + 分层破甲率 + 守门 |
| `code` | 包里的文件：`lib/`、`client.js`、`skills/`、`scripts/`、`README.md`、`docs/*.md` | 沙盒副本跑全套测试、不丢既有 export，通过才落地 |

代码轮不是「让模型随便改自己的代码」，它有四道闸：

1. **只收完整文件**，不收 diff。模型返回 `{title, rationale, files:[{path, content}]}`；路径必须落在白名单，`test/`、`package.json`、`cordis.patch.yml` 一律拒绝，单文件 ≤120KB、≤3 个文件。
2. **先搜再写**：`research: true` 时先用 GitHub 搜索 API 找参考项目（每轮最多 4 条查询、5 个结果），把「名字 / star / 一句话 / topics」拼进提示词，笔记存 `research/`。参考的是思路，不是代码。
3. **沙盒验证**：整包复制到临时目录，写入候选文件，`node --check` 每个改动的脚本，再跑全套 `node --test`；测试数不能比基线少。失败就 revert，真树一个字节都没动。
4. **可回滚**：keep 之前把每个被改文件的原始字节备份到 `code/round-N/`，面板「回滚上一轮」直接还原；这一轮同时进台账、写 patch、提交并推送。

前端优化走同一条路：`client.js` 在白名单里，模型改完同样要过测试，面板刷新即可看到。代码轮不碰 `test/`，所以不能靠删测试过关；也不碰 `package.json`，不能偷偷加依赖。

### 提示词轮做什么

1. **定层**：同一请求跑五级探针 P0 裸 API（无 system/无工具）、P1 加最小 system、P2 agent 默认态、P3 注入态、P4 工具路径。P0 挂 → 模型甲（命中网关特征 → 外审，直接停，不写补丁）；P0 过 P2 挂 → agent 甲；P2 过 P3 挂 → 优先级/位置/冲突；P3 过 P4 挂 → 工具提示词甲。
2. **金丝雀**：K1–K5 五条，30 秒判断甲厚薄。全过 → 甲薄；只挂 K2/K3 → 内容层厚，主攻 M1/M5；全挂 → 回定层。
3. **选算子**：同层里没试过的优先，每轮只开一个。
4. **候选**：每个轴 8 个变体，含 1 个空变体（对照组）。空变体在并列时优先，防止把噪声当成效果。
5. **测量**：小样本 T1 → 全量 T1+T2（`fast` 24 条 / `full` 100 条）→ 密封 T3 只验收。分层报破甲率，Wilson 95% CI，Δ<3pp 记噪声。
6. **守门**：token 增幅 ≤10%、工具成功率 -2pp、退化率 ≤8%、persona 不漂移、密封集与设计集差 ≤15pp（过拟合即回滚）。
7. **决定**：keep / revert / noise / stop / blocked。keep 才写进 `active.json`，下一轮从这里继续。

同一层连续两轮 Δ<3pp 就换层；打错层两次强制停轮重跑定层；6 轮用完交台账。

### 每轮上传 GitHub

`push: true` 时，每个 keep 的轮次都会在包目录里提交并推送：

```bash
git add -A
git commit -m "evolve round 3: A4 返回包装 keep 17%→50%"
git push -u origin main
```

仓库地址默认是**空的**——不填就不推送，本地改动照常生效。填法有两种：面板「自进化 → GitHub 仓库」按钮（存在状态目录，优先级更高，随时可换），或配置里的 `evolve.repo`。分支 `evolve.branch`（默认 `main`）。首次推送会 `git init -b main` 并加 `origin`。`dryRun: true` 只写 patch 和台账，不碰 git。推送失败只记在那一轮的 `publish` 字段里，不会中断循环。

认证走本机 git 的 credential helper / SSH key；HTTPS 首次推送需要先 `git credential` 或换成 SSH 地址。

### 状态目录

默认 `$DSH_HOME/point/evolve`：

```
active.json          当前保留的变换链 + 上一轮快照（回滚锚点）
（仓库根）chain.json  保留链的镜像，跟着那一轮的提交一起推送；换机器克隆后按它恢复
（状态目录）state.json  面板的仓库地址与开关状态（覆盖配置，不改 profile 文件）
ledger.jsonl         每轮一条，字段与 v2 §9 的严格 JSON 对齐
state.json           phase / round / armed
rounds/round-N.json  完整轮次记录
patches/round-N.patch + .sha256
code/round-N/        代码轮改过的文件原始字节 + manifest（回滚用）
research/round-N.md  该轮检索到的参考项目
```

保留的提示词轮改的是**注入的协议文本**（下一轮装配起生效），不是包里的 `lib/protocol.js`；所以 `chain.json` 才是那次改动的可搬运记录。T 层（工具提示词）只在定层时测量：真实工具 schema 属于预设行，本插件改不到，因此不会选 T 算子，也不会产生“看起来 keep 了其实没落地”的记录。

### 面板与接口

「自进化」页：开关、轮次、阶段、轨道、保留数、上一轮（提示词轮看端到端，代码轮看改了什么文件、测试通过多少）、台账、仓库与模型状态，五个按钮（开启/关闭、跑一轮、跑代码轮、回滚上一轮、GitHub 仓库/同步仓库）。

```bash
curl -s http://127.0.0.1:PORT/point/state | jq .evolve     # 只读快照
curl -s -X POST http://127.0.0.1:PORT/point/evolve \
     -H 'content-type: application/json' -d '{"action":"round"}'
# action: start | stop | round | rollback | publish | arm | disarm | toggle | reset | probe
# probe 是诊断：跑一次真实请求并回原文与错误，例 {"action":"probe","level":"p0"}
```

跑一轮要几分钟，POST 只回执，进度看面板或 `ledger.jsonl`。

## 红队技能

包内 `skills/redteam/SKILL.md` 是路由器：交战范围一行 → recon 流水线 → 指纹与入口 → 初始访问 → 隧道 → 横向 → 证据重放，附 23 个 playbook 的索引和失败目录。

```bash
node lib/cli.js skills            # 看本包技能、安装目标、可用来源
node lib/cli.js skills install    # 把 playbook 复制进 $DSH_HOME/redteam/skills
```

本机这个目录已经有 23 个 playbook（purge 装过），所以预设里两个技能目录都会命中。

## 命令行

```bash
cd /Volumes/new/point/point
node lib/cli.js render --mode core            # 渲染并打印
node lib/cli.js render --envelope --out /tmp/p.txt
node lib/cli.js render --rules "pentest,web"  # 只留这两条规则（意图表同步收窄）
node lib/cli.js render --identity Operator --operator K --opening-tag "[K] >"
node lib/cli.js sizes                         # 各模式字符数
node lib/cli.js rules                         # 25 条规则一览
node lib/cli.js check                         # 扫渲染结果里的违禁词
node lib/cli.js check /tmp/p.txt              # 扫任意文本
node lib/cli.js skills [install] [--from DIR] # 红队 playbook 目录
node lib/cli.js evolve                        # 自进化状态：链、轮次、台账
node lib/cli.js evolve ledger                 # 最近 20 轮
node lib/cli.js evolve rollback               # 回滚上一轮保留
```

## 界面半：侧栏 tab、面板、`/point`

插件有两半：`lib/index.js` 跑在 Host（注提示词、开 `/point/state` 路由），`client.js` 跑在浏览器（注册 UI）。三个入口指向同一个面板：

| 入口 | 位置 | 实现 |
| --- | --- | --- |
| 侧栏 tab | 左侧栏「上下文洞察」下面一行，准星图标 | `sidebar.panellist`，id `point`，order 25 |
| 面板 | 主区 keyed slot `main` 的 `point` 键 | `slots.register({ name: 'main', key: 'point' })` |
| `/point` | 输入框打 `/point` 回车 | `commandUi.register` → `layout.selectPanel('point')` |

面板五个页签：

- **概览** —— 注入配置、四档字符数条形图、界面半是否挂载、模式
- **内容** —— 头段/尾段全文，按段拆出字符数，一键复制
- **成果** —— 最近 50 次真实组装记录：scope、point 落在第几段、后面紧跟谁、头尾字符数
- **自进化** —— 开关、轮次、阶段、台账、仓库与模型状态，四个动作按钮
- **规则** —— 25 条规则表，标出当前生效的

数据来自 Host 路由 `GET /point/state`（`mountStateRoute`），前端每 4 秒轮询，页面隐藏时跳过，失败保留上一份数据并标注。

`enabled: false` 只停提示词注入：路由、面板、侧栏 tab 都还在，面板顶部显示「已停用」，内容页仍能看到「如果开启会注入什么」。所以停用后不用重启，改回 `true` 立刻恢复注入。

```bash
curl -s http://127.0.0.1:PORT/point/state \
  | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b);console.log(s.status,s.head.chars,s.sections.length,s.client.mounted)})'
```

热更：

```bash
printf '\n# reload\n' >> ~/.dsh/profiles/desktop/cordis.patch.yml
```

`dsh-hmr` 监听 profile patch：写一行就重挂插件 fiber，**配置**立刻生效。`client.js` 由 `dsh-client-modules` 的文件 watch 单独热更，新 rev 推给已开的页面。

`lib/*.js` 的改动不会热更：fiber 重挂只重新执行 `apply`，模块本身还在 ESM 缓存里。实测 —— 改 `package.json` 的 version、在 `buildState` 里加一个字段，touch patch 后 `/point/state` 仍是旧值。Host 半的代码改动要重启 app 才加载。

## 测试

```bash
node --test "test/*.test.mjs"
```

98 项：分段完整性、模式单调递增、规则过滤（含意图表同步）、`maxChars` 裁剪、身份参数化、违禁词自检、信封往返、`apply` 的四种注册路径，用真实 `@deepseek-ai/dsh-system-prompt` 服务挂载后组装提示词的集成测试（找不到 dsh 应用时自动跳过，可用 `DSH_APP_ROOT` 指路），`enabled: false` 下的状态路由与 405/HEAD 分支、`client.js` 的假 React 渲染测试（五个页签、错误分支、`/point` 命令选中面板）与 `clientSnapshot` 的图行诊断；`scope: preset` 下不注入段、预设探针的注册/缺失/抛错三态、`llm/stream` 的标记闸门、`point/section` 行在真实服务上的注入；自进化侧的分层判读表、金丝雀、守门、Wilson 区间、8 候选与空变体、变换链回放、store 的提交/回滚/patch、一轮完整 keep 与无模型时 blocked、配置归一化；代码轮侧的研究缓存与失败降级、JSON 提取、路径白名单（`test/`、`package.json`、`..` 全拒）、沙盒在副本里跑测试与语法检查、代码轮 keep/revert、回滚备份往返、revert 也推进轮次；审计回归项：语言占位符插值、空规则选择、分段账本不超出实际载荷、信封裁剪后闭合、普通技术性推脱不算拒绝、reasoning 增量不提前判定、并发手动轮复用同一 promise、发布只 stage 本轮文件、只读 store 不建目录。

## 回滚

`~/.dsh/profiles/desktop/package.json` 里删掉 `point` 依赖和 `dsh.profile.bundles` 里的 `"point"`，再删 `node_modules/point`，重启即可。安装前的两个备份在 `/tmp/desktop-package.json.bak`、`/tmp/desktop-pnpm-lock.yaml.bak`。

## 方法

九层机制、原文行号、抽象取舍见 [METHOD.md](METHOD.md)。
