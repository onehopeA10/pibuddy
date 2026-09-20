# PiBuddy 文档站

面向 PiBuddy（面向办公用户的 pi 智能体桌面助手）的产品与工程文档站，布局参考 [pi-docs.aiuo.net](https://pi-docs.aiuo.net/)，基于 [VitePress](https://vitepress.dev/) 构建，与主仓库 monorepo 相互独立（不在 `pnpm-workspace.yaml` 的 `packages/*` 范围内）。中文为默认语言（`/`），英文在 `/en/`。

## 本地开发

```bash
cd pibuddy-docs
pnpm install        # 或 npm install
pnpm dev            # 本地开发服务器
pnpm build          # 产出静态站点到 docs/.vitepress/dist
pnpm preview        # 预览已构建站点
```

## 目录结构

```
pibuddy-docs/
├─ package.json
└─ docs/
   ├─ .vitepress/
   │  ├─ config.mts        # 站点配置：双语导航、侧栏、搜索
   │  └─ theme/            # 自定义主题：首页布局与视觉
   ├─ public/
   │  ├─ favicon.svg       # 标签页图标
   │  ├─ logo.svg          # 深色 logo
   │  ├─ logo-light.svg    # 浅色 logo
   │  └─ screens/          # 产品界面截图
   ├─ index.md             # 中文首页
   ├─ screens/             # 截图
   ├─ guide/ architecture/ runtime/ security/ data/ delivery/ extensions/
   └─ en/                  # 英文镜像：同一信息架构
```

内容取材于主仓库 `doc/` 与 `docs/product/` 中的真实工程文档。

## 部署到 pibuddy.top

文档站是纯静态站点，**用 GitHub Pages 即可，不需要 VPS**。正式地址是 [https://pibuddy.top](https://pibuddy.top)。工作流 `.github/workflows/docs.yml` 在 `main` 上改了 `pibuddy-docs/`，或手动 `workflow_dispatch`，就会构建并发布。

### 1. 打开 GitHub Pages

1. 打开 [仓库 Settings → Pages](https://github.com/onehopeA10/pibuddy/settings/pages)。
2. **Build and deployment → Source** 选 **GitHub Actions**。
3. **Custom domain** 填 `pibuddy.top`，勾选 **Enforce HTTPS**。

`docs/public/CNAME` 已经写了 `pibuddy.top`，构建产物会带上它。

### 2. Spaceship DNS（根域名）

Spaceship → `pibuddy.top` → **DNS Records**，按下面加（如已有冲突的 `@` A / CNAME，先删掉）：

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `onehopeA10.github.io` |

DNS 通常几分钟到几小时生效。GitHub 校验通过后才会签发 HTTPS 证书；在此之前先用 `http://pibuddy.top` 或 `https://onehopeA10.github.io/pibuddy/` 确认站点已经发布。

