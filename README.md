# 工程咨询成果审核工作台

内网自托管的**工程咨询成果（报告 / 汇报 PPT）智能审核工作台**：同事上传 Word / PPT 原件，
系统在本机解析、调用大模型按工程咨询准则逐维度审核，产出**问题清单（校对成果 / 审核成果）**
与**原报告标注版 PDF**（把问题直接画回原文对应位置），并带项目台账、数据看板、
积分额度、排队调度与访问控制。

> ⚠️ **本仓库只放源码与文档。**
> 业务数据、审核技能资产与产出物**一律不进版本库**（见 `.gitignore`）：
> 工程技术报告原件与审核成果（客户资料）、账号密码哈希与登录流水（个人信息）、
> 训练出来的审核技能副本（知识资产）——这些一旦提交，即使后来删除，历史里也永久留存。
> 数据备份请用 `运维/backup.ps1` 备份到本地/移动盘，**不要走 git**。

## 目录结构

| 目录 | 内容 |
|---|---|
| `web/` | Node 零依赖 HTTP 服务：`server.mjs`（路由/会话/队列/IP 访问控制）、`lib.mjs`（纯逻辑与数据层）、`public/index.html`（单页界面） |
| `engine/` | 审核引擎：`lib/pipeline.mjs`（S0 预处理 → S1 事实 → S2 分维度 → S3 规则 → S4 定级 → S5 成文）、`lib/annotate.mjs`（原报告标注版）、`lib/report-html.mjs`（成果排版）、`lib/providers.mjs`（模型服务商）、`lib/model-config.mjs`、`lib/encoding-guard.mjs`（编码体检）；`test-*.mjs` 为各模块自检 |
| `运维/` | 备份与恢复（`backup.ps1` / `restore.ps1`）、看门狗、截图工具（CDP）、操作说明与手册生成管线、IP 绑定导入、标注版修复、GitHub 推送脚本 |
| `bench/` | 性能与效果基准脚本 |
| 根目录 | `VERSION.txt`（版本与变更记录）、`使用说明.md`（完整功能说明）、`操作说明.pdf/.html`（图文版）、`使用手册.pdf/.html`、`原报告标注版-规格.md`、`上云部署清单.md` |

## 运行（Windows，零 npm 依赖）

```powershell
# 依赖：Node.js 24+、pandoc、LibreOffice、poppler(pdftoppm/pdftotext)、Chrome
# 模型：环境变量 DEEPSEEK_API_KEY ；服务端口默认 8787
cd web
node server.mjs
# 浏览器打开 http://127.0.0.1:8787
```

首次启动会自动创建管理员账号并在控制台打印初始密码；系统配置、账号与会话都在 `web/data/`（**不在本仓库**）。

## 自检（零 API 调用）

```powershell
cd engine
node test-annotate.mjs     # 标注版：编号一致性、定位、渲染工具链
node test-dashboard.mjs    # 数据看板口径（费用/积分/在线人数同源）
node test-ipbind.mjs       # IP 访问控制（两道闸门、本机豁免、不可伪造）
node test-queue.mjs        # 排队调度与公平调度
node test-security.mjs     # 会话与登录防护
# 其余 test-*.mjs 同理会打印「通过 N / 失败 0」
```

## 数据与隐私

- 生产数据（账号、会话、报告留档、成果、标注版 PDF）在 `web/data/`，**已被 `.gitignore` 排除**。
- 备份包内含账号密码哈希与全部审核报告，属敏感数据，**请勿上传公共网盘或发到群里**。
- `DEEPSEEK_API_KEY` 默认不写入备份包（它是可再生凭据，而备份可能长期躺在移动盘上）。
