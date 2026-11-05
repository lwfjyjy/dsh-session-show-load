# dsh-session-show-load

在当前对话顶部新增一个「**加载**」tab，一眼看清本次对话到底给模型加载了哪些东西，参考 Pi agent 启动横幅的 `[Context] / [Skills] / [Extensions]`。

## 展示内容

> 数据来源：宿主读取**完整会话事件日志**（`sessionQuery.readSession`），所以连会话最开始、早已退出视口的系统提示词 / 指令文件 / 技能目录都能看到；浏览器端当前快照只用作兜底。

| 分组 | 来源 | 说明 |
| --- | --- | --- |
| 系统提示词 | `system/message` 事件 | 完整系统提示词，默认收起 |
| 指令文件 | `agent-instructions` 注入 | AGENTS.md 等文件的路径与 set/update 动作，可展开注入原文 |
| 技能 | `skill-catalog` / `skill-invocation` | 可用技能列表（名称 + 描述） |
| 工具 | `request/header` 的 `tools` | 工具名 + 描述，默认收起 |
| 运行环境 | `snapshot` 形式注入 | 工作目录、沙箱、审批策略、时间等 |
| 其它注入 | notice / relay / recall | 其它上下文注入 |

## 逐块 AI 翻译

每个文本块（系统提示词、注入的 AGENTS 原文、每条技能/工具描述、运行环境快照、其它注入）右上角都有一个「翻译」按钮：

- **点哪个翻哪个**，不发无用请求；结果缓存在组件内，可在「原文 / 译文」之间切换，也可一键复制。
- **不依赖任何外部翻译插件**：点「翻译」时由宿主悄悄用你当前的默认大模型**新发一次独立对话**来翻译，译文自然、贴合语义，并保留代码/命令/路径不译。
- 这次翻译是独立请求，**不会写进当前对话、也不会污染上下文**；只有你点的那块文字会被发送。
- 会消耗模型的 Token（按钮旁会标注「由 AI 翻译，可能需要几秒」）。
- 长文本会自动分段翻译再拼接，避免超出单次输出上限。
- **每份译文都会自动保存**，面板左侧会多出「翻译记录」：桌面客户端存本机 `~/.dsh/profiles/<profile>/.dsh-session-show-load/translations.json`（最多 50 份，关掉再开还在），纯浏览器存浏览器本地（最多 10 份）。

## 安装

本插件是标准 DSH bundle（`dsh.manifestVersion = 1`），在工作区用 DSH 的插件安装器指向本目录即可：

```
plugin_manager install_bundle(target = "<本目录绝对路径>")
```

安装后在任意对话顶部就会出现「加载」tab（order = 20，位于「轨迹」与「上下文」之间）。

## 文件

- `client.js` —— 浏览器端：拉取 `/session-show-load/data` 并渲染面板、逐块翻译
- `index.js` —— 宿主端：注册 `/session-show-load/data`（读会话日志归纳）、`/session-show-load/translate`（用默认大模型新发一次独立调用翻译）、`/session-show-load/translation-info`（报告当前翻译模型，用于按钮提示）
- `cordis.patch.yml` —— bundle patch，插入插件节点
- `locale/{zh,en}.json` —— 插件元信息
- **已翻译过的块会自动恢复**：重新打开面板时，若该段文字已保存在翻译记录里，会直接显示译文并保留「原文/译文」切换，无需重新翻译。
