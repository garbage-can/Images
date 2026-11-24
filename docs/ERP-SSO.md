# Image Studio 对接 ERP 单点登录（OAuth2）接口说明

> 版本：2026-11-24
> 对接方：Image Studio（`https://openwebui.111254.xyz`）
> 本文档供 ERP 单点登录实施人员使用。

## 1. 双方信息

| 项目 | 值 |
|---|---|
| 我方系统 | Image Studio |
| 我方回调地址（redirect_uri） | `https://openwebui.111254.xyz/api/auth/sso/callback` |
| ERP 授权地址 | `https://erp.8dt.com/supply/oauth/authorize` |
| ERP Token 地址 | `https://erp.8dt.com/supply/oauth/access_token` |
| ERP 用户信息地址 | `https://erp.8dt.com/supply/oauth/user/profile` |
| client_id | `AUTH_IMAGEWB` |
| client_secret | 已由贵方提供，仅保存在我方服务器，不在文档中展示 |
| 授权模式 | Authorization Code |
| scope | 不传（当前 ERP 不需要） |
| PKCE | 关闭（如后续启用另行通知） |

如 ERP 需要 IP 白名单，我方服务器当前出口 IP 为：

```
198.46.240.107
```

（如出口 IP 有变更会提前通知。）

## 2. 流程

```
用户浏览器                  Image Studio                     ERP
    |                           |                              |
    | 点击“使用公司账号登录”     |                              |
    |-------------------------->|                              |
    |                           | 302 authorize?client_id=...  |
    |<--------------------------|                              |
    | 访问 ERP 授权页 ---------------------------------------->|
    |                           |                              |
    |                     （ERP 已登录则生成 code）             |
    |<-------------------------- 302 redirect_uri?code=... ----|
    |                           |                              |
    | 回调 /api/auth/sso/callback?code=...                     |
    |-------------------------->|                              |
    |                           | POST access_token (code) --->|
    |                           |<--- access_token ------------|
    |                           | GET user/profile?access_token=|
    |                           |<--- userinfo ----------------|
    |                           | 建/匹配用户、写 session       |
    |<-------------------------- 302 进入工作台                 |
```

## 3. 我方发起授权请求

Image Studio 会 302 到：

```http
GET https://erp.8dt.com/supply/oauth/authorize
  ?response_type=code
  &grant_type=authorization_code
  &client_id=AUTH_IMAGEWB
  &redirect_uri=https%3A%2F%2Fopenwebui.111254.xyz%2Fapi%2Fauth%2Fsso%2Fcallback
  &state=<随机值>
```

说明：

- `redirect_uri` 必须与 ERP 后台登记的值**完全一致**，包括协议、路径，不能多斜杠；
- `state` 为我方防 CSRF 的随机值，ERP 能原样回传最好；当前 ERP 不回传时我方已做兼容，不影响登录；
- 不需要 scope；
- 不需要 PKCE。

## 4. ERP 回调要求

ERP 授权成功后，302 到：

```http
GET https://openwebui.111254.xyz/api/auth/sso/callback?code=<授权码>
```

要求：

1. `code` 必须 URL 编码；
2. `code` 一次性、有效期建议不超过 10 分钟；
3. 如果 ERP 支持 `state`，请原样带回：`&state=<收到的值>`；
4. 授权失败时回调 `?error=...&error_description=...`，我方会展示错误。

> 目前 ERP 回调只带 `code`，我方已兼容；无需为此改造。

## 5. 我方服务端请求 ERP

### 5.1 code 换 access_token

```http
POST https://erp.8dt.com/supply/oauth/access_token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<授权码>
&redirect_uri=https%3A%2F%2Fopenwebui.111254.xyz%2Fapi%2Fauth%2Fsso%2Fcallback
&client_id=AUTH_IMAGEWB
&client_secret=<client_secret>
```

期望响应（JSON，字段名保持 snake_case，且在顶层）：

```json
{
  "access_token": "...",
  "token_type": "bearer",
  "expires_in": 7200
}
```

### 5.2 读取用户信息

```http
GET https://erp.8dt.com/supply/oauth/user/profile?access_token=<access_token>
```

期望响应（两种结构我方都兼容）：

```json
{
  "id": "u1001",
  "name": "张三",
  "number": "YL8888",
  "phone": "13800000000"
}
```

或：

```json
{
  "data": {
    "id": "u1001",
    "name": "张三",
    "number": "YL8888",
    "phone": "13800000000"
  }
}
```

字段要求：

| 字段 | 必填 | 用途 |
|---|---|---|
| `phone` | **是** | 作为平台用户唯一标识；没有手机号无法建号 |
| `name` | 建议 | 显示名 |
| `email` | 否 | 有则优先使用 |
| `number` | 否 | 工号，可留档 |
| `department` | 否 | 部门，用于部门默认额度 |

`phone` 会做归一化（去掉非数字、去掉 `+86` 前缀），例如 `+86 138-0000-0000` → `13800000000`。

## 6. 平台侧账号规则

- 第一次 SSO 登录：按手机号自动建平台账号，内部邮箱为 `<phone>@erp.8dt.com`；
- 第二次登录：按 `phone` 匹配到同一账号；
- 平台不保存、也不需要 ERP 密码；
- 账号被停用（`status=disabled`）时 SSO 会拒绝登录；
- 如果员工在 ERP 侧离职，建议同时通过 ERP 同步接口停用平台账号。

## 7. 错误处理约定

ERP 的 token / profile 接口失败时，请返回：

- HTTP 4xx；
- `Content-Type: application/json`；
- 响应体：

```json
{ "error": "invalid_code", "error_description": "授权码无效或已过期" }
```

我方会把 `error`/`error_description` 记入日志，并跳回登录页提示。

## 8. 联调步骤

1. 在 ERP 后台确认 `AUTH_IMAGEWB` 的回调地址为  
   `https://openwebui.111254.xyz/api/auth/sso/callback`；
2. 浏览器先登录 ERP（`https://erp.8dt.com`）；
3. 打开 `https://openwebui.111254.xyz/login.html`，点「使用公司账号登录」；
4. 应跳回平台并登录成功；
5. 用同一账号再登录一次，确认落到同一平台账号；
6. 用未登录 ERP 的浏览器测试：ERP 返回 `OUTOF-LOGIN` 属于正常，需先登录 ERP。

## 9. 验收清单

- [ ] authorize 能生成 code 并 302 回我方回调
- [ ] token 接口能返回顶层 `access_token`
- [ ] profile 接口能返回 `phone` 和 `name`
- [ ] 平台首次登录成功并自动建号
- [ ] 第二次登录匹配到同一账号
- [ ] 未登录 ERP 时提示明确（`OUTOF-LOGIN`）
- [ ] 授权码重复使用返回 4xx
- [ ] 回调地址不匹配时 ERP 明确报错

## 10. 常见问题

**Q：跳过去显示 `OUTOF-LOGIN`**  
A：ERP 当前浏览器没有有效登录态，先登录 ERP，再点平台按钮。

**Q：回调后平台提示“登录会话已过期”**  
A：早期版本强制要求 `state`，现已兼容 ERP 不回传；若仍出现，请提供回调 URL 和时间点。

**Q：能不能用手机号直接登录平台？**  
A：不能。手机号只用于 SSO 匹配；平台账号没有可用密码，必须走 ERP 单点登录。

**Q：token 接口返回嵌套结构可以吗？**  
A：可以，但需要是 `data.access_token` 这种明确嵌套；请在联调时提供实际响应示例。
