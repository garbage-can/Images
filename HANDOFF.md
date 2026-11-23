# Image Studio · 公司分支交接说明

> 仓库：https://github.com/garbage-can/Images
> 分支：`corp`（Fork 自 `shixian64/Images`）
> 线上：https://openwebui.111254.xyz
> 本文档面向接下来在 Mac 上继续开发的人。

## 1. 这是什么

基于开源 Image Studio 改造的公司内部生图平台：

- 前端：原生 ES Modules + 无构建步骤
- 后端：Node 22（`node:sqlite`），零 npm 运行时依赖
- 上游：CLIProxyAPI（CPA）→ ChatGPT Codex 生图
- 数据库：`generated/app.db`（SQLite，启动自动迁移）

## 2. 当前已完成

| 模块 | 状态 |
|---|---|
| 漫画工作流 | 已移除（UI、路由、图库入口；接口返回 404） |
| 视频工作流 | 已移除（同上） |
| 用量看板 | 已集成到顶部「用量」标签（仅管理员） |
| 单点登录 | OIDC + 自研 OAuth2 两种模式，代码就绪，线上未启用 |
| ERP 账号同步 | `/api/erp/users/sync`，Bearer Token，支持全量停用 |
| 部门额度 | 部门默认 + 个人覆盖 + 全站默认，三级优先级 |
| 并发 | 全站 5，单用户 1，单次 1 张图 |
| 测试 | `npm test`，493 个用例通过 |

已删除的漫画/视频只下线了入口，`services/comic-storyboard-jobs.js` 等死代码仍在，后续可清理。

## 3. 快速启动

```bash
git clone https://github.com/garbage-can/Images.git
cd Images
git checkout corp

cp .env.example .env
# 至少配置：CPA 地址、管理 key、会话密钥
npm start        # http://localhost:8787
npm test
```

要求 Node >= 22.5（`node:sqlite`）。

生产用 Docker：

```bash
docker compose up -d --build
```

## 4. 关键环境变量

```env
# 并发
GLOBAL_CONCURRENT_GENERATIONS=5
DEFAULT_CONCURRENT_LIMIT=1
MAX_IMAGES_PER_REQUEST=1

# CPA
CPA_PLUGIN_BASE=http://127.0.0.1:8317/v0/management/plugins/cpa-key-billing
CPA_MGMT_KEY=...

# ERP 服务端接口
ERP_API_TOKEN=...

# SSO（当前关闭）
SSO_ENABLED=0
SSO_MODE=oauth2
SSO_AUTHORIZE_URL=
SSO_TOKEN_URL=
SSO_USERINFO_URL=
SSO_CLIENT_ID=
SSO_CLIENT_SECRET=
SSO_REDIRECT_URI=https://openwebui.111254.xyz/api/auth/sso/callback
SSO_ALLOWED_DOMAINS=
SSO_EMAIL_FIELD=email
SSO_NAME_FIELD=name
SSO_DEPARTMENT_FIELD=department
SSO_GROUPS_FIELD=groups
SSO_ADMIN_GROUPS=img-admin
```

线上 ERP Token 存在服务器 `/opt/image-studio/ERP_API.txt`（600 权限），不要提交到 Git。

## 5. 主要接口

### 用量

```http
GET /api/admin/usage?hours=5|24|72
```

### ERP 同步

```http
Authorization: Bearer <ERP_API_TOKEN>

POST /api/erp/users/sync
{
  "full": false,
  "users": [
    { "email": "a@corp.com", "name": "张三", "department": "设计部",
      "status": "active", "role": "user", "monthly_limit": 10 }
  ]
}

PUT  /api/erp/users/:email/quota
GET  /api/erp/users?department=设计部
```

`full: true` 会停用所有不在列表里的 `source=erp` 账号（离职）。

### 部门额度

```http
GET    /api/admin/quota/departments
PUT    /api/admin/quota/departments/设计部
{ "monthly_limit": 10, "daily_limit": 10 }
DELETE /api/admin/quota/departments/设计部
```

### SSO

```http
GET /api/auth/sso/config
GET /api/auth/sso/start
GET /api/auth/sso/callback
```

## 6. 数据模型变更（迁移 16）

- `users` 新增：`department`、`source`（local/sso/erp）、`display_name`
- 新表：`department_quotas`
- 额度优先级：个人覆盖 > 部门默认 > 全站默认

管理后台「管理 → 额度管理」新增了「部门默认额度」区块。

## 7. 还没做 / 下一步

1. **接 ERP 真实 OAuth2**：填 authorize/token/userinfo，`SSO_ENABLED=1`，用真实账号跑一次回调；
2. 如果 ERP 不接受 `code_challenge`，需要加“关闭 PKCE”的开关；
3. 用户列表增加「部门 / 来源 / 最后登录」列，以及批量调额度、CSV 导出；
4. 清理漫画/视频遗留的 service、DB 表和前端模块；
5. 视上游 429 情况，考虑把全局并发从 5 调回 4。

## 8. 已知问题

- Codex 额度百分比已能显示（来自 `wham/usage`），但 tokens 只是参考，不代表额度；
- 上游 3 个 Codex 账号，5 并发可能出现 429；
- 会话/日志里可能带 Windows 绝对路径，跨平台后旧工具结果不可直接复用；
- SSO OAuth2 的端到端流程尚未在真实 ERP 上验证。

## 9. 安全

- `.env`、`generated/`、`ERP_API_TOKEN`、`ADMIN.txt`、测试账号文件都不要提交；
- 生产保持 `ALLOW_INSECURE_UPSTREAMS=0`、`ALLOW_PRIVATE_UPSTREAMS=0`；
- 反向代理需正确传递 `X-Forwarded-Proto/Host`，或显式设置 `SSO_REDIRECT_URI`。

---

更细的说明：

- [ERP 集成](docs/ERP.md)
- [SSO 配置](docs/SSO.md)
- [分支改动清单](docs/FORK.md)
