# ODE-cloud 使用教程

> 项目介绍见 [README](./README.md)；内部结构与扩展方式见 [开发指南](./DEVELOPMENT.md)。

本文件是全部命令与参数的完整说明。所有用户功能只有一个入口：

```sh
node cli.mjs --help
```

不依赖旁边的软件/游戏查询项目。软件和游戏查询、国内资源线路下载由独立的 ODE-catalog 项目负责，本项目仅管理网盘会话、分享列表和下载。

## 1. 运行条件

- Node.js 22+；无第三方 npm 依赖，不需要 npm install。发布包不附带 Node。
- 官网登录需要本机 Chrome / Edge。默认寻找 Windows 常见安装路径；其他系统或非标准位置请显式指定浏览器可执行文件。
- 在项目目录运行下列命令。文件路径含空格请加引号，Windows 示例使用正斜线。
- Windows 一键准备：右键「使用 PowerShell 运行」`环境安装脚本.ps1`，或执行 `powershell -ExecutionPolicy Bypass -File 环境安装脚本.ps1`。脚本自动检测 Node.js（缺失则先安装官方 LTS 再复检），随后依次运行完整性校验（node scripts/check.mjs）、CLI 冒烟（node cli.mjs --help）与离线回归（node --test "test/*.test.mjs"）；参数 -SkipInstall 跳过安装、-SkipTests 跳过回归测试。
- 登录、校验、分享和下载受官方接口、账号权限、会员、风控和分享有效期限制。仅访问你有权使用的资源，不绕过授权。

## 2. 平台名称与能力

命令中的平台名称必须使用以下英文标识，不接受中文名称或隐式默认平台。

| 网盘 | 平台名称 | 登录 | 官方账号校验 / whoami | 分享列表与下载 |
| --- | --- | --- | --- | --- |
| 迅雷 | xunlei | 官网浏览器；另有 --sms | 支持 | HTTP；可选本地 SDK |
| 夸克 | quark | 官网浏览器 | 支持 | HTTP |
| 123 | pan123 | 官网浏览器 | 支持 | HTTP |
| 天翼 | tianyi | 官网浏览器 | 支持 | HTTP |
| 移动 | yidong | 官网浏览器捕获 authorization | 尚无独立账号校验，verified 为 null | HTTP |
| 百度 | baidu | 官网浏览器 | 支持 | 官方分享递归列表；暂不支持下载（不转存、不解析直链） |
| 115 | 115 | 官网浏览器 | 官方账号接口校验与账号信息 | HTTP |
| UC | uc | 无需登录（游客分享直链） | 不适用（无账号模式） | 游客分享递归列表与直链；31001 需登录 / 23018 游客大小限制 |
| 光鸭 | guangya | 无需登录（公开分享接口尝试） | 不适用（无账号模式） | /userres/v1 匿名列表与直链；207 分享者未开启免登录 |

“支持”表示保留了实现，不代表本次已经用真实账号在线验证。移动暂缺已证实的主动账号请求协议，verified 保持 null；其他平台通过官方接口判断，不会仅凭 Cookie/token 存在就报告成功。

UC、光鸭为游客分享直链，不参与 login/status/whoami，也不保存账号。二者仅在 share/link/get 中按分享链接识别，无需先登录：UC 走官方游客分享接口，受 31001（需登录）与 23018（游客大小限制）约束；光鸭尝试文档化的公开 /userres/v1 匿名接口，若分享者未开启免登录（code 207）则明确失败，此时需在官网登录后下载，程序不会伪造登录或绕过该限制。

## 3. 全部命令速查

以下是全部用户命令。方括号表示可选参数，尖括号表示需要替换的值，不要原样输入括号。

```text
node cli.mjs --help

登入相关：
node cli.mjs <命令> --help
node cli.mjs login <平台> [--browser [浏览器路径]]
node cli.mjs login xunlei --sms <11位手机号>
node cli.mjs logout <平台>
账号相关：
node cli.mjs status <平台> --verify
node cli.mjs status all
node cli.mjs whoami <平台>
下载相关：
node cli.mjs share <官方分享链接或文案>
node cli.mjs link <官方分享链接或文案> [--file "完整路径1,完整路径2"] [--format json|curl|aria2]
node cli.mjs get <官方分享链接或文案> --output <目录> [--file "完整路径1,完整路径2"] [--engine http|sdk] [--workers 1..32] [--chunk MiB]
node cli.mjs direct <HTTP(S)文件直链> --output <目标文件> [--engine http] [--workers 1..32] [--chunk MiB]
```

以上均为唯一命令/参数名称，没有兼容别名。无参数也显示帮助；命令后仅接 --help 可显示帮助，不与其他操作参数混用。

### 3.1 官网浏览器登录

```sh
node cli.mjs login xunlei
node cli.mjs login quark 
node cli.mjs login pan123
node cli.mjs login tianyi
node cli.mjs login yidong
node cli.mjs login baidu
node cli.mjs login 115 --browser "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
```

| 参数 | 行为 |
| --- | --- |
| 平台 | 必填，仅限平台表中的 7 个登录标识（UC、光鸭不提供登录） |
| --browser | 可选；无值时自动寻找浏览器，与不传此参数相同 |
| --browser 路径 | 显式指定 Chrome / Edge 可执行文件；路径不是 profile 目录 |
| --sms 手机号 | 仅迅雷；使用终端短信登录，不能与 --browser 混用 |

浏览器使用独立临时 profile 和 loopback CDP，不读取平时使用的浏览器账号。请自行在官网完成认证；项目不会代填验证码。官网提供扫码等方式时，也可以自行选择。

浏览器登录提示统一为（以迅雷为例）：

```text
请在官方网页完成迅雷云盘手机号/验证码登录；程序会自动检测并保存。若自动检测不到，可输入 yes 回车手动确认（从浏览器 Cookie / localStorage / 跳转 URL 捞取）
已检测到迅雷云盘会话，正在校验官方账号接口…
官方账号校验通过，登录状态已保存在本机<实际凭据文件路径>
```

自动检测不到时，在运行该命令的终端输入 yes 回车触发重新检测。来源依平台已知格式而定：

115 目前读取官方 Cookie，移动读取官方请求中的 authorization；不会猜测它们未知的 localStorage 键或 URL 令牌格式。通用提示列出的三种来源不表示每个平台都支持所有来源。yes 不是“跳过校验”：不能凭空生成会话，不能保存空凭据，不会绕过已实现的官方校验。只读取指定平台官网来源；第三方页面和跳转不会被作为可用凭据来源。

**例外必须如实显示**：移动目前没有独立官方账号校验，提示会明确“未校验/仅保存捕获会话”，结果 **verified 为 null**，不显示“官方账号校验通过”。115 已接入官方账号接口，校验通过才保存新登录。支持校验的平台若验证失败，不保存新会话，也不会打印成功；网络异常可能导致验证失败，不等于账号一定已退出。

登录最后返回统一 JSON，字段与状态一致：platform、saved、verified、capturedAt；账号 Cookie、token 不会打印到成功输出。

### 3.2 迅雷短信登录（唯一保留的特殊登录）

```sh
node cli.mjs login xunlei --sms 13800138000
```

命令发送短信后交互询问验证码（4..8 位数字，终端输入会回显）。校验官方账号身份后才保存新会话；失败不替换已有会话。其他平台不提供 --sms，不接受将密码/验证码放进其他旧登录参数的写法。

### 3.3 账号退出

```sh
node cli.mjs logout xunlei
node cli.mjs logout quark
node cli.mjs logout 115
```

平台必填，**不支持 logout all**。只清除该平台本机保存的会话，不代表在官网注销账号或撤销所有设备授权。

输出含 platform、saved:false、verified:false、capturedAt:null。

### 3.4 单平台与全部平台在线校验

```sh
node cli.mjs status quark --verify
node cli.mjs status xunlei --verify
node cli.mjs status 115 --verify
.......
node cli.mjs status all
```

- status <平台> **必须带 --verify**，否则报错。
- status all 默认逐个平台调用与 status <平台> --verify 相同的官方账号校验逻辑，不再只是读取本机文件；不必也不接收额外 --verify。没有本机会话的行直接返回 saved:false、verified:false。
- 输出为 JSON 数组，单个平台也是长度为 1 的数组。all 的 7 行都有相同字段：

```json
[
  {"platform":"xunlei","saved":true,"verified":true,"capturedAt":"2026-11-09T10:00:00.000Z"},
  {"platform":"quark","saved":false,"verified":false,"capturedAt":null}
]
```

上述仅是字段示例，不是你的实际账号状态。

| 字段 | 意义 |
| --- | --- |
| platform | 英文平台标识 |
| saved | 本机存在可用格式的会话；不代表通过在线验证 |
| verified | true：本次官方账号校验通过；false：无会话或校验未通过；null：该平台尚无独立验证实现（目前仅移动）；不会因为使用 all 而跳过已实现的校验 |
| capturedAt | 会话捕获/登录保存时间，ISO 字符串；没有会话或旧记录未包含时间时为 null，不伪造时间 |

status all 不沿用历史 verified:true，而是本次重新校验；与单平台命令始终使用相同字段、同样的单行 JSON 对象和数组外层。不同时间请求可能因会话过期或网络变化而得到不同值。校验网络失败显示 false，不删除本机会话；单个平台接口异常不会阻止其他平台继续校验。

### 3.5 对应平台的账号信息

```sh
node cli.mjs whoami xunlei
node cli.mjs whoami quark
node cli.mjs whoami pan123
node cli.mjs whoami tianyi
node cli.mjs whoami baidu
node cli.mjs whoami yidong
node cli.mjs whoami 115
```

平台必填；在线校验后返回四个统一状态字段与 account。账号信息扩展到官方响应中实际存在的 ID、用户名、昵称、脱敏联系方式、会员状态/等级/到期时间、容量总量/已用/剩余等白名单字段及受控子对象；不原样倾倒官方响应，不输出 Cookie、token、签名或带敏感参数的 URL。缺失字段不伪造，也不会把会员/容量信息当作登录成功依据。只展示该账号接口真实返回的信息，不代表每个平台都提供全部字段。移动暂缺已证实的主动账号请求协议，仍为 account:null、verified:null；无会话时 account:null、saved:false。

### 3.6 分享列表与完整文件路径

登录平台先登录再列举；UC 与光鸭是游客/公开分享，不需要登录：

```sh
node cli.mjs share "https://pan.baidu.com/share/init?surl=XXXX"
node cli.mjs share "https://drive.uc.cn/s/XXXX"            # UC 游客分享（提取码用 ?pwd=）
node cli.mjs share "https://www.guangyapan.com/s/XXXX"     # 光鸭公开分享（访问码用 ?code= 或 ?pwd=）
```

始终输出 JSON，不需要任何格式参数：

```json
{
  "platform": "baidu",
  "files": [
    { "name": "文件夹名1/文件夹名2/文件夹名3/文件夹名4/真正的文件.zip", "size": "454668917 (433.61 MB)", "sizeBytes": 454668917, "filename": "真正的文件.zip", "directory": "文件夹名1/文件夹名2/文件夹名3/文件夹名4", "extension": ".zip", "type": "file", "id": "12345" },
    { "name": "文件夹名1/说明.txt", "size": "128 (0.00 MB)", "sizeBytes": 128, "filename": "说明.txt", "directory": "文件夹名1", "extension": ".txt", "type": "file" }
  ]
}
```

示例文件只是格式说明，不是对示例分享实际内容的承诺。

**name 使用正斜线分隔，从分享可见根目录起保留各层文件夹名**。不同目录同名文件不会仅凭 basename 匹配。name 与 size 始终是每个文件的前两个字段。size 为“字节数 (可读大小 单位)”字符串：小于 1 GB 使用 MB，否则使用 GB，保留两位小数；这里 1 MB=1048576 字节，1 GB=1073741824 字节。sizeBytes 保留精确数值供脚本计算，未知时 size、sizeBytes 均为 null。filename 是末级文件名，directory 是相对父目录（根目录为空字符串），extension 是小写扩展名（无扩展名为空字符串），type 固定为 file。接口提供时额外列出 id、合法十六进制 md5/sha1/gcid；缺失不伪造。分享顶层还包含 count 和 totalBytes（任一大小未知时为 null）。不输出会话、签名和下载链接。get 会保留相同相对层级到 --output 下。

**只接受支持平台的官方 HTTPS 分享链接或包含链接的分享文案**。访问码直接放在官网链接中（如 ?pwd=nc1i、天翼 accessCode 等平台支持的格式），或使用平台解析器支持的原始“提取码”文案；不再有 --password。百度支持 /share/init?surl=... 和 /s/1...，但**仅支持列出分享文件，不支持下载**（不转存、不解析直链）。遇到验证码、需要重新登录、私密分享、失效链接时明确失败，不破解验证、不猜签名、不返回伪直链。

### 3.7 导出官方下载链接（不下载）

把分享中的文件官方新鲜下载链接导出为 json / curl / aria2 命令，交给外部下载器执行，文件不落本机：

```sh
node cli.mjs link "官方分享链接" --format json
node cli.mjs link "https://drive.uc.cn/s/XXXX?pwd=abcd" --format curl    # UC 游客取链
node cli.mjs link "https://www.guangyapan.com/s/XXXX" --format aria2  # 光鸭公开分享取链
node cli.mjs link "官方分享链接" --format curl
node cli.mjs link "官方分享链接" --format aria2 --file "目录/文件1.zip,目录/文件2.zip"
```

| 参数 | 默认 / 约束 |
| --- | --- |
| 分享链接或文案 | **必填**，只能有一个位置参数，规则同 share/get |
| --file 路径1,路径2 | 可选指定文件，精确匹配 share 的完整 name；规则同 get，不写导出全部 |
| --format json\|curl\|aria2 | 可选，默认 json |

`link` 与 `get` 共用完全相同的官方取链路径与 URL/Header 校验：百度**不支持下载链接**（仅 share 列表），执行会明确拒绝；移动缺少主动协议时无法取链也会如实失败。取链过程不下载文件，因此不接受 --output/--engine/--workers/--chunk。

- `--format json`：输出统一 JSON，形如 `{ "platform", "count", "totalBytes", "links": [{ "name", "size", "url", "headers" }] }`；`name` 与 share 一致保留完整目录层级，`headers` 含该平台下载所需的 Cookie/Referer 等。
- `--format curl` / `--format aria2`：按文件逐行输出纯文本命令；curl 用 `--create-dirs -o "相对路径"` 保留层级，aria2 用 `-d "目录" -o "文件名"`，Header 均用单引号安全包裹，文件名/目录中的单引号已转义。

> 导出的链接与 Cookie 是敏感短时凭据，仅输出到 stdout，不写日志、不进错误文本、不持久化；请勿把输出粘贴到聊天、公开仓库或共享终端。链接会过期，失效后重新运行 link 刷新。

### 3.8 分享下载与唯一参数

```sh
node cli.mjs get "https://pan.xunlei.com/s/你的分享" --output "D:/Downloads" --engine http --file "文件夹名1/文件夹名2/真正的文件2.zip"
node cli.mjs get "官方分享链接" --output "./downloads"
node cli.mjs get "官方分享链接" --output "./downloads" --file "目录/文件1.zip,目录/文件2.zip" --workers 4 --chunk 8
node cli.mjs get "https://drive.uc.cn/s/XXXX?pwd=abcd" --output "D:/Downloads"        # UC 游客下载
node cli.mjs get "https://www.guangyapan.com/s/XXXX" --output "D:/Downloads"   # 光鸭公开分享下载
node cli.mjs get "https://pan.xunlei.com/s/VP5p24kKNhi70haf2_fvl86oA1?pwd=vu6z" --output "D:/Downloads" --engine sdk
```

| 参数 | 默认 / 约束 |
| --- | --- |
| 分享链接或文案 | **必填**，只能有一个位置参数；含空格、&、# 的链接或文案必须整体加引号 |
| --output 路径 | **必填**，get 为目标目录；可用绝对路径或相对于当前命令运行目录的路径；不会默认写入源码目录 |
| --file 路径1,路径2 | 可选指定文件，不写下载全部文件；只能写一次，**精确匹配 share 的完整 name；支持英文或中文逗号分隔**，片段首尾空白裁掉，重复项去重，空片段拒绝；不存在的路径报错而不是下载全部 |
| --engine http 或 sdk | 可选，默认 http；sdk 仅迅雷分享，**必须下载特定组件** |
| --workers 数字 | HTTP 可选，1..32 的整数，默认 8；是单文件 Range 请求并发数，文件仍按顺序下载 |
| --chunk 数字 | HTTP 可选，正整数 MiB，1 MiB=1048576 字节；不写时按文件大小/并发自适应，通常 1–8 MiB |

SDK 自行调度并发与分片，选择 --engine sdk 时不再附加 --workers / --chunk，传入会报错而不是悄悄忽略。HTTP 不支持 Range 的服务可退回单流。始终保留引擎及管线的大小检查；没有跳过检查选项。

--file 是精确文件路径，不是关键词、目录筛选或通配符。路径不得包含 ..、绝对路径、盘符、不安全 Windows 名称等；未知/越界路径拒绝。由于逗号是分隔符，文件名本身包含英文或中文逗号时请不传 --file 下载全部，不能用引号对列表内部做 CSV 转义。输出目录请用可信私有目录，不应预先含有不可信符号链接或其他共享写入者。

## 4. 普通文件直链

```sh
node cli.mjs direct "https://example.com/file.zip" --output "./downloads/file.zip" --workers 4 --chunk 8
```

仅 HTTP(S) 文件直链，不允许嵌入用户名/密码或把网盘分享页当文件。--output 必填并包含文件名，不能是目录；不会附带网盘凭据。可选 --engine http、--workers、--chunk，默认值同 get。不接受 --file 或 sdk。结果 platform 为 direct，其余进度和结果字段与网盘一致。

 **invalid refresh token**

表示官方拒绝当前刷新令牌，无法续期；并非 --output 参数或文件大小问题。可能为会话过期、被撤销，或网页登录令牌的客户端绑定与当前刷新接口不一致，仅凭报错不能区分。执行 `node cli.mjs login xunlei` 重新登录，再运行 `node cli.mjs status xunlei --verify`。若网页重新登录后仍重复出现，可使用已有的 `node cli.mjs login xunlei --sms 你的手机号`；不要将令牌粘贴到聊天或手动修改凭据。程序不会自动删除本机凭据，也不会无限重试刷新；重新登录仍需通过官方账号校验。

## 5. 凭据与环境变量

| 变量 | 作用 |
| --- | --- |
| ODE_CLOUD_HOME | 数据目录，默认用户主目录下 .ode-cloud；建议绝对私有路径 |
| ODE_CLOUD_SDK_DIR | 可选覆盖迅雷 SDK 组件目录，默认项目内 native/win32-x64 |
| ODE_CLOUD_DEBUG | 开启本机错误栈调试；分享日志前去敏 |

```powershell
$env:ODE_CLOUD_HOME = 'D:/Private/ode-cloud-data'
node cli.mjs status all
```

credentials.json 保存迅雷会话与设备信息，adapter-credentials.json 保存夸克/123/天翼/移动/百度，cloud-credentials.json 保存 115。pan123-device-id、tasks/、sdk/ 属于运行状态，不随源码分发。旧会话没有时间时 capturedAt 为 null。源码搬走不会迁移账号，不读取旧原项目或 XLPAN_* 变量。浏览器路径探测可能读取系统 PROGRAMFILES/LOCALAPPDATA，不是账号导入。

凭据是本机明文敏感数据，写入尝试使用 0600；Windows 还需 ACL/磁盘加密保护。不要放进公共/同步目录、仓库、ZIP、聊天或日志。手动 yes 不扩大官网来源或取消校验。临时浏览器与终端结束时清理；profile 若受系统限制未能删除，应按提示处理。

## 6. 私有 SDK：单独脚本按需下载

公开分发包不包含任何 SDK 二进制，也不内置下载 URL。主 CLI、账号及 HTTP 下载逻辑不变，不会自动运行安装器。只有需要 SDK 时，进入解压后的 ODE-cloud 目录执行：

```sh
node urlsdk.mjs status xunlei --sdk
```

按提示粘贴分享 URL,或可直接下载的 HTTPS ZIP URL。脚本会读取官方文件列表、现场生成官方临时下载请求、下载 ZIP、校验并解压；无需寻找或保存会过期的临时直链。仅支持分享中恰好一个 ZIP，不支持目录、多文件、提取码、登录或验证码，不读取任何云盘账号。



默认目标为此脚本旁的 native/win32-x64，不是当前终端目录；设置 ODE_CLOUD_SDK_DIR 时安装到该目录（相对路径以当前终端目录为基准），与主程序现有 SDK 目录规则一致。ZIP 可有外层文件夹；仅安装 download.node 和 xl_thunder_sdk.dll，其他文件不写出，不运行安装脚本或原生代码。<u>ZIP 最大 32 MiB，单个组件最大 16 MiB。拒绝路径穿越、符号链接、加密/分卷/ZIP64 和重复组件。</u>

只有两个组件都匹配安装器内固定的已知 SHA-256 才写入；摘要校验失败不会安装。已有同名文件不覆盖；请先自行备份并移走旧文件。已安装且摘要有效则只报告存在。下载 URL、解析出的直链不保存到项目、配置或日志；交互粘贴仍可能被终端回显或录屏记录。下载失败不会保存 ZIP，临时组件目录在结束时清理。

安装完成后继续使用原来的 --engine sdk。组件仅支持 Windows x64，仍需匹配当前 Node ABI；安装成功不等于能加载、账号可用或能加速。默认 HTTP 不需要 SDK。组件来源及使用、分享授权由提供者负责，摘要不授予第三方再分发许可。旧发布包/历史暂存目录可能仍含 SDK，请勿将旧包作为新的无 SDK 版本分发。

## 7. 错误、测试与独立打包

二次开发请看 [DEVELOPMENT.md](./DEVELOPMENT.md)：包含完整目录树、运行调用链、模块职责、注入测试、网盘扩展与分发步骤。项目仅使用 Node.js 内置模块，不需要 npm install。npm run check 检查分发文件、模块语法与字面量导入边界；npm test 运行离线回归。

- 正常命令退出 0；参数/整体错误退出 1；结果包含失败下载任务退出 2。status 的 verified:false/null 通过 JSON 表示，不应只看退出码判断会话有效。
- 未保存会话先 login <平台>；账号权限、过期分享、验证码或接口变化不通过本项目绕过。
- 离线模拟验证不等于真实账号下载成功。测试覆盖实际 CLI 服务分发、分享解析、凭据边界、HTTP/SDK 调度及大小校验。未执行真实账号登录或原生 SDK 下载。

```sh
node cli.mjs --help
npm run check
npm test
node scripts/build-portable.mjs ../my-cloud-release
# Windows 一键环境准备（检测/安装 Node、完整性校验、冒烟、回归）
powershell -ExecutionPolicy Bypass -File 环境安装脚本.ps1
```

打包目标必须是全新目录，拒绝覆盖或写进项目自身；仅复制源码/文档/测试/独立 SDK 安装脚本，始终排除 native 组件目录及二进制，排除账号、profile、下载文件和运行日志。搬到另一目录后可独立运行和重新打包。发布包不附带 Node.js，也不依赖 ODE-catalog、ode-adapter 或 xunlei-pipeline。
