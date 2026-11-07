---
name: evidence-discipline
description: 证据纪律：原始请求/响应的保存、置信度标注（claimed/observed/derived/inferred）、观察与推理与推测的区分、证据归档与复核
whenToUse: 记录作战证据、收到子智能体回报、写报告前核对结论来源时
role: plan
enabled: true
---

# 证据纪律（怎么记，才经得起复核）

报告里每一条结论，都要能回答三个问题：**谁看到的、从什么原始材料看到的、中间推了几步**。
这份技能给的是建议写法与自查清单 —— 照做的好处是交付物自洽、复盘快、别人接手时不用重新问一轮。

## 一、三类信息分开写

| 类别 | 定义 | 写法 | 例子 |
| --- | --- | --- | --- |
| **观察** | 原始工具输出、原始请求响应里直接可见的内容 | 原文摘录 + 命令/URL | `nmap -sV 10.0.0.5` 输出 `22/tcp open ssh OpenSSH 8.2` |
| **推理** | 从观察按确定规则得出，步骤可复现 | 观察 + 推理链 | 由 `root` 回显 + 可读 `/etc/shadow` 推出"主机管理员权限" |
| **推测** | 经验判断、未验证的假设 | 明确标注"推测" + 待验证动作 | "该网段可能还有 3 台同类设备（推测，待扫）" |

一条证据记录里混了这三类，复核的人就无法判断哪部分可信 —— 建议在字段上物理分开：
`result` 放观察，`limitations` 写推理中的假设与边界，待验证项走 `redteam_unknown_record`。

## 二、置信度四级（`redteam_evidence_record` 的 `confidence`）

| 取值 | 含义 | 什么时候用 | 后续动作建议 |
| --- | --- | --- | --- |
| `observed` | 你亲自核实过（自己跑了命令、自己看了回显） | 默认值；主动验证后的标准档 | 可直接进报告 |
| `derived` | 从 `observed` 按规则推理得出 | 结论比原始输出多一步（如"由回显推出权限档位"） | 在 `limitations` 写清推理依据 |
| `inferred` | 推测，尚未验证 | 经验判断、待验证假设 | 标注 + 记一条待验证事项 |
| `claimed` | 子智能体/他人转述，尚未核实 | 收到下级回报、别人转发的截图 | 先按 `claimed` 记，核实后升级 |

`authority`（来源类型）建议与置信度一起写：`tool-output` / `database-record` / `screenshot` /
`request-replay` / `subagent-report` / `operator-input`。
两者组合起来才说明白："这条是子智能体口头说的（claimed + subagent-report）"还是
"我自己重放请求看到的（observed + request-replay）"。

`claimed` 转正的两条路径：

```text
① 自己重放：redteam_evidence_record 记一条 observed（request-replay），supporting_ev_ids 指向原 claimed 的 ev_id
② 哈希核对：redteam_evidence_verify（同一 operation + parameters + result）→ matched=true 才算一致
   不一致时用 redteam_evidence_upgrade 记录"claimed 与实测的差异"，别默默改原记录
```

## 三、原始材料保存建议

HTTP 证据（进报告的主要形态）：

```text
① 用 Burp / Yakit 存原始请求响应；文件名规范：<date>-<target>-<slug>-<序号>.txt
② 命令行场景直接留原始包：
   curl -isS -x http://127.0.0.1:8080 'https://[TGT]/[PATH]' -H 'Cookie: [COOKIE]' | tee runs/[TARGET]/evidence/[NAME].http
③ 落库：redteam_http_evidence_add（method/url/status/request/response 原文，别只写摘要）
④ 报告生成时按漏洞自动附带原始请求 → 所以"能粘贴进 Burp 重放"是验收标准
```

主机/数据证据：

```bash
# 关键回显 + 主机身份一起留一份（证明"这是哪台机器"）
{ hostname; id; uname -a; ip -br a; date -Is; } 2>/dev/null | tee runs/[TARGET]/evidence/[HOST]-identity.txt
# 数据成果留结构与样本，不留整库
mysql -h [DB_IP] -u [USER] -p'[PASS]' -e 'select count(*) from [TABLE];' | tee runs/[TARGET]/evidence/[DB]-count.txt
```

截图建议：`redteam_shot_add` 登记进靶标目录（`kind=screenshot` 表示现场截图；
由当日记录生成的摘录卡记 `kind=card`），文件名里带目标与内容，别用 `1.png`、`2.png`。

## 四、一条证据的推荐字段

```text
operation   : [动作名，如 nmap_scan / webshell_established / sql_injection_confirmed]
parameters  : { "target": "[IP]", "port": 8080, "cmd": "[完整命令]" }   # 参与哈希，写全
result      : { "observed": "[回显摘要/状态码/行数]", "raw_ref": "runs/[TARGET]/evidence/[FILE]" }
confidence  : observed | derived | inferred | claimed
authority   : tool-output | database-record | screenshot | request-replay | subagent-report | operator-input
limitations : ["只扫了 Top1000 端口", "未验证该账号能否读写业务表"]
supporting_ev_ids : ["[EV_ID]"]      # 这条结论依赖的其它证据
source_agent: [AGENT]                # claimed 时填清是谁报的
```

`ev_id` 由内容哈希生成：`operation` / `parameters` / `result` 改一个字就变。
所以**先确认内容再落库**；已经落库的记录被改写会在核对时暴露出来 —— 这一点正好用来验证"下级有没有改口或夸大"。

## 五、归档结构建议

```text
runs/<YYYYMMDD>-<target-slug>/
  evidence/
    http/           # 原始请求响应（每条漏洞一组）
    host/           # 主机身份、命令回显、权限证明
    data/           # 数据成果的样本与条数统计（不外带全量）
    shots/          # 截图（与 redteam_shot_add 登记的文件一致）
  evidence-index.md # 人工可读的一行一条：ev_id | 时间 | 目标 | 结论 | 原始材料路径
```

`evidence-index.md` 是给复盘用的：按时间排序后，攻击时间线自然就出来了（与攻击链页对照即可）。

## 六、复核清单（写报告前过一遍）

```text
□ 每条结论都能指到一个 ev_id 或一份原始材料
□ claimed 的条目要么已升级为 observed/derived，要么保留标注（不静默转正）
□ inferred 的条目在报告里写成"待验证"或已列入后续动作
□ limitations 写了边界（扫了哪些、没扫哪些；试了哪些入口、没试哪些）
□ 数据成果写了实际条数/体积，不是"大量数据"
□ 截图与库内登记一致（kind 没混用、文件没被覆盖）
□ 时间线能串起来（发现 → 验证 → 利用 → 固化，时间戳不打架）
□ 报告总分与面板总分一致（口径不同要先查原因，再决定报告怎么写）
```

## 七、几个容易被追问的点

- **改过命令再补记**：补记时把"实际执行的命令"写进 `parameters`，不要写"想执行的命令"。
- **复现不了就降档**：当时能验证、事后复现不了，保留原 `observed` 记录并补一条说明（何时验证、环境差异），
  不建议直接删掉原记录。
- **多人协作**：`recorded_by` / `source_agent` 如实填，交接时按人拆开看，能快速定位"这条是谁的判断"。
- **结论升级要留痕**：`redteam_evidence_upgrade` 记差异，原始 `claimed` 记录保持不动，形成可追溯的升级链。
