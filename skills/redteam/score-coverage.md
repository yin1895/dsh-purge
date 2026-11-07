---
name: score-coverage
description: 得分项覆盖度自查：对照 redteam_score_list 逐项核对 25 类得分点，输出缺口清单与补打顺序
whenToUse: 每天收工前 / 阶段切换时 / 觉得"打了不少但分数上不去"时，做一次覆盖度自查
role: plan
enabled: true
---

# 得分项覆盖度自查（25 类得分点）

先看**清单**，再看**缺口**，最后定**补打顺序**。凭分值的直觉打，很容易在低分项上刷时间。

## 一、T+8 通用规则（横切所有条目）

| code | 规则 | 自查要点 |
| --- | --- | --- |
| G1 | 权限取高、只计一次 | 同一系统/主机/数据库只按最高档计一次 |
| G2 | 数据成果另行计分 | 数据量与权限分分开记，`evidence` 写实际条数 |
| G3 | 上限针对单个防守单位 | 达到上限就换项，别在同一条上刷 |
| G4 | 设备/终端按台计分 | 打印机/wifi 5 分/台；PC/Pad/手机/摄像头/大屏 10 分/台 |
| G5 | 数据规模翻倍 | 超 1 亿条或 10TB、知识库相关系统得分翻倍 |
| G6 | IPv6 倍数 | 走 IPv6 拿到的成果 ×3（不突破原上限） |
| G7 | 证明材料 | 边界突破要隔离设备控制截图 + 能访问内网的截图 |
| G8 | 兜底条款 | 其他系统/设备不预设分值，交专项组研判 |

## 二、25 类得分点（code 与 `redteam_score_list` 对齐）

| # | code | 名称 | 主档分值 | 上限 | 计分口径 |
| --- | --- | --- | --- | --- | --- |
| 1 | `domain-control` | 域名控制权限 | 一级 50 / 二级 20 | 400 | system |
| 2 | `terminal-access` | 终端权限（手机/Pad/PC/打印机/摄像头/wifi） | 5 ~ 10 分/台 | 600 | system |
| 3 | `server-host` | 服务器主机权限（含 webshell） | 普通 10 / 管理员 50 | 600 | system |
| 4 | `db-credential` | 数据库连接账号密码（含 SQL 注入） | 普通 10 / 管理员 50 / 未授权 10 | 400 | system |
| 5 | `web-app` | 邮箱 / OA 与业务生产系统 / 其他 Web 应用 | 管理员 100 / 普通 50 | 2000 | system |
| 6 | `central-system` | 集权系统（运维/身份/组网/终端管理后台） | 管理员 500 / 普通 50 | 4000 | system |
| 7 | `bigdata-system` | 大数据系统 | 管理员 1000 / 普通 100 | 4000 | system |
| 8 | `netdev` | 网络设备（防火墙/路由/交换/网闸/光闸/摆渡/VPN） | 普通 100 / 管理员 200 | 2000 | service |
| 9 | `netdev-redirect` | 网络设备 · 重定向或业务劫持（加成） | +200 | 2000 | none |
| 10 | `netdev-implant` | 网络设备 · 植入远控并后续攻击（加成） | 1000 | 2000 | none |
| 11 | `iiot` | 工业互联网系统 | 管理员 200 / 设备 10 分/个 | 2000 | system |
| 12 | `cloud-platform` | 云管理平台（含 K8S/OpenShift 等 PaaS） | 管理员 500 / 节点 10 分/台 | 2000 | system |
| 13 | `iot-platform` | 物联网设备管控平台 | 平台 200 / 连接点 10 | 2000 | system |
| 14 | `iot-corenet` | 物联网 · 经端点打入核心网（加成） | 5000 | 5000 | none |
| 15 | `secdev` | 安全设备（IPS/IDS/审计/WAF，非集权类） | 管理员 200 | 1000 | service |
| 16 | `file-storage` | 文件存储类系统（FTP/对象存储/NAS/网盘） | 管理员 50 / 普通 10 | 500 | system |
| 17 | `ai-agent` | 模型智能体、skill 等 agent 工具 | 100 ~ 500 | 4000 | service |
| 18 | `model-compute` | 算力管理平台 / 训练数据与知识库系统 | 系统管理 500 | 4000 | system |
| 19 | `model-data` | 模型相关数据系统 | 系统管理 500 | 4000 | system |
| 20 | `computepower-admin` | 算力基础设施 · 管理员权限 | 500 | 2000 | system |
| 21 | `computepower-cards` | 算力基础设施 · 算力卡 / 卡池化平台 | 10 分/卡 | 2000 | none |
| 22 | `boundary-logical` | 进入逻辑隔离业务内网 | 1000 | 无 | target |
| 23 | `boundary-strong` | 进入逻辑强隔离业务内网 | 10000 | 无 | target |
| 24 | `boundary-physical` | 进入物理隔离内网 / 核心生产网 | 30000 | 无 | target |
| 25 | `boundary-supply` | 借供应链运维通道或云服务进入内网 | 1000（最多 3000） | 3000 | service |

> 实际 code 与分值以本靶标 `redteam_score_list` 的返回为准（靶标可自定义得分点）。

## 三、自查流程（照着跑）

```text
① redteam_score_list → 拿到 items[]：每条含 code / points / cap / cap_used / achieved / capped / evidence
② 逐条打标：已拿下(achieved) / 打到上限(capped) / 未动(空)
③ 未动的项按"可达性 × 分值"排序 → 得缺口清单
④ 对每个缺口写一行"下一步动作 + 目标资产 + 预计耗时"
⑤ 派活执行，出货后 redteam_score_hit 记分（points 指定档位，evidence 写实际结果）
⑥ 复核：redteam_score_report 看总分与各分类分布是否与面板一致
```

示例（读工具返回后手工整理）：

```bash
# 面板看总分与分类分布；报告页对应 redteam_score_report
# 智能体侧直接读 JSON
# redteam_score_list → {"summary": {...}, "items": [{"code":"web-app","points":100,"cap":2000,"cap_used":150,...}]}
```

## 四、缺口清单模板

| code | 当前分值 | 上限已用 | 缺口 | 下一步动作 | 目标资产 | 预计耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| `central-system` | 0 | 0/4000 | 未打集权 | 找堡垒机/SSO/域控入口 | [ASSET] | 2h |
| `boundary-logical` | 0 | — | 未突破 | 先拿一台边界内主机 → 搭隧道 | [ASSET] | 3h |
| `web-app` | 150 | 150/2000 | 有量但覆盖面窄 | 把凭据里未登录的站点逐个实测 | [URL_LIST] | 1h |

## 五、补打顺序（性价比优先）

```text
第一梯队（一次动作多分）：boundary-*（1000 / 10000 / 30000）
第二梯队（系统级高地）：central-system(500) > bigdata-system(1000) > cloud-platform(500) > model-*(500)
第三梯队（纪律性清账）：web-app（凭据里每个站点都实测登录）、db-credential、server-host
第四梯队（按台累加）：terminal-access、iiot/iot-platform 连接点、computepower-cards
```

顺序理由：边界分一次到位；集权/大数据是单条高分且常带横向能力；
Web/数据库是"把已有凭据换成分数"的低成本动作；按台累加的项放最后，量大但单分低。

## 六、容易漏记的几种情况

| 现象 | 该记哪条 | 记的时候写什么 |
| --- | --- | --- |
| 凭据里只有 `host:port`，看不出系统名 | `web-app`（兜底归类） | 实测登录的 URL + 账号 + 管理员/普通档 |
| 集权系统下托管的一堆终端 | 终端按 `terminal-access` 计，不按集权 500 | 登录托管节点数（≥20% 或 20 台即可） |
| 大数据系统但数据量小 | 按第 4 项普通数据库口径 | 写明有效数据量（小于 5 亿条或 1TB） |
| IPv6 地址拿到的成果 | 对应条目 ×3（G6） | `evidence` 里写明是 IPv6 路径 |
| 云上 ak/sk 批量控制 | 默认只算被控节点分（`cloud-platform`） | 要算管理员分需提供新增节点/改权限的证明 |
| 数据成果（拖库/导出） | 对应权限条目 + 数据单独记（G2） | 实际条数（如"导出 132 万条用户数据"） |
| 边界突破 | 同一类边界整个单位只算一次 | 隔离设备控制截图 + 能访问内网的截图（G7） |
| 自己注册的账号 | 只作过程记录 | `self_created: true`（不计分、不进报告） |

## 七、记分动作的最小可用写法

```text
redteam_score_hit(
  code        = "server-host",        # 先 redteam_score_list 核对
  points      = 50,                   # 多档条目按实际档位指定（普通 10 / 管理员 50）
  target      = "[IP]:[PORT]",        # 带端口，服务口径按"资产 + 端口"判
  asset_id    = [ASSET_ID],
  vuln_id     = [VULN_ID],            # 有则填，报告据此附原始请求
  evidence    = "root 权限；/etc/shadow 可读；[命令] 回显 [回显摘要]",
  self_created= false
)
```

`evidence` 只写**结果**（拿到什么），上一步怎么打写在 `redteam_chain_add` 的 `detail` 与 `tool` 里 —— 报告的数据来源就是这两处。

## 八、收工前 60 秒核对

```text
□ 每个 achieved 的条目都能在报告页看到证据（redteam_report_targets 复核）
□ capped 的条目不再继续投入（换项，别刷）
□ 未动的条目都有"为什么没动"的一句话（写在计划文件里）
□ 面板总分 == 报告总分（口径不一致要先查，别带着矛盾交付）
```
