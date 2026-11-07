---
name: campaign-planning
description: 多靶标 / 多阶段作战计划编排：阶段划分、并行度、依赖关系、时间盒、产出物与派活模板
whenToUse: 一次演练有多个靶标、或单个靶标要跨多天多阶段推进，需要先编排计划再派活时
role: plan
enabled: true
---

# 作战计划编排（多靶标 / 多阶段）

主会话（指挥）的编排手册。目标是把"一堆待打的资产"变成"一张有依赖、有先后、有时间盒的执行图"，
让每个执行角色拿到的是**一条可独立完成的任务**，而不是"你去看看这个单位"。

## 一、开工前先定死五件事

| 项 | 要写清的 | 写在哪 |
| --- | --- | --- |
| 目标与得分口径 | 打到什么算完成（哪些得分点、多少分） | 靶标备注 + `redteam_score_list` 基线 |
| 范围边界 | 资产段 / 域名清单 / 明确排除项 | `redteam_engagement_open` 的 `scope` |
| 时间盒 | 总窗口 + 每阶段时长 | 本文件第二节的比例，落到 `runs/plan-<date>.md` |
| 噪声预算 | 允许主动扫描的目标比例、爆破并发上限 | 派活时随任务下发（见第五节模板） |
| 停止条件 | 什么情况换面 / 收手（打不动、被封、超时） | 派活任务的"退出判据"字段 |

先把这五项写成 `runs/plan-<YYYYMMDD>.md`，后面所有派活都引用它 —— 计划落在文件里才好复盘。

## 二、五阶段骨架（与攻击链 stage_code 一一对应）

```
recon ──► internet ──► boundary ──► internal ──► target
信息收集   互联网侧权限   边界突破     内网权限     靶标权限
```

| stage_code | 输入 | 主要动作 | 产出物（落库工具） | 退出判据 |
| --- | --- | --- | --- | --- |
| `recon` | 单位名 / 主域名 / 已知 C 段 | 子域、C 段、端口指纹、暴露面排序 | `redteam_asset_add`（`provenance` 如实填主动/被动） | 资产面收敛：新增资产增速趋近 0 |
| `internet` | 排序后的外网资产 | 弱口令、未授权、Nday/1day、上传、注入 | `redteam_vuln_add` + `redteam_access_add` + `redteam_credential_add` | 高价值面打完或全部试过一遍 |
| `boundary` | 已控外网主机 | 搭隧道、出网通道、边界设备/网闸处置 | `redteam_tunnel_add` + `redteam_chain_add`（`stage_code=boundary`） | 隧道稳定可复用（连续两次 `redteam_session_check` 正常） |
| `internal` | 隧道 + 内网段 | 内网测绘、横向、提权、数据库/备份系统 | `redteam_asset_add` + `redteam_access_add` + `redteam_chain_add` | 核心段资产清单成型 |
| `target` | 靶标清单 | 拿靶标系统管理员权限、固化证据 | `redteam_score_hit` + `redteam_evidence_record` + `redteam_shot_add` | 得分点确认拿下 + 证据可复现 |

## 三、阶段内的时间盒比例（按总窗口切）

| 阶段 | 建议占比 | 超时处理 |
| --- | --- | --- |
| recon | 15% | 收敛后即停，别追求"资产清完" |
| internet | 30% | 未出货的面降级为"待复验"，转下一批目标 |
| boundary | 10% | 隧道不通就换通道（suo5 / frp / chisel 交替试） |
| internal | 30% | 保住已有成果，剩余时间交给 `target` |
| target | 15% | 留出收口时间：报告 + 得分核对 |

时间盒到点后做一次"留/弃"判断，把结论写进计划文件；继续打就明确"再加多久、换什么打法"。

## 四、并行度与依赖

可并行（互不依赖，适合同时派出去）：

- 不同 C 段 / 不同子域的 `recon`（每段一个执行角色）。
- 同一批资产的**被动**信息收集与**主动**指纹识别（被动先跑，主动分批）。
- 多个互不相关的 Web 面 `internet` 任务（每台一个角色，各自独立落库）。

需要串行（有真实依赖）：

- `boundary` 依赖至少一台已控主机 → 等某个 `internet` 任务出货后再动。
- `internal` 依赖隧道就绪 → 等 `boundary` 的隧道验证通过。
- `target` 依赖内网测绘结果 → 等 `internal` 交回资产清单。
- 同一目标的**破坏性动作**（改配置、关服务、写文件）串行执行，避免互相覆盖。

并发建议上限（按常见家宽 / 单 VPS 出口）：

```bash
# 每批主动扫描的目标数：3–5 个互相独立的段
# 单目标端口扫描并发：见 dir-bruteforce / active-scan 技能里的速率建议
# 爆破并发：hydra -t 4（SSH/RDP 更低），同一账号 1 个并发
```

依赖图用最简文本表达，直接贴进计划文件：

```text
recon-A ──┐
recon-B ──┼─► internet-A ──► boundary-A ──► internal-A ──► target-A
recon-C ──┘        └─► internet-B（独立，可并行）
```

## 五、派活模板（可复制）

派给执行角色时，把下面字段填满再下发 —— 缺字段的派活必然来回追问：

```text
角色: [ROLE]            # recon | assess | vuln-scan | exploit | internal
阶段: [STAGE_CODE]      # recon | internet | boundary | internal | target
目标: [TARGET]          # IP / CIDR / 域名 / URL（一次一片，别给整个单位）
已控前提: [ENTRY]       # 可用跳板、隧道端口、已有凭据的引用名
允许动作: [ACTIONS]     # 端口扫描 / 指纹 / 弱口令（并发上限 N） / 只读验证
噪声预算: [NOISE]       # 允许的并发与速率上限
时间盒: [TIMEBOX]       # 例如 90 分钟
退出判据: [EXIT]        # 例如 拿到 1 个管理员账号或试完全部入口
落库要求: 资产→redteam_asset_add；漏洞→redteam_vuln_add；步骤→redteam_chain_add(stage_code=…)
交付物: 回话里给三行——拿到了什么 / 命令原文 / 证据在哪（文件路径 + ev_id）
```

## 六、多靶标编排

1. **同类打包**：把"同构目标"（同厂商 OA、同型号设备、同类云平台）放同一批，
   一个出货后其余走复用路线（`redteam_poc_search` 直接命中）。
2. **知识库是跨靶标的杠杆**：每批开工前先 `redteam_poc_search`（组件 + 编号），
   出货后 `redteam_poc_add` 回填（带 `category` + `engagement` + `asset_target` + `verified_note`）。
3. **靶标间不共享结论、只共享手法**：某单位的凭据、资产结论留在该靶标库内，别混用。
4. **排期表**：一张表两列——靶标 / 当前阶段 + 下一步动作，每天更新一次。

## 七、每日节奏

```text
开工：redteam_preflight  → 看环境与工具是否就绪
扫一眼：redteam_score_list（当前得分与缺口）→ 定今天打哪几项
开工中：redteam_asset_timeline（收集有没有断层）
长任务前后：redteam_session_check（隧道/会话是否还活着）
收工：把当日结论写进 runs/plan-<date>.md，更新排期表
```

## 八、产出物与命名

```text
runs/<YYYYMMDD>-<target-slug>/
  plan.md              # 五件事 + 依赖图 + 时间盒
  recon/               # 原始扫描输出（nmap/httpx/fscan 原始文件）
  evidence/            # 原始请求响应、截图、导出样本
  logs/                # 命令与回显（含时间戳）
```

计划文件与证据目录同名同层级，复盘时能按时间线一条条对上。
