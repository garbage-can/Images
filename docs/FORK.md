# 公司分支（corp）说明

本分支基于 [shixian64/Images](https://github.com/shixian64/Images) `main`，用于公司内部生图平台，已做以下改造。

## 已移除

- **漫画工作流**：顶部「漫画」标签、面板、`/api/comic-projects`、`/api/comic-storyboards` 路由全部下线（服务层/数据表保留，避免破坏历史图库引用）。
- **视频工作流**：顶部「视频」标签、面板、`/api/video-projects`、`/api/video-storyboards` 路由全部下线。
- 图库中的「漫画项目 / 视频项目」范围标签、提示词来源里的「漫画」选项一并移除。

访问已下线的接口会返回 `404 not found`；前端不再加载对应模块。

## 已新增

### 用量看板

- 页面：`/usage.html`，管理后台「管理 → 用量看板」入口
- 接口：`GET /api/admin/usage?hours=5`（管理员）
- 数据：CPA 插件 `events` + Codex 额度窗口 + 本机 SQLite 任务/图片统计
- 说明：Codex 生图接口不回传百分比，看板会显示「比例未回传」，真实消耗看请求数

### 单点登录（OIDC）

- 登录页「使用公司账号登录」按钮
- 接口：
  - `GET /api/auth/sso/config`
  - `GET /api/auth/sso/start`
  - `GET /api/auth/sso/callback`
- 实现：Authorization Code + PKCE + state/nonce，JWKS 验签，邮箱域名白名单，首次登录自动建号
- 配置见 [`docs/SSO.md`](SSO.md)；未配置时 SSO 完全关闭，不影响密码登录

## 其他修复

- 前端「系统默认接口」Key 状态一直显示「读取中」：补回 `hasApiKey` 字段
- 取消任务被误记为 `image.generate.failed`：改为 `info / image.generate.cancelled`
- 用量看板外链化，兼容 CSP `script-src 'self'`
- 漫画分镜输出上限 5200 → 12000 tokens、对话超时 180s → 600s

## 与上游同步

```bash
git remote add upstream https://github.com/shixian64/Images.git
git fetch upstream
git merge upstream/main   # 或 rebase
```

注意：`services/comic-storyboard-jobs.js` 的 12000 tokens 常量、`routes/sso.js`、`services/sso.js`、用量看板相关文件属于本分支改动，合并上游时需保留。
