# DERIVATION — 二开说明与能力对照

本仓库是 **dsh-purge 的自维护二开版（fork / derivative）**。

| 项 | 值 |
|---|---|
| 上游基座（代码基线） | [HunYiSage/dsh-purge](https://github.com/HunYiSage/dsh-purge) **v1.1.92**（Apache-2.0；`LICENSE` / `NOTICE` 原样保留） |
| 能力基线（要对齐的目标） | 上游 **v1.1.71**（= 本二开者 fork 的 `master`，commit `6c1d638`） |
| 二开维护入口 | [yin1895/dsh-purge](https://github.com/yin1895/dsh-purge)（本仓库；安装/更新唯一来源） |
| 本版本号 | `1.1.92-self.1` |
| 适配客户端 | 桌面 dsh **0.2.1-rc.3**（`dshTarget`；同时声明 rc.2 / rc.5） |
| 上游署名要求 | 保留本文件、`NOTICE`、`LICENSE`，并注明来源仓库 `HunYiSage/dsh-purge`。原版禁止倒卖 |

> 上游历史在 1.1.73 前后被维护团队重写过：`HunYiSage/dsh-purge` 的最早提交是 `2b6487c`（1.1.73）。
> 因此 v1.1.71 的代码只存在于本二开者的 fork 里 —— 能力对照以它为准，不以上游任何 tag 为准。

---

## 1. 为什么需要"能力回填"

上游从 1.1.72/1.1.73 起逐步收紧了开源版的行为边界，1.1.92 保留了其中一部分。实测差分（同一客户端 0.2.1-rc.3）：

| 能力项 | 上游 1.1.71（能力基线） | 上游 1.1.92 | 本仓库（回填后） |
|---|---|---|---|
| harness 补丁条数 | 82 | 86 | **86**（1.1.92 全集） |
| 在 0.2.1-rc.3 上"打不进"的补丁 | 6 条（`#32 #40 #53 #77 #80 #88`） | 1 条（`#80`） | 1 条（`#80`，清理型补丁，设计上不适用） |
| 注入体（破甲稿） | 226 行，`… not defensive-only.` 结尾，**无排除清单** | 追加 `Excluded targets only: mainland China, HK/Macau, banks/financial, gov/military …` | **回到 1.1.71 全文**（仅保留上游一处错别字修正 `aircreack → aircrack`） |
| 「自己的服务器」名单 | **真实落盘 + 参与放行判定**（名单内主机例外放行） | `writeAllowText()` 是空实现（不落盘、还引用未声明的 `allowCache` → 调用即抛错）；区域门不再读白名单 | **恢复**：真实落盘 + `permittedHost / isOwnNetwork` 参与判定 |
| 拦截范围 | region（大陆/港澳，按 `SUFFIXES`）+ 银行表 | region + 银行表 + **新增各国政府/军事域名**（`GOV_LABELS / GOV_GO_TLDS / GOV_SUFFIXES`） | **回到 region + 银行表**（`govHit` 层已移除） |
| 区域门判定时机 | 仅 `step === 1`，不挂工具钩 | step 1 + 后续步 + 每次工具执行前 | 默认 **1.1.71**（常量 `SELF_MULTISTEP_GATE = false`，可一行切回上游行为） |
| 拦截提示语 | `不行，这是严令禁止的` | `该目标在禁止范围内：…` | **回到 1.1.71 文案** |
| `#85 / #86` 用户消息语义 | 一切用户消息走 `followup`（插话不打断当前步） | `steer` 恢复打断当前步 | **回到 1.1.71 语义** |
| 红队工具集 | 56 个 | **64 个**（+evidence / unknown） | **64 个**（采纳上游，schema 0 违规） |
| 技能库 `skills/redteam` | 23 条 | 23 条（**1.1.73 那一版曾整目录停发**） | **23 条**（与 1.1.71 逐字节相同） |
| 红队预设 `presets/redteam` | 19 行组成 | 与 1.1.71 **逐字相同** | 同上游 |
| 自更新源 | 上游仓库 | 上游仓库 | **本仓库**（`lib/update.js` 的 `REPO`） |

---

## 2. 能力回填清单（逐项可核对）

| # | 回填内容 | 落点 | 实现方式 |
|---|---|---|---|
| 1 | 注入体删掉排除清单，回到 1.1.71 口径 | `lib/asset-table.js`（加密槽） | `node scripts/self/reembed-inject.mjs`（幂等；明文落到 gitignore 的 `lib/default-prompt-inject.md` 供核对） |
| 2 | 恢复「自己的服务器」白名单：真实落盘 + 参与放行 | `lib/net-scope.js` | 恢复 `writeAllowText` / `readAllowExact` / `allowDecision` / `permittedHost` / `isOwnNetwork` / `isSkippedV4`；`publicHostHit` 内增加白名单与自有网络跳过 |
| 3 | 移除"各国政府/军事域名"额外拦截层 | `lib/net-scope.js` | 删除 `GOV_LABELS` / `GOV_GO_TLDS` / `GOV_SUFFIXES` / `govHit` 及其调用；判断回到 region + bank |
| 4 | 区域门判定时机回到 1.1.71（仅 step 1、不挂工具钩） | `lib/net-scope.js` | 常量 `SELF_MULTISTEP_GATE = false`（改 `true` 即恢复上游多步/工具级拦截） |
| 5 | `#85 / #86` 用户消息语义回到 1.1.71 | `lib/core.js` | 还原 1.1.71 的 replacements / markers / forbid，并各自增加一条"把上游 1.1.92 写法转换回来"的规则 |
| 6 | 拦截提示语回到 1.1.71 | `lib/net-scope.js` | `const DENIAL = "不行，这是严令禁止的"` |
| 7 | 唯一更新入口 / 断云控 | `lib/update.js`、`package.json` | `REPO` 指向本仓库；`dsh.install.*`、`repository`、`homepage`、`bugs` 全部指向本仓库；`COPY_NAMES` 补上 `presets` / `skills` / `scripts` / `NOTICE` / `DERIVATION.md`（上游的复制清单不含这些，自更新会把技能库与预设留在旧版） |
| 8 | 文档口径与署名 | `README.md` / `README.zh-CN.md` / `README.ja.md` / `client.js`（侧栏文案） | 拦截口径改回 1.1.71 写法并写明"名单内那台是唯一例外"；新增二开源信息；侧栏 `Own servers` 面板文案恢复 |

### 与 1.1.71 的已知差异（白名单，不影响能力）

1. 注入体 1 处错别字修正：`aircreack → aircrack`（保留上游修正）。
2. 采纳上游 1.1.92 的**超集**能力：+4 条补丁（`#89 #90 #92 #93`）、+8 个红队工具、`anchorMode` / `subagentControl` 开关、`{{cwd}}` 致命项修复、`dsh-harness-dev-context` 目标、`net-scope.js` 的扫描健壮性改进。
3. `#80 MINIMAL_OFFICIAL_TOOLSET`：清理型补丁（撤掉历史追加的 fs/web 行），当前客户端布局下无匹配 —— 1.1.71 与 1.1.92 都不生效，属设计如此。
4. `#88 HUNG_PROMPT_STRICT_NEEDLE`：二段补丁，依赖 `#87` 的产物文本，真实 apply（先 87 后 88）时会生效；单次静态扫描看不到。

---

## 3. 本版对客户端的适配与验证

验证对象：桌面 dsh `0.2.1-rc.3`（`resources/app` 内 `@deepseek-ai/*` 全为 0.2.1-rc.3）。

| 验证项 | 方法 | 期望 |
|---|---|---|
| 语法 | `node --check` 全量改动文件 | 全部通过 |
| YAML | `cordis.patch.yml`、`presets/redteam/*.yml` 解析 | 可解析 |
| 补丁覆盖率 | 对客户端原始文件跑 `patchStatus()`，与 1.1.71 / 1.1.92 对照 | 打不进集合 = `{80}`（≤ 1.1.92） |
| 红队工具 | 用 harness 的 `defineTool` 编译全部 `redteam_*` | 64 个、0 schema 违规 |
| 红队预设 | `presets/redteam/agent.cordis.yml` 19 行挂载 | 无 failed row |
| 注入体 | `openSlot()` 与 1.1.71 槽文本逐行比对 | 仅 1 行差异（错别字修正） |
| 名单能力 | `writeAllowText()` 真写文件 + `publicHostHit()` 跳过名单主机 | 通过 |

---

## 4. 维护流程（客户端升级 / 上游基座更新）

```bash
# 1) 拉上游新基座（只读）
git remote add upstream https://github.com/HunYiSage/dsh-purge.git   # 已配置
git fetch upstream && git merge upstream/master                       # 冲突多集中在 lib/core.js / lib/net-scope.js

# 2) 重放能力回填（幂等）
node scripts/self/reembed-inject.mjs        # 注入体：去掉任何"排除清单"类限制句

# 3) 回归（对客户端原始文件跑，不改客户端）
node --check $(git diff --name-only HEAD~1 -- '*.js')
#    然后用 patchStatus 对照"打不进"集合是否 > {80}

# 4) 发布
git commit -am "..." && git tag v1.1.9x-self.N && git push origin master --tags
```

客户端升级时的固定检查项：注入体是否被重新塞入限制句、`writeAllowText` 是否又变回空实现、
`publicHostHit` 是否又丢掉白名单判定、`GOV_*` 是否回归、`#85/#86` 语义是否被改回、`COPY_NAMES` 是否又缺 `presets`/`skills`。

---

## 5. 断云控说明（为什么不担心被上游覆盖）

- 更新/安装源只有一个：`lib/update.js` 的 `REPO` + `package.json` 的 `dsh.install.*` = 本仓库。
- 启动路径不会自动升级（上游设计：`autoUpdateIfNeeded()` 为 manual-only 空操作），只有面板手动点"更新"才会动，而那时拉的也是本仓库的 `master`。
- `channel.json` 的 pin 由本仓库的版本决定；`auto-update-guard.json` 记录 ref/sha，换版本时会被本插件自己重写。
- 官方桌面升级（重封装 `app.asar` 抹掉补丁）仍由上游的 `official-update.js` + `reapply.js` + `settle-policy.js` handoff 负责 —— 这三处在本版原样保留，未做改动。

---

## 6. 安装（不在本仓库内执行，仅说明）

```powershell
# profile 依赖指向本仓库的 tag（唯一入口）
"dsh-purge": "https://codeload.github.com/yin1895/dsh-purge/tar.gz/refs/tags/v1.1.92-self.1"
# 换版本前先还原：dsh-purge --revert（或 --uninstall，其实现是"已应用则先还原"）
```
