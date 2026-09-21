# OpenCode 免费模型桥接服务

把 OpenCode Zen 的请求和响应转换成标准的 OpenAI / Anthropic API 格式，供本机工具做兼容性测试。

> 当前限制：OpenCode 会在服务端限制免费模型只能从 OpenCode 内使用。即使本地已经登录，外部工具也可能收到 `OpenCode's free tier can only be used from within OpenCode`。本桥接不提供额度，也不能保证绕过或改变上游的套餐权限；遇到该错误时应改用 OpenCode 本身，或使用服务商正式开放的 API。

## 原理

OpenCode 的免费模型有使用限制（只能在 OpenCode 内使用），直接调用会返回：

```
OpenCode's free tier can only be used in OpenCode
```

本服务读取你本机 OpenCode 已登录的凭证，并在本地暴露兼容接口：

```
你的工具  ──►  本桥接服务(127.0.0.1:8788)  ──►  opencode.ai/zen/v1  ──►  免费模型
```

## 快速开始

1. 确认电脑已安装 Node.js 和 OpenCode，并且 OpenCode 已登录（桌面端或 `opencode auth login`）。
2. 双击 `start.bat`，看到 `Listening : http://127.0.0.1:8788` 即启动成功。**保持窗口开启**。
3. 浏览器或命令行访问 <http://127.0.0.1:8788/health> 检查状态。

## 在任意文件夹使用

桥接服务是全局的（监听 `127.0.0.1:8788`），一次启动即可服务所有项目。默认使用 8788 是为了避免与 Command Code 代理常用的 8787 冲突。

1. 本目录已加入用户 PATH。**打开一个新的终端窗口**（让 PATH 生效）。
2. 用 `cd` 进入你的任意项目文件夹，直接运行：

```bat
claude-code
```

它会在**当前文件夹**运行 Claude Code，并自动：
- 检查桥接服务，若未运行则后台自动启动；
- 加载 `claude-settings.json` 指向免费模型。

例如：

```bat
cd D:\my-project
claude-code
```

> 如果提示 `claude-code 不是内部或外部命令`，说明 PATH 尚未生效：请**重开终端**，
> 或直接使用完整路径 `C:\Users\yet11\Desktop\ai\opencode-bridge\claude-code.bat`。

其他 OpenAI 兼容工具同理，在任何项目中把 Base URL 填 `http://127.0.0.1:8788/v1` 即可。

## 让 OpenCode 桌面端 / 桥接走代理

当某些免费模型提示 `This model is not available in your country` 时，需要让请求走代理。
OpenCode（Bun 构建）会读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。

**设置一次，永久生效：**

1. 找到你的代理端口（Clash Verge 默认混合端口是 `7897`）。
2. 设置用户级环境变量（把下面的地址换成你自己的代理地址）：

```powershell
[Environment]::SetEnvironmentVariable("HTTPS_PROXY","http://127.0.0.1:7897","User")
[Environment]::SetEnvironmentVariable("HTTP_PROXY","http://127.0.0.1:7897","User")
[Environment]::SetEnvironmentVariable("NO_PROXY","localhost,127.0.0.1,::1,api.deepseek.com,.deepseek.com","User")
```

3. **完全退出并重新打开 OpenCode 桌面端**（右键托盘图标 → 退出，再启动），
   它启动的服务器才会带上代理变量。

> **关于 `NO_PROXY`**：其中加入 `api.deepseek.com` 是为了让**普通的 `claude`（DeepSeek 配置）
> 直连、不受代理开关影响**——这样即使代理关闭，`claude` 也能正常使用。
> 如果你还用了别的直连服务，把它的域名也加进 `NO_PROXY` 即可。

**桥接服务**会自动检测代理是否在线：在线则走代理，离线则自动直连，
所以代理关闭时桥接也不会报错。访问 `http://127.0.0.1:8788/health` 可看到当前是
`"proxy": "http://127.0.0.1:7897"` 还是 `"proxy": "direct"`。

**取消代理：**

```powershell
[Environment]::SetEnvironmentVariable("HTTPS_PROXY",$null,"User")
[Environment]::SetEnvironmentVariable("HTTP_PROXY",$null,"User")
[Environment]::SetEnvironmentVariable("NO_PROXY",$null,"User")
```

> 注意：设置后**所有**遵循该变量的程序（git、npm 等）都会走代理；
> `NO_PROXY` 已排除本机地址，保证本地桥接通信不受影响。
> 另外，`muse-spark` 这类模型是否可用还与代理节点所在地区有关，
> 若某个节点仍失败，可在 Clash Verge 里换一个其它地区（如美国/日本）的节点再试。

## 提供的接口

| 接口 | 协议 | 说明 |
| --- | --- | --- |
| `GET /v1/models` | OpenAI | 列出可用模型 |
| `POST /v1/chat/completions` | OpenAI | 聊天补全，支持流式 |
| `POST /v1/messages` | Anthropic | 供 Claude Code 使用，支持流式 |
| `GET /health` | - | 健康检查 |

## 常用免费模型

推荐顺序（越靠前越稳）：

- `opencode/deepseek-v4-flash-free`（默认）
- `opencode/ling-3.0-flash-fin-free`
- `opencode/nemotron-3-ultra-free`
- `opencode/nemotron-3.5-lightning-free`
- `opencode/mimo-v2.5-free`
- `opencode/big-pickle`
- `opencode/muse-spark-1.3-contributor-free`（部分地区不可用）
- `opencode/muse-spark-1.2-contributor-free`（部分地区不可用）

> 免费模型会时不时被限流或临时不可用（返回 `Model is unavailable` / 空响应）。
> 桥接会**自动依次尝试**默认模型和备用模型，直到有可用结果，因此无需手动切换。

## 用法一：OpenAI 兼容工具

- Base URL：`http://127.0.0.1:8788/v1`
- API Key：随便填（例如 `opencode`）
- 模型：`opencode/deepseek-v4-flash-free`

命令行测试：

```bash
curl http://127.0.0.1:8788/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"opencode/deepseek-v4-flash-free\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

## 用法二：Claude Code CLI

1. 安装 Claude Code：

```bash
npm install -g @anthropic-ai/claude-code
```

2. 先双击 `start.bat` 启动桥接服务（保持窗口开启）。
3. 双击 `claude-code.bat` 启动 Claude Code，它会自动加载 `claude-settings.json` 并指向免费模型。

> **注意**：如果你本地已有 `~/.claude/settings.json` 且里面配置了 `env`（例如指向别的服务），
> 它的优先级高于系统环境变量。因此本方案使用 `--settings` 参数单独指定配置文件，
> 不会影响你原有的 Claude Code 配置。

等价的手动命令：

```bat
claude --settings "C:\Users\yet11\Desktop\ai\opencode-bridge\claude-settings.json"
```

`claude-settings.json` 内容（可自行修改模型）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788",
    "ANTHROPIC_AUTH_TOKEN": "opencode-bridge",
    "ANTHROPIC_MODEL": "opencode/deepseek-v4-flash-free",
    "ANTHROPIC_SMALL_FAST_MODEL": "opencode/deepseek-v4-flash-free",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "opencode/deepseek-v4-flash-free",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "opencode/deepseek-v4-flash-free",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opencode/deepseek-v4-flash-free",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "opencode/deepseek-v4-flash-free",
    "CLAUDE_CODE_SUBAGENT_MODEL": "opencode/deepseek-v4-flash-free"
  }
}
```

> 启动时若出现 `[claude-code:unrecognized_model]` 提示属于正常现象（Claude Code 不认识非 Claude 的模型名），不影响使用。

### 在 Claude Code 里用 `/model` 切换免费模型

Claude Code 的 `/model` 菜单里只有 `Default / Opus / Sonnet / Haiku` 这些别名，它们分别对应下面三个环境变量。
本方案已把它们映射成**不同的免费模型**，所以在 Claude Code 里输入 `/model` 选择即可切换：

| `/model` 里选择 | 实际使用的免费模型 |
| --- | --- |
| `Default` | `opencode/muse-spark-1.3-contributor-free` |
| `Opus` | `opencode/muse-spark-1.3-contributor-free` |
| `Sonnet` | `opencode/mimo-v2.5-free` |
| `Haiku` | `opencode/nemotron-3-ultra-free` |
| `Fable` | `opencode/big-pickle` |

想换成别的组合，编辑 `claude-settings.json` 里对应的 `ANTHROPIC_DEFAULT_*_MODEL` 即可。

> ⚠️ **注意**：请只通过上面的别名选择，不要手动输入 `claude-*` 这类名字。
> 因为 `claude-sonnet-*` / `claude-opus-*` 等同时是 OpenCode Zen 上的**付费模型**，
> 桥接会原样转发，可能产生费用。免费模型名都以 `-free` 结尾或以 `big-pickle`、`ling-` 等命名。
>
> 若某个免费模型临时不可用（限流 429 / 地区限制 403 / 端点不可用 503），桥接会自动重试并回退到其它免费模型，无需手动处理。
>
> 提示：`muse-spark-1.3` 在部分地区会返回 `This model is not available in your country`，此时会自动回退；如需稳定使用可配合代理。

## 可配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BRIDGE_PORT` | `8788` | 本服务监听端口 |
| `BRIDGE_HOST` | `127.0.0.1` | 监听地址（不要对外网开放） |
| `DEFAULT_MODEL` | `deepseek-v4-flash-free` | 首选模型 |
| `FALLBACK_MODELS` | `ling-3.0-flash-fin-free,nemotron-3-ultra-free,big-pickle` | 备用模型（逗号分隔，依次重试） |
| `OPENCODE_ZEN_KEY` | 自动读取 | 手动指定 OpenCode Zen 密钥 |
| `OPENCODE_AUTH_FILE` | 自动查找 | 手动指定 `auth.json` 路径 |

## 常见问题

- **提示 `hasKey: false`**：没有找到 OpenCode 凭证。请先登录 OpenCode，或设置 `OPENCODE_ZEN_KEY`。
- **提示 `OpenCode's free tier can only be used from within OpenCode`**：凭证已读取，但免费套餐拒绝外部客户端。请使用 OpenCode 本身，或改用正式开放的 API；更换本地认证占位值无法解决。
- **返回 429 / `Model is unavailable` / 空回复**：免费模型被限流或临时不可用。桥接会自动切换备用模型；若仍失败请稍后再试，避免高频并发。
- **Claude Code 卡住或反复重试**：多为免费模型过载所致，可改用其它免费模型，或稍后再试。
- **`claude-code` 命令找不到**：重开终端让 PATH 生效，或用完整路径调用。
- 本服务只监听本机，请勿暴露到公网；仅用于个人学习/轻量使用。
