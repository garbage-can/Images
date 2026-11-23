# ERP 集成接口

平台提供一组服务端接口，供 ERP 后端同步账号、部门和额度，不需要浏览器登录。

## 1. 配置

```env
ERP_API_TOKEN=<随机长字符串>
SSO_MODE=oauth2
SSO_AUTHORIZE_URL=https://erp.example.com/oauth/authorize
SSO_TOKEN_URL=https://erp.example.com/oauth/token
SSO_USERINFO_URL=https://erp.example.com/oauth/userinfo
SSO_CLIENT_ID=image-studio
SSO_CLIENT_SECRET=...
SSO_REDIRECT_URI=https://openwebui.111254.xyz/api/auth/sso/callback
SSO_ALLOWED_DOMAINS=corp.com
SSO_EMAIL_FIELD=email
SSO_NAME_FIELD=name
SSO_DEPARTMENT_FIELD=department
SSO_GROUPS_FIELD=groups
SSO_ADMIN_GROUPS=img-admin
SSO_ENABLED=1
```

所有 `/api/erp/*` 请求带：

```http
Authorization: Bearer <ERP_API_TOKEN>
Content-Type: application/json
```

未配置令牌时接口返回 `503`，令牌错误返回 `401`。

## 2. 批量同步（推荐）

```http
POST /api/erp/users/sync
```

```json
{
  "full": false,
  "users": [
    {
      "email": "zhangsan@corp.com",
      "name": "张三",
      "department": "设计部",
      "status": "active",
      "role": "user",
      "monthly_limit": 20
    }
  ]
}
```

- `full: true` 时，所有 `source=erp` 且不在本次列表里的账号会被停用（离职处理）；
- `monthly_limit` / `daily_limit` 省略表示不动，`null` 表示清除个人覆盖、回落到部门默认；
- 返回：

```json
{ "created": 1, "updated": 2, "unchanged": 8, "disabled": 1, "errors": [] }
```

## 3. 单用户额度

```http
PUT /api/erp/users/zhangsan@corp.com/quota
```

```json
{ "monthly_limit": 20, "daily_limit": 10 }
```

## 4. 用户与用量查询

```http
GET /api/erp/users?department=设计部&status=active
```

返回每个用户的 `department`、`source`、`last_login_at`、生效额度（`quota`）和本月用量（`usage`）。

## 5. 部门默认额度

管理员接口（浏览器会话）或直接调用内部 API：

```http
GET    /api/admin/quota/departments
PUT    /api/admin/quota/departments/设计部
{ "monthly_limit": 10, "daily_limit": 10 }
DELETE /api/admin/quota/departments/设计部
```

额度优先级：

```
个人覆盖 > 部门默认 > 全站默认
```

新员工加入部门后，如果没有个人覆盖，会自动继承部门额度。

## 6. 账号来源

`users.source` 取值：

- `local`：本地注册；
- `sso`：SSO 首次登录自动建号；
- `erp`：ERP 同步建号。

`full: true` 只停用 `source=erp` 的账号，不会误伤本地/SSO 账号。
