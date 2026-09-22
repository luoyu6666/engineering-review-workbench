# 工程咨询成果审核工作台 · 备份恢复说明

> 这是系统 **v1.0.0** 的完整备份。按本文档可在另一台电脑上把整套系统恢复起来。

---

## 一、这次备份了什么

| 目录 | 内容 | 为什么必须有 |
|---|---|---|
| `app\` | 整个项目目录：代码、配置、数据、技能、运维脚本 | 系统本体 |
| `machine\scheduled-tasks\` | 两个计划任务的 XML（Web 服务 + 看门狗） | 不在文件系统里，漏了就恢复不了自启与自愈 |
| `machine\firewall-8787.txt` | 8787 入站防火墙规则 + 重建命令 | 同事能访问的前提 |
| `machine\api-key.txt` | API Key 说明（**默认不含明文 key**） | 见下面第四节 |
| `machine\prerequisites.md` | 依赖清单与绝对路径、版本 | 换机器要重装这些 |
| `machine\machine-info.json` | 主机名、系统、网卡 IP、磁盘、计划任务、启用账号 | 恢复时对照 |
| `manifest.json` | **每个文件的 SHA256** + 环境快照 | 校验备份有没有损坏 |
| `restore.ps1` | 异机恢复脚本 | 一键恢复 |

**文件清单里包含的关键数据**（都在 `app\web\data\`）：

```
users.json            28 个账号（密码是 scrypt 加盐哈希，不是明文）
templates.json        报告类型
project-types.json    项目类型与识别关键词
skill-feedback.json   AI 技能经验（人工反馈沉淀）
projects.json         项目质量台账的清零点
sessions.json         当前有效登录会话
login-history.json    登录审计流水
cost-model.json       成本参数
server.log            服务日志
tasks\<任务号>\       每次审核的完整留档（上传原件、转换文本、成果 HTML、PDF、补充审核）
```

`app\skill\petroleum-engineering-review\` 是技能副本（含 4 个 WB-ADD 增补块）。
`app\skill\.sync\baseline\` 是同步基线，丢了就没法再和 WorkBuddy 原件做增量比对。

---

## 二、先校验备份是否完好

```powershell
cd <备份目录>
powershell -File restore.ps1 -Target D:\审核工作台 -DryRun
```

干跑会：逐个核对 SHA256、检查依赖、列出将要导入的计划任务与防火墙命令，**不改动任何东西**。

---

## 三、正式恢复（新电脑上）

### 3.1 先装依赖

| 组件 | 必需 | 装什么 |
|---|:--:|---|
| **Node.js 24+** | ✅ | https://nodejs.org/ |
| **LibreOffice** | ✅ | https://zh-cn.libreoffice.org/download/ （`.doc → .docx`） |
| **Python 3.12 + MarkItDown** | ✅ | 先装 Python，再 `pip install markitdown` |
| Pandoc | ⭕ 可选 | `scoop install pandoc`（备用转换） |
| Chrome 或 Edge | ⭕ 可选 | 成果 HTML → PDF 用 |

> 装在**非默认路径**的话，恢复后要改 `app\web\lib.mjs` 顶部的
> `MARKITDOWN` / `SOFFICE` / `PANDOC` 三个常量。

### 3.2 执行恢复

```powershell
cd <备份目录>
powershell -File restore.ps1 -Target "D:\审核工作台" -ApiKey "sk-你的key"
```

脚本会依次完成：校验 → 检查依赖 → 复制文件 → 导入计划任务（**自动把路径改成新路径**）
→ 重建防火墙 → 设置环境变量。

### 3.3 启动与验证

```powershell
Start-ScheduledTask -TaskName '审核工作台Web服务'
Start-ScheduledTask -TaskName '审核工作台看门狗'

# 自检（零 API 调用，应全部通过）
node "D:\审核工作台\engine\test-timing.mjs"
node "D:\审核工作台\engine\test-duplicate.mjs"
node "D:\审核工作台\engine\test-standards.mjs"
```

浏览器打开 `http://127.0.0.1:8787`，用原账号登录（账号密码随备份一起恢复）。
内网访问地址若变了，通知同事新地址。

---

## 四、关于 API Key（重要）

**备份默认不含明文 key。** 原因是它是可再生凭据，而备份包可能长期躺在移动盘上。

恢复时有三种做法，任选其一：

1. **恢复时一起设置**（推荐）：加 `-ApiKey "sk-xxx"`
2. **恢复后手工设置**：
   ```powershell
   [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY','sk-你的key','Machine')
   Stop-ScheduledTask  -TaskName '审核工作台Web服务'
   Start-ScheduledTask -TaskName '审核工作台Web服务'
   ```
3. 备份时就把 key 打进去：`powershell -File backup.ps1 -IncludeApiKey`
   （会写进 `machine\api-key.txt`，**用完记得销毁这个文件**）

设置后看服务日志确认生效的是哪把：
```powershell
Get-Content "D:\审核工作台\web\data\server.log" -Tail 15 -Encoding UTF8 | Select-String "API Key"
```

---

## 五、安全提醒

⚠️ **这个备份包属于敏感数据**：
- 含 **28 个账号的密码哈希**（scrypt 加盐，不可逆，但可离线爆破弱密码）
- 含**全部审核报告留档**（上传原件 + 成果），是工程咨询业务数据

因此：
- **不要上传公共网盘**，不要发到微信/钉钉群
- 建议至少放**两块不同的物理盘**各一份
- 接口人变动时，把备份的交接也一并交代清楚

---

## 六、平时怎么再做备份

```powershell
# 默认备份到 E: 盘
powershell -File "D:\审核工作台\运维\backup.ps1"

# 同时备份到两块盘
powershell -File "D:\审核工作台\运维\backup.ps1" -Dest "E:\系统备份"

# 每个目标盘只保留最近 N 份（自动删旧的）
powershell -File "D:\审核工作台\运维\backup.ps1" -Dest "E:\系统备份" -Keep 8

# 精简模式（不打包原件与大 PDF，体积从 ~112MB 降到 ~5MB）
powershell -File "D:\审核工作台\运维\backup.ps1" -Light

# 不压缩、直接留目录（便于网盘同步）
powershell -File "D:\审核工作台\运维\backup.ps1" -NoZip
```

每次备份都会新建一个带时间戳的目录，**不会覆盖以前的备份**。

### 已配置的自动备份

| 项 | 值 |
|---|---|
| 计划任务 | `审核工作台自动备份` |
| 频率 | **每周日 22:00** |
| 目标 | `E:\系统备份`（只备这一块盘，按你的要求） |
| 保留 | 最近 **8** 份，更早的自动删除（约 900 MB 上限） |
| 运行身份 | SYSTEM（不需要有人登录） |

查看与手动触发：
```powershell
Get-ScheduledTaskInfo -TaskName "审核工作台自动备份"          # 看上次/下次运行
Start-ScheduledTask   -TaskName "审核工作台自动备份"          # 立刻跑一次
Get-Content "D:\审核工作台\运维\backup-history.log" -Tail 10 -Encoding UTF8   # 备份历史
```

> ⚠️ 自动备份只在 **E 盘插着**的时候能成功。盘不在时会跳过并记一条失败，
> 不影响系统运行。想改频率/保留份数/目标盘，在「任务计划程序」里改
> `审核工作台自动备份` 的参数即可（`-Dest` 与 `-Keep`）。

**建议**：每月或每有大改动后，手工再往 G 盘备一份，保持"两块不同的物理盘各有一份"。
