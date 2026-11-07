---
name: deepseek-web-intel
description: 用公开搜索引擎与网页做目标情报收集：查询构造、site:/filetype:/inurl: 操作符、DeepSeek API 结构化摘要、结果归档与去重
whenToUse: 还没有主动接触目标，需要先从公开网页/搜索引擎把资产、人员、技术栈、供应链线索捞出来时
role: recon
enabled: true
---

# 公开网页情报（搜索引擎 + 摘要 API）

不动目标一台主机，先把公开面捞干净。产出物是**带来源链接的线索表**，
后续 `redteam_asset_add` 落库、主动扫描去验证。

## 一、查询构造三件套

一条查询 = 主体词 + 特征词 + 限定操作符。

```text
主体词：[ORG]（单位全称 / 简称 / 英文名 / 拼音缩写 / 曾用名）
特征词：信息化 | 采购 | 招标 | 机房 | 数据中心 | 运维 | 上线 | 系统升级 | 招聘 + 技术栈
操作符：site:  filetype:  inurl:  intitle:  intext:
```

搜索引擎通用写法（以 Bing/Google 为例）：

```text
"[ORG]" site:[DOMAIN]
"[ORG]" (采购 OR 招标 OR 中标) (系统 OR 平台 OR 信息化) filetype:pdf
site:[DOMAIN] (后台 OR 登录 OR 管理) -www
inurl:("后台" OR "admin" OR "manage" OR "login") site:[DOMAIN]
intitle:"index of" site:[DOMAIN]
"[ORG]" filetype:xls (通讯录 OR 名单 OR 人员)
"[ORG]" (邮箱 OR @[DOMAIN]) filetype:doc OR filetype:xlsx
```

操作符速查：

| 操作符 | 作用 | 例 |
| --- | --- | --- |
| `site:` | 限定站点/域 | `site:demo.example.com` |
| `filetype:` / `ext:` | 限定文档类型 | `filetype:xlsx`、`ext:sql` |
| `inurl:` | URL 片段 | `inurl:upload`、`inurl:api/v1` |
| `intitle:` | 标题词 | `intitle:"系统登录"` |
| `intext:` | 正文词 | `intext:"内部使用"` |
| `-` | 排除 | `site:demo.com -www -shop` |
| `OR` / `|` | 或 | 百度用 `|` |
| `"…"` | 精确短语 | `"维保单位"` |

中文引擎差异（都跑一遍，覆盖面不同）：

```text
百度：   [ORG] 后台 | 登录 | 系统
搜狗微信： [ORG] 公众号 系统 上线     # 公众号文章常带内网地址与截图
必应：   与 Google 语法基本一致
知乎/CSDN：搜"某单位 内网 渗透 复盘"类的技术分享
```

## 二、按线索类型各扫一遍

```text
域名/子域：site:[DOMAIN] -www；证书透明日志 crt.sh 里搜 [DOMAIN]
C 段/网段： "[ORG] IP 段" / 招标文件里的"地址规划"
邮箱格式： site:[DOMAIN] "@[DOMAIN]"；招聘页面的 HR 邮箱
人员与部门： "[ORG]" (部门 OR 处室 OR 科室) filetype:xls
技术栈：   "[ORG]" (招标 OR 采购) (中间件 OR 数据库 OR 云平台) filetype:pdf
供应链：   "[ORG]" 运维外包 | 系统集成 | 维保 | 服务商
泄露物：   "[ORG]" (源码 OR 配置 OR 备份 OR 数据库) filetype:zip OR ext:sql
```

## 三、DeepSeek API 做结构化摘要（可选）

有 key 时用它把"几十条搜索结果"压成结构化线索表：去重、抽实体、标注可信度。
key 放 `$DSH_HOME/.env`，不进命令行、不进报告。

```bash
set -a; . "$DSH_HOME/.env"; set +a
test -n "$DEEPSEEK_API_KEY" && echo "key 已加载" || echo "缺 DEEPSEEK_API_KEY"
```

```bash
# 把搜索结果原文喂进去，要它只输出 JSON（实体去重 + 置信度）
curl -s https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "system", "content": "你是情报整理助手。只输出 JSON 数组，元素形如 {\"kind\":\"subdomain|email|person|tech|vendor|doc\",\"value\":\"...\",\"source_url\":\"...\",\"confidence\":\"observed|derived|inferred\"}。重复项合并，保留最可信来源。"},
      {"role": "user", "content": "以下是从搜索引擎抓到的原始结果（含标题/摘要/链接）：\n[RAW_RESULTS]"}
    ],
    "temperature": 0
  }' | jq -r '.choices[0].message.content' > runs/webintel/[ORG]-entities.json
```

Python 版（同一件事，便于批量跑多个查询）：

```python
import json, os, subprocess

KEY = os.environ["DEEPSEEK_API_KEY"]          # 缺失时脚本直接报错，避免静默跑空
QUERIES = [
    '"[ORG]" site:[DOMAIN]',
    '"[ORG]" (采购 OR 招标) filetype:pdf',
    'inurl:(admin OR login OR manage) site:[DOMAIN]',
]

def ask(raw: str) -> str:
    body = {"model": "deepseek-chat", "temperature": 0, "messages": [
        {"role": "system", "content": "只输出 JSON 数组：kind/value/source_url/confidence"},
        {"role": "user", "content": raw},
    ]}
    out = subprocess.run(
        ["curl", "-s", "https://api.deepseek.com/chat/completions",
         "-H", "Authorization: Bearer " + KEY,
         "-H", "Content-Type: application/json",
         "-d", json.dumps(body)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["choices"][0]["message"]["content"]

for q in QUERIES:
    print(q, "→", ask("查询：" + q + "\n把该查询可能命中的线索按 JSON 列出，没有就返回 []"))
```

无 key 时的替代：搜索引擎自带的 `site:` 结果 + 手工摘录，照样能产出线索表，只是慢一些。

## 四、结果归档与去重

```bash
mkdir -p runs/webintel/[DATE]
# 1) 原始结果先落地（标题|链接|摘要，一行一条）
cat > runs/webintel/[DATE]/raw.jsonl <<'EOF'
{"kind":"subdomain","value":"oa.[DOMAIN]","source_url":"[URL]","confidence":"observed"}
EOF

# 2) 规范化：小写、去 www、去末尾斜杠、去 utm 参数
python3 - <<'PY'
import json, re, pathlib
src = pathlib.Path("runs/webintel/[DATE]/raw.jsonl")
rows, seen = [], set()
for line in src.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    r = json.loads(line)
    v = r["value"].strip().lower().rstrip("/")
    v = re.sub(r"^www\.", "", v).split("?")[0]
    if (r["kind"], v) in seen:
        continue
    seen.add((r["kind"], v)); r["value"] = v; rows.append(r)
pathlib.Path("runs/webintel/[DATE]/entities.json").write_text(
    json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print("去重后", len(rows), "条")
PY
```

归档字段建议（一张表就能喂给落库工具）：

| 字段 | 含义 |
| --- | --- |
| `kind` | subdomain / ip / port / email / person / tech / vendor / doc / credential-hint |
| `value` | 规范化后的值 |
| `source_url` | 来源链接（可复核） |
| `confidence` | observed（网页原文） / derived（从原文推断） / inferred（推测） |
| `first_seen` | 抓取日期 |

## 五、落库与交接

```text
资产类线索 → redteam_asset_add（provenance 填 passive，tool 写数据源，如 "bing-site-search"）
人员/邮箱 → 记在资产备注或 redteam_unknown_record（待验证事项）
公司/供应链 → redteam_asset_link 建立"资产 ↔ 单位"关系（relation 写清）
文档/泄露物 → 先落地到 runs/webintel/[DATE]/files/，再在漏洞里登记引用
```

交接给主动扫描时给出三行：新发现的资产面 / 值得优先验的点 / 每条线索的来源链接。

## 六、几个常见坑

- 搜索引擎结果有缓存与过期：链接 404 时用网页快照、Wayback（`web.archive.org/web/*/[URL]`）复核。
- `site:` 对子域不递归，每个子域单独跑一次。
- 同一实体在不同查询下写法不同（`oa.` / `OA系统` / `协同办公`），去重按规范化值 + 语义合并。
- 摘要 API 的输出当**草稿**：里面出现的资产都要回到来源链接确认一次再落库。
