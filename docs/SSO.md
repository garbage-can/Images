# 单点登录（SSO / OIDC）

本项目内置一套最小的 **OpenID Connect Authorization Code + PKCE** 登录，不依赖任何第三方 npm 包。未配置时完全关闭，不影响本地用户名/密码登录。

## 1. 配置

在 `.env` 中设置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `SSO_ENABLED` | 是 | `1` 开启；`/api/auth/sso/config` 会返回 `enabled:true` |
| `SSO_ISSUER` | 是 | IdP 的 issuer，例如 `https://login.microsoftonline.com/<tenant>/v2.0`、`https://your-org.okta.com`、`https://keycloak.example.com/realms/corp` |
| `SSO_CLIENT_ID` | 是 | OIDC 应用 Client ID |
| `SSO_CLIENT_SECRET` | 否 | 机密客户端才需要；公共客户端可留空 |
| `SSO_SCOPES` | 否 | 默认 `openid profile email` |
| `SSO_REDIRECT_URI` | 否 | 留空则按请求 Host 自动生成 `https://<host>/api/auth/sso/callback` |
| `SSO_ALLOWED_DOMAINS` | 否 | 允许的邮箱域名，逗号分隔（如 `corp.com,company.cn`）；留空不限制 |
| `SSO_AUTO_PROVISION` | 否 | 默认 `1`：首次 SSO 登录自动建号；`0` 则只允许已存在账号 |
| `SSO_DEFAULT_ROLE` | 否 | 自动建号的角色，`user`（默认）或 `admin` |
| `SSO_BUTTON_LABEL` | 否 | 登录页按钮文案 |
| `SSO_TOKEN_AUTH` | 否 | `post`（默认，client_secret 放表单）或 `basic`（HTTP Basic） |

IdP 侧需要把 **Redirect URI** 配成：

```
https://<你的域名>/api/auth/sso/callback
```

并允许 `openid profile email`，确保 ID Token 里带 `email`（或 `preferred_username` / `upn`）与 `name`。

## 2. 流程

```
GET /api/auth/sso/config      -> { enabled, label, loginUrl }
GET /api/auth/sso/start       -> 302 到 IdP（state + nonce + PKCE S256）
GET /api/auth/sso/callback    -> 校验 state / 换 token / 验签 ID Token / 建会话
```

- `state`、`nonce`、`code_verifier` 存在服务端内存 Map，10 分钟过期，一次性使用；
- ID Token 用 IdP 的 JWKS 做 **RS256** 验签，并校验 `iss` / `aud` / `exp` / `nonce`；
- 邮箱域名不在 `SSO_ALLOWED_DOMAINS` 内会被拒绝；
- 登录成功写入现有 `sid` 会话 Cookie（HttpOnly / SameSite=Lax / Secure），与密码登录完全一致；
- 失败统一跳回 `/login.html?sso_error=<code>`，登录页会显示中文提示。

## 3. 账号与额度

- 首次 SSO 登录自动建号：用户名取邮箱前缀，冲突时自动加后缀；密码是随机值（用户不需要知道）；
- 新用户继承 `DEFAULT_DAILY_LIMIT` / `DEFAULT_MONTHLY_LIMIT`（默认每人 10 次/月）；
- 员工离职：在「管理 → 用户」把状态改为 `disabled`，SSO 登录会被拒绝；
- 额度调整仍走「管理 → 额度管理」，与 SSO 无关。

## 4. 对接公司目录（可选）

如果公司没有标准 OIDC，只有通讯录接口，可以保留现有密码登录，额外用管理 API 做账号同步：

- 建号：`POST /api/users`（需管理员会话）
- 停用：`PATCH /api/users/:id` `{ "status": "disabled" }`
- 设额度：`PUT /api/admin/quota/users/:id`

## 5. 安全建议

1. 生产必须走 HTTPS，并保持 `SESSION_COOKIE_SECURE=1`；
2. `SSO_CLIENT_SECRET` 只放 `.env`（600），不要提交；
3. 建议配置 `SSO_ALLOWED_DOMAINS`，避免任意 IdP 账号进入；
4. 如果 IdP 支持，开启 MFA；本项目只信任 IdP 的认证结果；
5. 反向代理需传递 `X-Forwarded-Proto` / `X-Forwarded-Host`，否则自动生成的回调地址可能不对，此时显式设置 `SSO_REDIRECT_URI`。


## 6. 自研 OAuth2（ERP 对接）

如果 ERP 只提供标准 OAuth2 三件套（authorize / token / userinfo），把 `SSO_MODE` 设为 `oauth2`：

```env
SSO_MODE=oauth2
SSO_AUTHORIZE_URL=https://erp.example.com/oauth/authorize
SSO_TOKEN_URL=https://erp.example.com/oauth/token
SSO_USERINFO_URL=https://erp.example.com/oauth/userinfo
SSO_CLIENT_ID=image-studio
SSO_CLIENT_SECRET=...
SSO_SCOPES=openid profile email
SSO_EMAIL_FIELD=email
SSO_NAME_FIELD=name
SSO_DEPARTMENT_FIELD=department
SSO_GROUPS_FIELD=groups
SSO_ADMIN_GROUPS=img-admin
```

流程与 OIDC 相同（state + PKCE），区别是不再校验 ID Token，而是用 access_token 调 userinfo，再按字段映射：

| 平台字段 | 默认 claim | 说明 |
|---|---|---|
| 邮箱 | `email` | 必填，用于匹配/建号 |
| 姓名 | `name` | 写入 display_name |
| 部门 | `department` | 用于部门默认额度 |
| 组 | `groups` | 命中 `SSO_ADMIN_GROUPS` 自动给 admin |

字段支持点路径，例如 `data.profile.email`。
