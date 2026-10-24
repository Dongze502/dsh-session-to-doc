# 开源与上架 dshmarket：手把手

这份文档是写给「第一次开源、还没有 GitHub 账号」的人的。按顺序做，每一步都有可执行的命令和验收方式。

目标链路：

```
本地插件目录  →  GitHub 仓库（带 dsh-plugin topic）  →  npm 包（可选但推荐）
                                                        ↓
                                    awesome-dsh-plugin 仓库加一个 YAML 文件（提 PR）
                                                        ↓
                                    dshmarket / 市场站点自动收录（通常 1 天内）
```

## 0. 先搞清楚：dshmarket 不是投稿入口

`dshmarket` 是市场**界面**，不是插件目录。它的插件列表实时取自精选目录
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：

- 市场 README 原文：*"This repo is the market app, not the catalog … to get your plugin listed in the market, open a PR **there**"*
  （`dshmarket/README.md:115`，中文版 `README.zh.md:107-109`）
- 数据源：`https://awesome-dsh-plugin.com/plugins.json`（可用 `DSHM_REGISTRY_URL` 指到镜像）

所以「上架 dshmarket」= **给 awesome-dsh-plugin 提一个 PR，加一个 YAML 文件**。合并后市场下一次拉取就出现，不需要碰 dshmarket 仓库。

## 1. 账号准备

需要两样东西，都免费：

1. **GitHub 账号**（必须）——仓库和 PR 都在这里。
   - 打开 <https://github.com/signup>，用邮箱注册，起一个用户名（例如 `yourname`）。
   - 这个用户名会进入：仓库地址 `https://github.com/<用户名>/dsh-session-to-doc`、投稿文件名 `<用户名>__dsh-session-to-doc.yml`。之后改用户名会让投稿文件名对不上，**先想好再注册**。
   - 建议顺手开 2FA（Settings → Password and authentication），不开也能用，但提 PR 时可能被要求验证。
2. **npm 账号**（可选，但强烈推荐）——见第 4 步的原因。
   - 打开 <https://www.npmjs.com/signup> 注册；本地 `npm login` 登录。

> 本机已经有 git（`git --version` → 2.56.0.windows.2），但 `git config user.name` / `user.email` 是空的，第一次提交前必须设置，否则 `git commit` 会直接报错。

## 2. 仓库里已经准备好的东西

这些已经在插件目录里，**不需要你改**（除了用户名占位符）：

| 文件 | 作用 |
| --- | --- |
| `LICENSE` | MIT 许可证。今年是 2026，版权人写的是 `dsh-session-to-doc contributors`；想署自己名字就改这一行 |
| `package.json` | 已加 `license` / `keywords` / `engines.dsh` / `files` / `prepack`，`name` 为 `dsh-session-to-doc` |
| `cordis.patch.yml` | 仓库根必须有它，且 `name:` 与包名一致（投稿 CI 会检查 `dsh.bundle`） |
| `.github/workflows/ci.yml` | 每次 push / PR 自动跑：安装 → 构建 → 31 个测试 → 客户端冒烟 → 语法检查 → 「产物里没有运行时 `@deepseek-ai` import」 |
| `assets/icon-180.png` / `icon-512.png` | 市场卡片图标，已按 96px 显示优化成方形 |
| `docs/session-to-doc.md` | 设计与实现文档 |
| `.gitignore` | 忽略 `node_modules/`、`.pnpm-store/`、`.pnpm-cache/`、`*.tsbuildinfo` |
| `pnpm-lock.yaml` / `pnpm-workspace.yaml` | CI 用 `--frozen-lockfile` 装依赖 |

还需要你补两处（拿到 GitHub 用户名之后）：

1. `package.json` 加仓库地址（放在 `"publishConfig"` 之前）：

   ```jsonc
   "repository": {
     "type": "git",
     "url": "git+https://github.com/<用户名>/dsh-session-to-doc.git"
   },
   "homepage": "https://github.com/<用户名>/dsh-session-to-doc#readme",
   "bugs": { "url": "https://github.com/<用户名>/dsh-session-to-doc/issues" }
   ```

2. 可选：README 顶部加一行徽章（把 `<用户名>` 换掉）：

   ```markdown
   [![CI](https://github.com/<用户名>/dsh-session-to-doc/actions/workflows/ci.yml/badge.svg)](https://github.com/<用户名>/dsh-session-to-doc/actions/workflows/ci.yml)
   ```

## 3. 建仓库并推送

先确认最终产物是最新的（改过源码就跑一次）：

```bash
cd "<本目录>"
npm run verify        # 构建 + 31 个测试 + 客户端冒烟
```

然后初始化仓库。**仓库根必须是本目录**（`package.json`、`cordis.patch.yml`、`lib/` 都在根上）：

```bash
git init
git branch -M main

# 身份只需设置一次；邮箱用 GitHub 的 noreply 也可以
git config user.name "<你的名字>"
git config user.email "<你的邮箱>"

git add -A
git commit -m "feat: session-to-doc — reorganize a session into a structured Markdown document"

git remote add origin https://github.com/<用户名>/dsh-session-to-doc.git
git push -u origin main
```

首次 push 会要求登录：GitHub 从 2021 年起不接受账号密码，用 **Personal Access Token**
（GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，
给这个仓库 `Contents: Read and write` 权限），或装 GitHub CLI 后 `gh auth login`。
浏览器弹出的登录窗口（Git Credential Manager）照着走也可以。

建好仓库后做两件事：

1. **加 topic**：仓库页右上角齿轮 → Topics → 输入 `dsh-plugin` 保存。
   投稿要求里明确写了这一条（`contributing.md`「Add the `dsh-plugin` topic to your repo」）。
2. **确认 CI 绿了**：仓库页 Actions 标签下应该有一条绿色运行记录。红了就按日志修；
   最常见的原因是锁文件与 `package.json` 不一致，本地跑一遍 `pnpm install --node-linker=hoisted` 再提交 `pnpm-lock.yaml`。

> ⚠️ **仓库必须创建满 1 天**才能被收录。投稿 CI 会查仓库年龄，专门过滤「提 PR 前几分钟才建」的仓库。
> 所以：**今天建仓库、推代码、加 topic；明天再提 PR。** 差几个小时也可能卡住，直接等满 24 小时最稳。

## 4. 发布到 npm（可选，但建议做）

不做也能上架（走 GitHub 源码安装），但做了有三个好处：

- 安装变成**预构建**，跳过 `allowBuilds` 构建授权那一步；
- 市场卡片能显示下载量、能按下载量排序；
- 用户 `dsh plugin add dsh-session-to-doc` 一句就能装，不用带 `github:` 前缀。

`package.json` 里已经接好 `prepack`（发布前自动 `tsc` 构建），所以发布前**不要**手动删 `lib/`：

```bash
npm login --registry=https://registry.npmjs.org/   # 浏览器/一次性密码验证
npm publish                                        # prepack 自动跑 build，然后打包 lib/ client/ README LICENSE
```

> **本机的 `~/.npmrc` 把 registry 指向了 `registry.npmmirror.com`（只读镜像）。** 镜像不接受登录与发布，所以 `npm login` / `npm publish` 必须显式指回 npmjs；上面 `publishConfig.registry` 已经保证 `npm publish` 走官方源，`npm login` 仍需带参数。

验收：

```bash
npm view dsh-session-to-doc version --registry=https://registry.npmjs.org/   # 应该输出 0.2.2
dsh plugin --profile web add dsh-session-to-doc   # 任意一台装了 dsh 的机器
```

几个容易踩的点：

- `name` 一旦发布就不能改（要改只能换名重发并 `npm deprecate` 旧包），`dsh-session-to-doc` 已经确认没被占用；
- 版本号只能往上升，重发必须 `npm version patch`；
- 包名不带 scope 时 `publishConfig.access` 无意义但无害；如果你以后改成 `@你的名字/dsh-session-to-doc`，`npm publish` 要加 `--access public`（`publishConfig` 已经写了）。

**不想发 npm** 也有正规做法：`pnpm pack` 生成 tarball，传到 GitHub Release，并在投稿条目里用 `tarball:` 指向它（见第 5 步）。注意文件名**不要带版本号**（用 `latest/download/` 时带版本号会在下次发版后 404），或者把 URL 钉到具体 tag。

## 5. 给 awesome-dsh-plugin 提 PR

这是「上架」真正的那一步。

### 5.1 fork + clone

网页上打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> → 右上 Fork → 得到 `<用户名>/awesome-dsh-plugin`。

```bash
git clone https://github.com/<用户名>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-session-to-doc
```

### 5.2 只加一个文件

新建 `data/plugins/<用户名>__dsh-session-to-doc.yml`（**文件名 = 仓库 owner + `__` + 仓库名**，全小写，与本仓库目录名一致）：

```yaml
url: https://github.com/<用户名>/dsh-session-to-doc
name: <用户名>/dsh-session-to-doc
category: tools
description:
  en: Reorganizes a DeepSeek Harness session transcript into a structured Markdown document with an outline and table of contents, instead of exporting the chat in chronological order; available as a model tool, a composer button and a loopback-only Web endpoint.
  zh: 把 DSH 当前会话的对话记录重组成带大纲、章节层级和目录的结构化 Markdown 文档，而不是按时间顺序原样导出；同时提供模型工具、输入框按钮与仅回环的 Web 接口三种入口。
icon: https://raw.githubusercontent.com/<用户名>/dsh-session-to-doc/main/assets/icon-180.png
```

说明：

- **不要改 `README.md` / `README.zh.md`**：两个 README 由 `data/plugins/*.yml` 生成，合并后会自动重建。手改会跟别人的 PR 冲突。
- `description.en` 是唯一必填项；`zh` 写不出来可以不写，维护者会补。
- 描述里如果出现 `: `（冒号+空格）必须给整行加引号，否则 YAML 解析失败。上面两条都用单行文本，没有裸冒号。
- `name` 的显示文字用 `owner/repo`；如果是 monorepo 子包才用 `owner/repo#子包名`，并把 `url` 指到子目录。
- `category` 从这组里挑最贴切的（选不准不会被打回，维护者会改）：
  `agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`
  本插件是「一个整理会话的工具 + 一个按钮」，`tools` 最稳妥（备选 `docs`、`session`）。
- `icon` 必须是 **GitHub 托管的位图**（png/jpg/webp），SVG 和第三方图床会被拒。上面用的是 raw.githubusercontent.com 直链，卡片按 ~96px 显示。
- **描述必须属实**：投稿会对着源码核对。别写"支持 X 种格式"之类不存在的能力；本插件真实能力就是三种入口 + 两轮模型调用 + 确定性 TOC。

### 5.3 提交 PR

```bash
git add data/plugins/<用户名>__dsh-session-to-doc.yml
git commit -m "Add dsh-session-to-doc"
git push origin add-dsh-session-to-doc
```

然后在网页上开 PR（标题例如 `Add dsh-session-to-doc`），正文写清：插件做什么、三种入口、31 个测试怎么跑、是否已发 npm（贴包名）。

### 5.4 CI 会依次检查什么

1. **每个 PR 最多 3 条**（多于此会被要求拆分）；
2. **`dsh.bundle`**：从你仓库的 `package.json`（根，或 `packages/` · `plugins/` · `apps/` 子包）读取 `dsh.bundle`。只声明 `dsh.client` 是最常见的被拒原因——本插件两者都有，没问题；
3. **仓库年龄 ≥ 1 天**；
4. **awesome-lint + 站点构建**：中英双语一致性、分隔符、日期、截图。

失败时 CI 会写明改什么；在同一个分支上继续 push 即可，不用重开 PR。维护者还会人工读一遍源码，核对描述里的每个数字与 API 名。

## 6. 合并之后

- 站点和市场会自动重建，`plugins.json` 里出现你的条目（通常当天或次日）。条目的 `npm` 字段取自你仓库 `package.json` 的 `name`，`install` 会变成 `dsh plugin --profile web add dsh-session-to-doc`。
- 在 dsh 里：**插件 → 发现（Discover）**，或直接 `dsh plugin add dsh-session-to-doc`；装了 `dshmarket` 的话在插件页搜 "session" / "文档"。
- 想改描述/图标/分类：改 `data/plugins/<owner>__<repo>.yml` 再提一个 PR，**只动自己那一条**。
- 想换截图：不用来这里提 PR，在自己仓库根放 `screenshots.json`（1 到 8 张，相对路径，不能跳出插件目录），夜市构建会自动抓。

## 7. 常见被拒原因（自查清单）

- [ ] `package.json` 里同时有 `dsh.bundle.patch` 和仓库根的 `cordis.patch.yml`（`name:` 与包名一致）
- [ ] 仓库**创建满 24 小时**
- [ ] 仓库加了 `dsh-plugin` topic
- [ ] `node_modules/`、`.pnpm-store/`、`.pnpm-cache/` 没有被提交（`.gitignore` 已处理，`git status` 自查）
- [ ] 描述里没有营销词、没有夸大数字、提到的能力都能在代码里找到
- [ ] `@deepseek-ai/*` 只出现在 `peerDependencies` / `devDependencies`，不在 `dependencies`，也不在运行时 import 里（`lib/index.js` 里应为 0 处）
- [ ] peer 范围带显式预发布分支（本插件把 cordis 标成 optional，避免了这个问题）
- [ ] 用了 `tarball:` 的话，URL 是 GitHub Release 的 https `.tgz`，且文件名不带版本号（或钉住 tag）
- [ ] 一个 PR 只加 1 条、只碰自己的文件

## 8. 之后的版本更新

```bash
npm version patch        # 0.2.2 → 0.2.3，自动打 tag
npm publish
git push --follow-tags
```

投稿条目通常**不用动**（市场按包名从 npm 读最新版本）；只有描述过时、分类想换、或截图要重排时才去改 YAML。

## 9. 本地目录与包名不一致的说明

本仓库目录仍叫 `session-to-doc/`，但 npm 包名、插件行 id、客户端注册 id 都是 `dsh-session-to-doc`：

- `package.json` → `"name": "dsh-session-to-doc"`
- `cordis.patch.yml` → `- id: dsh-session-to-doc` / `name: dsh-session-to-doc`
- `client/client.js` → `window.__ModuleLoader__.load({ id: 'dsh-session-to-doc', ... })` 与 slot 注册的 `id`
- DSH profile 里安装目录也应改名为 `node_modules/dsh-session-to-doc`

三者必须一致，否则要么宿主解析不到包（`dsh.client` 找不到 `./client`），要么浏览器模块 id 对不上而按钮不出现。改完记得重新 `npm run build`、同步安装目录、完全退出 DSH 再启动。
