# 工程咨询成果审核工作台

石油天然气行业**工程咨询成果的 AI 初审平台**。把一份可研 / 后评价 / 收购类报告丢进去，
系统按分阶段流水线做结构化抽取、分维度审核、规则校验与分级，输出两类成果：

- **校对成果**（人人可看）—— 编校、术语、数据不一致、口径混用、标准规范引用等**客观可核对**的问题
- **审核成果**（授权者）—— 在校对类之外，增加逻辑分析、结论正确性、投资与经济指标、建议合理性

## 特点

- **分阶段流水线**：S0 预审 → S1 结构化 → S2 分维度审核 → S3 规则校验 → S4 分级闸门 → S5 成文
- **关键判定由代码做**：问题定级（P0~P3）走纯代码闸门，不采信模型自报的等级
- **计费时段感知**：识别高峰 / 空闲时段，可把花钱的调用排到空闲时段（半价）
- **两阶段任务流**：本地文档解析立刻做（不花钱），AI 调用到点才跑
- **PPT 配对审核**：同时提交同一项目的报告与汇报 PPT，可额外做**数据 / 观点 / 内容一致性核对**，成果按 PPT 优先排版
- **零第三方依赖**：服务本体只用 Node 内置模块（node:http + scrypt + cookie 会话）

## 架构

```
S0 预审      识别项目编号 / 名称、报告类型、项目类型（一次便宜调用）
S1 结构化    抽事实：投资链、时间线、跨源冲突、资金、引用标准…（一次调用）
S2 分维度    8 个审核单元并发跑（受控并发，避免被限流）
S3 规则校验  纯代码，零 API：投资偏差、时序倒置、跨源不一致、标准编号…
S4 分级闸门  纯代码，零 API：按类别映射 P0 白名单，编校 / 术语 / AI套话永不得 P0
S5 成文      只写叙述部分；附录、统计、表格全部由代码生成
```

审核知识放在**技能文件**里（skill/，本仓库不含），工程实现留在 engine/。

## 目录结构

```
engine/               审核引擎
  lib/pipeline.mjs      S0~S5 流水线、审核单元定义、规则引擎
  lib/core.mjs          API 调用、技能读取、JSON 容错
  lib/report-html.mjs   成果渲染（校对版 / 审核版，含打印样式）
  test-*.mjs            离线自检（零 API 调用）
  backfill-*.mjs        历史数据回填工具
web/                  内网 Web 服务
  server.mjs            路由、任务调度、并发闸门
  lib.mjs               数据层、计费、查重、看板统计、文档转换
  public/index.html     单文件前端
运维/                 运维脚本
  backup.ps1 / restore.ps1   完整备份与异机恢复
  watchdog.ps1               自愈看门狗
  publish.mjs                生成可发布的脱敏副本
```

## 运行依赖

| 组件 | 必需 | 用途 |
|---|:--:|---|
| Node.js 24+ | ✅ | 服务本体（零第三方依赖） |
| LibreOffice | ✅ | .doc / .ppt 老格式转换 |
| Python 3.12 + MarkItDown | ✅ | Office / PDF → Markdown |
| Pandoc | ⭕ | 备用转换 |
| Chrome / Edge | ⭕ | 成果 HTML → PDF |

```bash
pip install markitdown
```

## 启动

```bash
# Windows
setx DEEPSEEK_API_KEY "sk-..."
# Linux / macOS
export DEEPSEEK_API_KEY="sk-..."

cd web
node server.mjs          # 默认 8787 端口，PORT 环境变量可改
```

## 自检

改过对应模块后跑一遍，前四项零 API 调用：

```bash
node engine/test-timing.mjs      # 27 项：计费时段与调度
node engine/test-duplicate.mjs   # 20 项：重复审核查重
node engine/test-standards.mjs   # 15 项：标准规范引用规则
node engine/test-feedback.mjs    # 35 项：经验作用域与多条口径
node engine/test-cancel.mjs      # 12 项：取消竞态与队列名额（需服务在跑）
node engine/test-login-guard.mjs # 22 项：登录防护（需服务在跑）
```

## 说明

- 本仓库**只含代码**：不含审核数据、账号、技能知识库（那些属于业务资产，不进版本库）
- 需要配套一份「审核技能文件」（Markdown 形式的知识体系）放在 skill/ 下才能实际审核；
  技能内容与具体专业领域强相关，不在本仓库
- AI 仅作初审，不能替代专家终审

版本：v1.2.0
