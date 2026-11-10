# ODE-cloud 开发指南

本项目是独立的 Node.js 网盘命令行项目，不提供 UI，不依赖软件/游戏查询项目或旧项目目录。面向使用者的完整命令教程见 [USAGE](USAGE.md)，项目介绍见 [README](README.md)，本文件说明开发结构、扩展方式及验证边界。

## 1. 环境与快速运行

- Node.js **22 或更高版本**，使用原生 ESM、fetch、WebSocket 和 node:test。
- HTTP 功能只使用 Node 内置模块，无第三方运行依赖，不需要先执行 npm install。
- 浏览器登录需要本机 Chrome 或 Edge；可通过 --browser 指定完整可执行文件路径。浏览器使用隔离的临时 profile，不导入用户日常浏览器账号。
- 可选迅雷 SDK 仅支持 Windows x64，而且原生组件必须匹配当前 Node ABI；Node 版本满足最低要求不代表原生组件一定可以加载。

在项目根目录执行：

~~~sh
node --version
node cli.mjs --help
node cli.mjs status all
node cli.mjs login quark
node cli.mjs login xunlei --sms 13800138000
~~~

status all 会在线核验已有会话；无凭据时不应猜测账号已登录。涉及真实账号、短信发送或下载的命令应由持有账号权限的人显式执行，不是离线测试步骤。

## 2. 最终目录结构

下面列出公开项目文件；运行状态和私有 SDK 不属于源码分发树。

~~~text
ODE-cloud/
├── .editorconfig
├── .gitignore
├── README.md
├── USAGE.md
├── DEVELOPMENT.md
├── package.json
├── cli.mjs
├── urlsdk.mjs
├── scripts/
│   ├── check.mjs
│   └── build-portable.mjs
├── src/
│   ├── cli-args.mjs
│   ├── cli-runtime.mjs
│   ├── cloud-login.mjs
│   ├── baidu-share.mjs
│   ├── pan123-share.mjs
│   ├── tianyi-share.mjs
│   └── yidong-share.mjs
├── lib/
│   ├── paths.mjs
│   ├── config.mjs
│   ├── auth.mjs
│   ├── web-login.mjs
│   ├── browser-login.mjs
│   ├── game-share.mjs
│   ├── quark.mjs
│   ├── pan115.mjs
│   ├── pipeline.mjs
│   ├── cloud-pipeline.mjs
│   ├── engine.mjs
│   ├── sdk-engine.mjs
│   └── download-progress.mjs
└── test/
    ├── account-commands.test.mjs
    ├── baidu-share.test.mjs
    ├── browser-login.test.mjs
    ├── cloud-adapter.test.mjs
    ├── cloud-pipeline.test.mjs
    ├── download-progress.test.mjs
    ├── engine-fault.test.mjs
    ├── game-share.test.mjs
    ├── pan115.test.mjs
    ├── pan123-share.test.mjs
    ├── quark.test.mjs
    ├── sdk-engine.test.mjs
    ├── standalone.test.mjs
    ├── tianyi-share.test.mjs
    ├── unified-cli.test.mjs
    ├── urlsdk.test.mjs
    ├── web-login.test.mjs
    └── yidong-share.test.mjs
~~~

旧的 cli-options、cloud-download、share、integrity 模块不再是此目录结构的一部分；不要恢复第二套参数解析或旧账号密码登录入口。

## 3. 请求与输出流程

~~~text
cli.mjs run(argv)
  └─ parseArgs(argv)                  严格参数契约，拒绝旧参数及别名
      └─ createServices(overrides)    组装默认实现或测试替身
          ├─ login / logout / status / whoami
          │   └─ 浏览器或迅雷 SMS → 官方账号检查 → 本地凭据
          └─ share / get / direct
              └─ prepareShare → 平台适配器列举文件、临时取链
                  └─ pipeline / cloud-pipeline / runtime 顺序编排
                      ├─ HTTP engine：Range 并发或单流
                      └─ SDK engine：仅迅雷，可选原生组件
                          └─ download-progress → stderr 进度
                              cli.mjs → stdout JSON 结果
~~~

多个文件按顺序下载；workers 控制单个文件的 HTTP 分片请求并发，不是同时下载多少个文件。默认 HTTP；不能把网页 URL 当作文件直链交给 direct。

- [cli.mjs](cli.mjs)：唯一主 CLI 入口、统一帮助、结果 JSON、退出码及进度渲染器生命周期。
- [cli-args.mjs](src/cli-args.mjs)：命令 schema、平台集合、必填参数、参数冲突、output 绝对路径以及 MiB 到字节转换。
- [cli-runtime.mjs](src/cli-runtime.mjs)：服务组装、账号分派、分享平台识别、精确路径筛选、HTTP 与各管线的衔接。
- [cloud-login.mjs](src/cloud-login.mjs)：百度/天翼/123/夸克/移动官网浏览器捕获、adapter 凭据存储、账号官方检查与安全信息投影。
- [web-login.mjs](lib/web-login.mjs)：迅雷官网会话捕获，验证候选 token 后再保存。
- [browser-login.mjs](lib/browser-login.mjs)：115 浏览器 Cookie 登录及凭据存储；同时保留夸克凭据的过滤/读取/退出桥接。不要因为夸克网页登录走另一模块就删除整个文件。
- [auth.mjs](lib/auth.mjs)：迅雷会话、SMS、验证码令牌、refresh、鉴权请求与退出，不再提供账号密码登录。
- [game-share.mjs](lib/game-share.mjs)：迅雷分享列表、取链与共享安全路径校验。
- [quark.mjs](lib/quark.mjs)、[pan115.mjs](lib/pan115.mjs) 及 [src 中的平台模块](src/)：官网分享解析、分页、目录遍历、平台短期下载请求（百度仅列表，不提供下载）。
- [pipeline.mjs](lib/pipeline.mjs)：迅雷 HTTP/SDK 顺序文件编排；[cloud-pipeline.mjs](lib/cloud-pipeline.mjs)：夸克/115 HTTP 编排。
- [engine.mjs](lib/engine.mjs)：通用 HTTP 传输与断点；[sdk-engine.mjs](lib/sdk-engine.mjs)：按需加载原生组件，不负责安装组件。
- [download-progress.mjs](lib/download-progress.mjs)：统一文件元数据、生命周期事件、节流动态行及控制字符过滤。
- [paths.mjs](lib/paths.mjs)、[config.mjs](lib/config.mjs)：项目独立数据目录、协议常量和运行配置，不从旧项目导入凭据。

## 4. 可测试的真实注入点

默认服务没有全局依赖注入容器；通过 createServices 的 overrides 替换实际声明的依赖。不要虚构 passwordLogin、browserFactory 或未实现的 CLI 开关。

下面示例只模拟 direct 传输和进度，不访问网络、不创建下载文件：

~~~js
import { run } from './cli.mjs';
import { createServices } from './src/cli-runtime.mjs';

const services = createServices({
  stat: async () => null,
  downloadHttp: async ({ dest, onProgress }) => {
    onProgress?.({ received: 3, total: 3, speed: 0, final: true });
    return { size: 3, path: dest };
  },
});
const events = [];
await run(['direct', 'https://example.com/file.bin', '--output', './output/file.bin'], {
  services,
  output: text => process.stdout.write(text + '\n'),
  onProgress: event => events.push(event),
});
~~~

其他已存在的服务注入点包括 authLoader、loginXunleiWithBrowser、loginWithBrowser、loginCloud、inspectCloudAccount、loadCloudCredential、loadCloudCredentialRecord、clearCredential、clearCloudCredential、terminalFactory、cloudClient、xunleiShareFactory、各 open*Share、runPipeline 与 runCloudPipeline。替换真实账号服务时连凭据读取和保存路径一起考虑，不能只 mock fetch 却仍写入真实账号目录。

底层平台 open*Share / client 中有 fetchImpl 注入；以对应模块真实签名为准。[pipeline.mjs](lib/pipeline.mjs) 支持 share、httpDownloader、sdkDownloader 注入；[sdk-engine.mjs](lib/sdk-engine.mjs) 支持 addon 和 sdkDataDir 注入，原生测试应使用假的 addon，不 require 私有组件。[urlsdk.mjs](urlsdk.mjs) 支持 fetchImpl、directory 和用于测试的 hashes；生产安装必须使用默认已知摘要，不用远端提供的摘要覆盖信任根。

## 5. 账号与分享数据契约

### 账号

当前平台为 xunlei、quark、pan123、tianyi、yidong、baidu、115。login 默认官网浏览器，仅迅雷另有 --sms；不接受 --account、--password、旧密码环境变量或其他登录别名。

账号状态统一为：

~~~json
{"platform":"quark","saved":true,"verified":true,"capturedAt":"2026-11-09T00:00:00.000Z"}
~~~

- saved 只表示本地存在所需会话字段，不能代替在线验证。
- verified 为 true / false / null：通过、失败、尚无可用官方核验能力；没有会话时为 false。
- capturedAt 是保存会话时的 ISO 时间；旧会话可能为 null。
- status <平台> 必须 --verify；status all 默认逐平台在线核验；whoami 使用同一检查路径并追加 account。
- 移动当前可捕获官网 authorization，但缺少可确认的官方账号核验协议，所以 verified 必须为 null，不能伪装为 true。
- account 仅允许已投影的身份、掩码联系方式及有限账号元数据，不能直接返回官方原始响应、Cookie、token、密码或签名链接。

默认数据目录由 [paths.mjs](lib/paths.mjs) 定义：ODE_CLOUD_HOME 或用户主目录下 .ode-cloud。迅雷为 credentials.json；adapter-credentials.json 保存夸克/123/天翼/移动/百度；cloud-credentials.json 保存 115。不要随源码或 ZIP 分发这些文件。

### 分享与下载

prepareShare 返回 platform、raw、url；它不是密码输入界面。提取码只从链接或分享文案读入，字段名 password 在平台分享对象中表示分享访问码，不能因删除账号密码功能而一并删除。

适配器内部文件至少应具备完整相对 name、size 以及平台取链需要的 id 等字段。目录层级使用 /，不得在输出阶段只保留 basename。CLI 文件投影由 fileInfo 统一产生 name、size、sizeBytes、filename、directory、extension、type，有限保留 id 与格式有效的散列。

get --file 逐项匹配完整相对路径，不使用模糊扩展名过滤。分享目录和目标路径都必须通过 safeSharePath；绝对路径、..、控制字符及跨目录写入需要拒绝。短期直链由适配器现场获取，不能把分享列表中的长期计划和短期签名混为一体。百度仅支持 share 列出分享文件，get/download 直接拒绝（不转存、不解析直链），在 cli-runtime.mjs download() 入口判断 platform==='baidu' 提前抛错。

最终下载 JSON 包含 platform、engine、output、count、totalBytes、results；单文件 status 为 done / exists / failed。stdout 保持结果 JSON，stderr 负责进度；未知大小为 null，不伪报 0。命令整体错误退出 1，下载结果含失败退出 2，正常退出 0；账号 verified:false/null 应通过 JSON 判断，不能只看退出码。

## 6. HTTP 断点状态与 SDK 边界

[engine.mjs](lib/engine.mjs) 先用 HEAD 和真实 Range 探测确认范围能力，不能只相信 Accept-Ranges 字段。Range 不支持或服务端忽略 Range 时回退单流。

HTTP 下载在目标文件旁写临时文件：

~~~text
目标文件.part
目标文件.part.json
目标文件.part.json.tmp
~~~

断点 JSON 包含 size、chunkSize、etag、chunks；分片有 start、end、done，完成后记录 sha256。恢复时验证大小、分片覆盖范围、分片大小与可用 ETag，一并重算已完成片的 SHA-256；损坏片回到未完成状态。状态采用临时文件更新，完整传输及大小检查后才将 .part 改名成最终文件，再清理状态。单流兜底不承诺复用 Range 分片状态。改变 chunk 或远端文件版本可能导致重新规划，不能承诺沿用所有旧分片。

默认 workers=8（1..32），未指定 chunk 时按文件和并发自适应，通常 1..8 MiB；显式 --chunk 的单位为 MiB，内层 chunkSize 为字节。分片少于并发时引擎可进一步缩小片长。不要删除长度、Content-Range、版本或完成检查来“提速”。

独立 [urlsdk.mjs](urlsdk.mjs) 仅在用户主动执行时下载小飞机无密码公开单 ZIP 分享或 HTTPS ZIP；不被主 CLI 自动运行。只安装摘要匹配的 download.node 与 xl_thunder_sdk.dll，不覆盖现存同名文件，不执行下载代码或原生组件，不把私人分享 URL 写进项目。

默认组件目录是脚本旁 native/win32-x64，可用 ODE_CLOUD_SDK_DIR 指定。SDK 运行状态目录位于账号数据目录的 sdk 下。安装验证通过不代表 ABI 匹配、官方账号可用或能加速；发布包始终不含 SDK 二进制。--engine sdk 仅迅雷分享可用，并拒绝 --workers/--chunk，SDK 自行调度。

## 7. 新增平台或参数

新增网盘按以下顺序实现，不要复制第二套 CLI：

1. 在 [cli-args.mjs](src/cli-args.mjs) 平台集合、[cli-runtime.mjs](src/cli-runtime.mjs) 官方域名映射和分派中明确登记。
2. 在平台模块实现严格官方分享 URL 解析、提取码、分页/递归上限和文件信息；按需提供 open*Share、client 与新鲜取链。
3. 为官网浏览器捕获、凭据必需字段、本地存储和 logout/status/whoami 绑定同一平台身份；只有有证据的官方账号检查才设置 verified:true，未知保持 null。
4. 限定 Cookie/token 来源和发送目标，处理 HTTP 重定向及 CDN 的请求头隔离，不把账号长期凭据默认发送到下载域名。
5. 使用统一进度/文件投影；补充失败、空目录、重复分页、越界路径、失效会话和短链刷新测试。
6. 更新 [使用教程](USAGE.md)、[README](README.md)、本指南、[公开文件白名单](scripts/build-portable.mjs) 和对应测试，验证迁移目录后的独立运行。

新增参数必须同时更新 schema、parseArgs 校验、运行时传递、帮助及文档；写明单位、默认值、范围、冲突和适用引擎。未知/重复参数应在访问服务之前拒绝。不要新增只展示但不实际传到引擎的“空参数”，也不要恢复旧密码/别名兼容层。

## 8. 检查、测试、打包

在项目根目录运行：

~~~sh
npm run check
npm test
npm run build -- ../ode-cloud-portable-new
~~~

check 用于静态项目检查，test 使用标准 node --test，build 复制公开白名单文件到全新目录。也可以直接运行：

~~~sh
node scripts/check.mjs
node --test test/account-commands.test.mjs test/pan123-share.test.mjs
node scripts/build-portable.mjs ../ode-cloud-portable-new
~~~

打包目标必须不存在，且不能是项目自身或项目内部；需要重打包时换新目录，不用覆盖失败来掩盖残留。打包器拒绝符号链接并仅复制声明的普通文件；新增源模块、测试或文档后必须更新白名单。

发布前至少核对：静态检查、针对性测试、全量标准测试、公开包无凭据/SDK/下载残留、解压后 CLI 帮助、测试及重打包。不要将 .gitignore 当成打包安全边界，实际分发依据白名单；不要直接压缩整个工作目录。

测试通常使用假的 fetch/账号/浏览器入口/下载器，不能证明真实官网登录或实际账号下载成功。若宿主报 Error: spawn EPERM 等错误，记录受阻命令和环境，不改测试隔离模式规避限制，也不写“全部通过”。本指南不声明最终通过数，以实际执行记录为准。

## 9. 安全和维护准则

- 账号只在用户授权范围使用；不绕过验证码、付费权限、分享访问限制或官方风控。
- 浏览器只捕获明确官网来源；人工 yes 只触发重扫，不能跳过账号核验或扩大 Cookie/localStorage 来源。
- 浏览器 temporary profile、CDP 会话、终端与子进程必须在 finally 清理；验证失败不能覆盖原有有效账号。
- 分享网页、官方 API 字段、远端错误和下载组件都当作外部数据，不执行网页脚本来获得解析结果；不要使用 eval 处理目标内容。
- 账号字段和私有签名 URL 不写入公共日志、截图、README、测试 fixture、错误全文或发布清单；测试使用虚构账号和链接。
- ODE_CLOUD_HOME、下载目标、native 私有目录、profile、tasks、sdk、断点文件及日志都应排除出版本和发布包。
- 不能删除分享访问码处理、URL 嵌入凭据拒绝检查或官方 API 签名，只因为它们名称中出现 password、auth 或 sign。
- 保留当前七平台浏览器与迅雷 SMS 的回归保护；删除旧代码前先列真实生产调用及测试调用，避免把不同用途的重复 helper 当成死代码。
