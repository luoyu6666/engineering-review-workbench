# 备份与发布到 GitHub（运维手册）

> 场景：系统稳定后做一次**完整备份**，并把**源码**发布到 GitHub。
> 两条线是分开的：**数据走备份，代码走 Git**，绝不混。

---

## 一、完整备份（含业务数据）

```powershell
cd D:\Deepseek harness工作区\生活其他\审核工作台
powershell -File 运维\backup.ps1                 # 默认备份到 E:\系统备份（与源盘 D: 不是同一块物理盘）
```

产出（E:\系统备份\审核工作台_v<版本>_<时间戳>\）：

| 内容 | 说明 |
|---|---|
| `app\` | 整个项目目录（代码 + 配置 + **数据** + 技能 + 运维脚本） |
| `machine\` | 文件系统之外的东西：计划任务、防火墙规则、环境变量、依赖清单 |
| `manifest.json` | 文件清单 + 每个文件的 SHA256 + 环境快照（**校验完整性**） |
| `restore.ps1` / `README-恢复说明.md` | 异机恢复脚本与说明 |
| `*.zip` | 同样的内容压缩包（约 1.7 GB） |

常用参数：`-NoZip`（留目录，便于网盘/增量）、`-Light`（精简，体积 ~5MB 但恢复后打不开历史原件）、
`-IncludeApiKey`（把 DeepSeek API Key 一并写入；**默认不写**，因为它是可再生凭据而备份可能长期躺着）。
历史记录写在 `运维\backup-history.log`。

> ⚠️ **备份包含账号密码哈希与全部审核报告，属敏感数据**：只放本机/移动盘，不要传公共网盘或群里。
> 建议至少两块盘各放一份（`-Dest "E:\系统备份;G:\备份"`）。

**校验备份是否可靠**（抽查关键文件哈希，比只看体积靠谱）：

```powershell
$src='D:\...\审核工作台'; $bak='E:\系统备份\审核工作台_v1.3.1_<时间戳>'
foreach($f in @('web\server.mjs','web\lib.mjs','web\public\index.html','web\data\users.json')){
  $a=(Get-FileHash "$src\$f" -Algorithm SHA256).Hash
  $b=(Get-FileHash "$bak\app\$f" -Algorithm SHA256).Hash
  "{0,-26} {1}" -f $f, $(if($a -eq $b){'✓ 一致'}else{'✗ 不一致'})
}
```

---

## 二、发布源码到 GitHub

### 2.1 为什么分两条路（**先看这条，能省很多时间**）

实测本机网络：`api.github.com:443` ✅ 通 · `github.com:22` ✅ 通 · `ssh.github.com:443` ✅ 通
—— 但 **`github.com:443` 不通**（连接被重置/超时，开了 VPN 也一样）。

而 `git push https://github.com/...` 走的正是 `github.com:443`，所以它**必然失败**。两条可用路线：

| 路线 | 命令 | 适用 |
|---|---|---|
| **A. REST API 上传** | `node 运维\push-via-api.mjs` | 走 `api.github.com`，**当前网络下立即可用**；一次性把索引里的文件搬上去 |
| **B. SSH 推送** | `git push git@github.com:...` | 走 22 或 `ssh.github.com:443`，**长期最好的通道**；需先把公钥加到 GitHub |

### 2.2 发布前的铁律

- **只提交源码**：`web/data`（账号哈希、会话、真实报告与成果）、`skill`（技能资产）、
  `runs`/`产出`/`测试样本`/`运维/预览`（业务产物与真实截图）、日志 —— 全部由 `.gitignore` 排除。
- 提交前瞄一眼将要上传的清单：

```powershell
cd D:\Deepseek harness工作区\生活其他\审核工作台
git add -A
git diff --cached --name-only        # 中文名乱码时先执行 git config core.quotepath false
git status --porcelain --ignored | Select-String '^!!'   # 确认敏感目录确实被忽略
```

- 顺手查一次明文密钥：`Select-String -Path (Get-ChildItem -Recurse -Include *.mjs,*.json,*.md).FullName -Pattern 'ghp_|sk-[A-Za-z0-9]{20,}'`
  （注意：内嵌 base64 截图里可能误报，要人工看一眼命中位置。）

### 2.3 路线 A：REST API 上传（当前网络可用 · **本项目选定的固定通道**）

**每次发布的固定三步**（照着做即可）：

```powershell
cd D:\Deepseek harness工作区\生活其他\审核工作台

# ① 把改动放进索引，并瞄一眼要传什么（确认敏感目录不在里面）
git add -A
git diff --cached --name-only                                  # 中文名乱码时先 git config core.quotepath false
git status --porcelain --ignored | Select-String '^!!'          # 应能看到 web/data/、skill/ 等被忽略

# ② 本地提交（推荐：让本地历史记下"这次推了什么"）
git commit -m "说明这次改了什么"

# ③ 用新令牌上传（令牌只活在这一次会话的环境变量里，不落盘）
$env:GITHUB_TOKEN='<新的 fine-grained 令牌>'; $env:GITHUB_REPO='luoyu6666/audit-workbench'
node 运维\push-via-api.mjs                                     # 可加 --message "说明"
```

脚本做的事：空仓库先用 README 建立首个提交 → 逐文件建 blob → 建 tree → 建 commit → 移动分支 →
**最后递归拉回远端清单自检**，确认 `web/data`、`skill`、`runs`、`产出`、`测试样本`、`运维/预览`、日志都没上去。

> 令牌只从环境变量读，不写进任何文件；`git remote` 保持**不含令牌**的干净地址。
> 注意：走 API 建的提交与本地提交**内容相同但提交号不同**（两边历史各自独立，内容一致）。
> ⚠️ 令牌**不要**用 `setx` 持久化——本项目的备份会采集系统环境变量，那会把令牌带进备份包。
> 每次发布前临时设一次环境变量即可；用完/怀疑泄露立刻在 GitHub 上吊销。

### 2.4 路线 B：SSH（推荐长期使用）

1. 生成本机密钥（这台机器的 MiniGit **没有 ssh-keygen**，所以用脚本生成标准 OpenSSH 格式的 ed25519）：

```powershell
node 运维\make-ssh-key.mjs        # 私钥写 %USERPROFILE%\.ssh\id_ed25519_wb，并打印公钥
```

2. 把打印出来的**公钥**贴到 GitHub：
   - 单个仓库：仓库 → Settings → **Deploy keys** → Add deploy key（勾 **Allow write access**）
   - 或整个账号：Settings → SSH and GPG keys → New SSH key
3. 切换远端并推送：

```powershell
git remote set-url origin git@github.com:<owner>/<repo>.git
# 端口 22 不通时走 443：
# git remote set-url origin ssh://git@ssh.github.com:443/<owner>/<repo>.git
git push -u origin main
```

### 2.5 令牌安全（重要）

- 令牌**不要贴到聊天/工单/群里**（一旦出现在日志里就等于泄露）。要放就放环境变量或凭据管理器。
- 用完（或怀疑泄露）**立刻吊销**：GitHub → Settings → Developer settings → Personal access tokens → Revoke。
- 优先用 **fine-grained token**，只勾该仓库的 `Contents: Read and write`，并设短有效期。
