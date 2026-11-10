# ODE-cloud

> 独立网盘命令行工具：登录、分享解析、文件下载。无 UI、无本地服务、无第三方依赖。

ODE-cloud 把 7 家网盘的账号会话、分享列表和下载统一到一个 `node cli.mjs` 入口。整个项目是纯 ESM 源码，复制目录即可运行，也可以单独打包分发，不依赖任何其他项目。

[使用教程](./USAGE.md) · [开发指南](./DEVELOPMENT.md)

## 特性

- **单一入口**：所有用户功能都在 `cli.mjs`，`node cli.mjs --help` 即完整命令表；不提供别名或隐藏参数。
- **7 家网盘**：迅雷、夸克、123、天翼、移动、百度、115，登录、在线校验、账号信息与分享下载使用同一套命令和输出结构（百度仅支持分享列表，不支持下载）。
- **两种下载引擎**：默认 HTTP Range 多并发；迅雷可选本地私有 SDK。大小校验始终保留，没有跳过检查的开关。
- **安全默认**：只接受官方 HTTPS 分享链接与直链；不破解验证码、不绕过风控、不伪造直链；凭据只保存在本机。
- **可独立分发**：无第三方 npm 依赖、无 UI、无本地 Web 服务；打包脚本按白名单生成干净目录，自动排除 SDK 二进制、账号与下载文件。

## 平台支持

| 网盘 | 平台名称 | 登录 | 官方账号校验 / whoami | 分享列表与下载 |
| --- | --- | --- | --- | --- |
| 迅雷 | `xunlei` | 官网浏览器；另有 `--sms` | 支持 | HTTP；可选本地 SDK |
| 夸克 | `quark` | 官网浏览器 | 支持 | HTTP |
| 123 | `pan123` | 官网浏览器 | 支持 | HTTP |
| 天翼 | `tianyi` | 官网浏览器 | 支持 | HTTP |
| 移动 | `yidong` | 官网浏览器捕获 authorization | 暂无独立账号校验，verified 为 null | HTTP |
| 百度 | `baidu` | 官网浏览器 | 支持 | 官方分享递归列表；暂不支持下载（不转存、不解析直链） |
| 115 | `115` | 官网浏览器 | 官方账号接口校验与账号信息 | HTTP |

支持表示保留了实现，不代表已用真实账号在线验证全部平台。登录、校验与下载均受官方接口、账号权限、会员、风控和分享有效期限制。

## 快速开始

需要 **Node.js 22+**，无需 `npm install`；官网登录需要本机 Chrome 或 Edge。

```sh
node cli.mjs --help

node cli.mjs login quark
node cli.mjs status quark --verify
node cli.mjs share "官方分享链接"
node cli.mjs get "官方分享链接" --output "D:/Downloads"
```

普通文件直链：

```sh
node cli.mjs direct "https://example.com/file.zip" --output "./downloads/file.zip"
```

完整命令、参数、输出字段、错误码与平台限制见 **[使用教程](./USAGE.md)**。

## 文档

| 文档 | 内容 |
| --- | --- |
| [USAGE.md](./USAGE.md) | 全部命令与参数、登录流程、分享与下载、进度输出、环境变量、SDK 安装、常见报错 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 目录结构、调用链、模块职责、注入测试、扩展网盘与分发流程 |

## 安全与边界

- 凭据是本机明文敏感数据（写入尝试使用 0600），不要提交到仓库、放进 ZIP、同步目录或聊天记录。
- 公开分发包不包含任何 SDK 二进制，也不内置下载地址；需要时运行独立脚本 `node urlsdk.mjs status xunlei --sdk` 自行安装。
- 仅用于下载你有权访问和使用的资源。项目不会代替你完成验证码，也不会绕过官方授权。

## 分发

```sh
npm run check                       # 校验白名单、语法与导入边界
npm test                            # 离线回归测试
node scripts/build-portable.mjs ../my-cloud-release   # 生成全新便携目录
```

打包目标必须是全新目录，脚本拒绝覆盖或写入项目自身。发布包不附带 Node.js，也不依赖 ODE-catalog 或其他旧目录。
