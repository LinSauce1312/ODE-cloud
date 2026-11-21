# ODE-cloud 本地 Web 控制台

这是给现有 ODE-cloud 项目加的本地网页操作界面。启动后由本机 Node.js 服务同时提供页面和接口，浏览器访问 `127.0.0.1` 即可登录网盘、解析分享链接、选择文件、导出直链、下载文件并查看任务进度。

它不是静态演示页，也不会把账号密码或 Cookie 发到浏览器。登录仍然走 ODE-cloud 原有的官方浏览器登录流程，凭据只保存在本机。

---

## 一、功能

- **账号管理**：迅雷、夸克、123 网盘、天翼云盘、移动云盘、百度网盘、115 的登录、状态检查、账号信息查看和退出。
- **两种迅雷登录方式**：打开官方网页窗口扫码/登录，或使用手机号 + 短信验证码。
- **分享解析**：支持网盘分享链接和整段分享文案，自动识别平台、提取码、文件列表、大小和目录结构。
- **文件选择**：全选、取消、单个勾选、按文件名/目录搜索；不单独选择时默认使用全部文件。
- **链接导出**：生成 JSON、cURL、aria2 三种格式，可复制或保存为文件。
- **下载控制**：选择服务器下载目录、HTTP/SDK 引擎、并发数（1–32）、分片大小（1–1024 MiB）。
- **SDK URL 下载**：在偏好设置中点击「下载 SDK」，输入 HTTPS ZIP 直链或小飞机单文件分享地址，服务端调用 `urlsdk.mjs` 下载、校验 SHA-256 后安装到指定目录。
- **打开下载目录**：下载弹窗内可直接在 Windows 资源管理器（或 macOS 访达）中打开当前下载目录。
- **直链下载**：粘贴 HTTP(S) 文件直链，指定服务器目标文件路径后下载。
- **任务面板**：实时查看排队、运行、完成、失败状态，以及进度、速度、文件数、事件和保存路径。
- **偏好设置**：默认下载目录、默认引擎、并发数、分片大小保存在浏览器本地。
- **界面交互**：深色/浅色主题、悬停提示、点击水波纹、Toast 提示、原生对话框、键盘快捷键和响应式布局。

---

## 二、环境要求

- Windows 10/11（当前启动脚本以 Windows 为主）。
- Node.js **22 或更高版本**。
- 浏览器登录需要本机安装 Chrome 或 Edge。
- 不需要执行 `npm install`，本项目没有第三方依赖。

检查 Node.js：

```powershell
node --version
```

---

## 三、启动

### 方式 1：双击 `start.bat`

`start.bat` 只负责用 ASCII 文本转发到 PowerShell，避免中文批处理在 cmd 中乱码。双击后会调用 `start.ps1`，由它启动服务并自动打开浏览器。

### 方式 2：运行 PowerShell 脚本

在 `ui` 目录中打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

也可以右键 `start.ps1`，选择“使用 PowerShell 运行”。

### 方式 3：命令行

```powershell
cd C:\Users\Linjiangzhi\Desktop\REA\ODE-cloud\ui
node .\server.mjs --open
```

默认地址：`http://127.0.0.1:8787/`

如果 8787 被占用，服务会在本机后续端口中自动选择一个可用端口；控制台会打印实际地址。

指定端口：

```powershell
.\start.ps1 --port 8790
```

或：

```powershell
node .\server.mjs --port 8790 --open
```

停止服务：在启动窗口按 `Ctrl+C`。

---

## 四、目录结构

```text
ui/
├─ server.mjs              # 本地 HTTP 服务、API、静态资源、任务管理
├─ start.bat               # ASCII 启动包装器（避免乱码）
├─ start.ps1               # PowerShell 启动脚本
├─ README.md               # 本说明
└─ public/
   ├─ index.html           # 页面结构
   ├─ styles.css           # 深色/浅色主题与全部样式
   ├─ app.js               # 原生 JavaScript 交互逻辑
   └─ favicon.svg          # 站点图标
```

前端没有使用 Vue、React 或构建工具；`app.js` 通过同源 `fetch` 调用本地 API。

---

## 五、使用流程

### 1. 登录账号

进入「账号与平台」，找到对应平台卡片：

- 点击「登录」或「重新登录」；
- 迅雷可选择「官网登录」或「短信验证码」；
- 其他平台会打开官方登录窗口，完成扫码/登录后页面会自动检测；
- 登录成功后，凭据保存在本机 ODE-cloud 的凭据目录中，页面只显示脱敏后的账号信息。

百度网盘只支持查看分享文件列表，不支持转存、直链或下载。

### 2. 解析分享

进入「分享解析」，粘贴分享链接或整段分享文案，点击「解析分享」。也可以在工作台首页的快捷解析框中直接粘贴。

解析成功后：

- 顶部显示平台、文件数量、总大小；
- 文件表默认全选；
- 可搜索、勾选或取消文件；
- 未单独勾选时，导出/下载会使用全部文件。

### 3. 导出直链

点击「导出链接」，选择 JSON、cURL 或 aria2：

- 每次切换格式都会重新向网盘申请新鲜直链；
- 直链包含短期认证信息，请勿公开分享；
- 可复制到剪贴板，或保存为文件。

### 4. 下载

点击「下载所选」：

- 下载目录填写**服务器端**可写的绝对路径；
- HTTP 引擎支持并发和分片；
- 迅雷可以选择 SDK 引擎（仅迅雷分享）；
- 提交后自动跳转到「下载任务」查看进度；
- 同时最多运行 2 个下载任务。

**SDK 组件下载：**

1. 打开「偏好设置」→「迅雷 SDK」→「下载 SDK」；
2. 填写下载地址（HTTPS ZIP 直链，或 `share.feijipan.com/s/...` 无密码单文件分享）；
3. 填写安装目录；目录不存在会自动创建，目标目录已有同名组件时不会覆盖；
4. 服务端下载后校验两个组件的 SHA-256，成功即设为当前 SDK 目录；
5. 回到下载弹窗选择「迅雷 SDK」引擎即可使用。

### 5. 直链下载

点击「直链下载」，粘贴 HTTP(S) 文件地址，填写包含文件名的完整目标路径（例如 `D:\Downloads\file.zip`）。直链下载只使用 HTTP 引擎。

### 6. 任务与设置

- 「下载任务」：查看进度、速度、事件、结果路径和失败原因。
- 「偏好设置」：修改默认下载目录、默认引擎、并发数、分片大小；保存后下载弹窗会自动带入。
- 顶部刷新按钮会同时刷新账号状态和任务列表。

---

## 六、平台支持

| 平台 | 登录 | 解析分享 | 导出直链 | 下载 |
| --- | --- | --- | --- | --- |
| 迅雷 | 官网 / 短信 | 支持 | 支持 | 支持（HTTP / SDK） |
| 夸克 | 官网 | 支持 | 支持 | 支持 |
| 123 网盘 | 官网 | 支持 | 支持 | 支持 |
| 天翼云盘 | 官网 | 支持 | 支持 | 支持 |
| 移动云盘 | 官网 | 支持 | 支持 | 支持 |
| 百度网盘 | 官网 | 支持 | 不支持 | 不支持 |
| 115 | 官网 | 支持 | 支持 | 支持 |
| UC / 光雅 | 免登录 | 支持 | 支持 | 支持 |

实际能力仍受网盘官方策略、分享权限、账号状态和网络环境影响。

---

## 七、配置项

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `ODE_UI_PORT` | 指定服务端口，等价于 `--port` |
| `ODE_UI_DOWNLOAD_DIR` | 指定默认下载目录 |
| `ODE_CLOUD_SDK_DIR` | 指定迅雷 SDK 组件目录；SDK 下载成功后会自动写入本机配置 |

PowerShell 示例：

```powershell
$env:ODE_UI_DOWNLOAD_DIR = 'D:\Downloads\ODE-cloud'
.\start.ps1
```

### 浏览器本地存储

- `ode-theme`：深色/浅色主题。
- `ode-ui-prefs`：默认下载目录、引擎、并发数、分片大小。
- SDK 组件目录保存在本机 `~/.ode-cloud/ui-settings.json`，不写入浏览器。

禁用 localStorage 时页面仍可正常使用，只是偏好不会持久化。

---

## 八、安全说明

- 服务只绑定 `127.0.0.1`，默认不对局域网开放。
- 服务会校验 `Host` 和 `Origin`，只接受本机页面发起的同源请求。
- API 只接受 JSON POST，请求体上限 1.5 MB。
- 前端不会收到账号密码、Cookie 或 Token；账号信息经过白名单和脱敏处理。
- 服务端日志不记录请求体、分享链接或凭据。
- 静态文件服务做了目录穿越防护。
- 导出的直链可能包含短期认证参数，请谨慎保存和转发。
- 请只在可信的本机环境中运行；不要把端口暴露到公网。

---

## 九、常见问题

**双击 `start.bat` 后窗口一闪而过？**

在 `ui` 目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

查看具体错误。多数情况是 Node.js 未安装或版本过低。

**浏览器没有自动打开？**

复制控制台输出的地址，例如 `http://127.0.0.1:8787/`，手动粘贴到浏览器。

**端口被占用？**

```powershell
.\start.ps1 --port 8790
```

**登录窗口没有出现？**

确认本机安装了 Chrome 或 Edge；浏览器登录需要打开独立配置目录的官方登录窗口。

**解析失败？**

确认链接是完整的官方分享链接，且没有过期；部分平台需要先登录才能读取文件列表。

**下载失败？**

检查下载目录是否存在、是否有写权限；百度网盘不支持下载；同时最多 2 个任务。

---

## 十、开发者说明

服务端入口是 `server.mjs`，复用了项目已有的 CLI 模块：

- `createServices()`：登录、账号状态、分享解析、链接、下载。
- `prepareShare()`：校验并识别分享链接。
- `XunleiAuth`：迅雷短信登录。
- `renderExport()`：JSON / cURL / aria2 导出。
- `fileInfo()`：统一文件信息结构。

主要接口：

```text
GET  /api/health
GET  /api/meta
GET  /api/accounts
POST /api/accounts/:platform/logout
POST /api/login/browser
POST /api/login/sms/send
POST /api/login/sms/verify
POST /api/share
POST /api/links
POST /api/download
GET  /api/sdk
POST /api/sdk/install
POST /api/open-folder
POST /api/direct
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/confirm
```

所有接口返回 JSON；失败时为：

```json
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "中文错误说明" } }
```