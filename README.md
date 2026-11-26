# 语音工坊 v2.0

一个 Windows 桌面配音工具：把文字变成语音，支持**预设音色**、**自定义声音描述**、**上传参考音频克隆音色**，还可以在不同模型/接口之间随手切换。

内置两个渠道：

| 渠道 | 说明 | 需要 |
| --- | --- | --- |
| **VoxCPM2 · 自有服务器** | 部署在自己的 GPU 服务器上，48 kHz 输出，免费、无字数计费 | 服务地址 + API Key（已预填） |
| **千问 CosyVoice · 百炼** | 阿里云百炼，一次注册音色反复使用，支持语速/语言 | 百炼 API Key（需自行开通） |

> 声音克隆：上传一段 5–30 秒的干净人声即可，不用先训练。VoxCPM2 侧还能勾选「极致克隆」，把参考音频的原话一起填进去，相似度更高。

---

## 快速开始

### 方式一：直接跑起来（开发模式）

```bat
双击 启动.bat
```

脚本会自动清掉 `ELECTRON_RUN_AS_NODE`（否则 Electron 会退化成纯 Node 运行）、检查依赖，缺 Electron 运行时就用 npmmirror 拉一次。

### 方式二：绿色版（免安装）

```bat
npm run build:portable
```

生成 `dist\语音工坊\语音工坊.exe`，整个目录可以拷到任意 Windows 机器上双击运行，无需安装。

---

## 界面

整个应用只有一个工作页（合成），加上「记录」和「设置」两个辅助页。

### 合成页

1. **音色条**：显示当前音色（预设 / 已保存 / 参考音频），右侧「更换音色」「上传参考音频」。
2. **参考音频区**：拖入或点击上传，上传后显示时长、体积，VoxCPM2 侧还能勾选「极致克隆」并填写参考音频里说的原话。
3. **文本框**：最多 2000 字（VoxCPM2 单次上限），右下角实时显示字数与预计时长。
4. **底部四个按钮**（从左到右）：
   - **模型 / API**：VoxCPM2 自有服务器、VoxCPM2 本机隧道、千问 CosyVoice……随时切换；
   - **音色**：14 个预设 + 我的音色 + 上传参考音频；
   - **声音描述**：用一句话描述音色与语气，例如「年轻女性，声音清冷、略带沙哑，语速偏慢」；预设模式下会作为声音设计指令发给模型；
   - **格式**：WAV 48 kHz / MP3 48 kHz；选千问时还会多出语速与语言。
5. 生成后自动播放，结果卡可「播放 / 下载 / 定位文件」，记录页可随时回放。

### 记录页

按时间倒序列出所有生成记录，支持搜索、播放、下载、定位、删除。音频文件就在数据目录的 `audio\` 下。

### 设置页

- **API 接入**：列表式管理，可添加任意多个 API（VoxCPM2 或千问），填写名称、类型、地址、模型 ID、API Key；「设为当前」决定合成时用哪一个。Key 用系统 safeStorage 加密后保存，界面上只显示前后 4 位。
- **默认参数**：默认音频格式。
- **本地数据**：数据目录、打开目录、清空记录。

---

## 接口与参数

### VoxCPM2（自部署）

地址形如 `http://127.0.0.1:8000`（服务器本机是 `http://127.0.0.1:8000`），鉴权头 `Authorization: Bearer <key>`。

| 场景 | 应用发出的请求 |
| --- | --- |
| 预设音色 / 声音描述 | `POST /v1/tts`，`mode=design`，`control` 为声音描述 |
| 纯文本（无描述无参考） | `POST /v1/tts`，`mode=tts` |
| 上传参考音频 | `POST /v1/references`（multipart），拿到 `reference_id` |
| 已保存音色 / 参考音频 | `POST /v1/tts`，`mode=clone`，带 `reference_id` |
| 极致克隆 | `mode=hifi`，额外带 `prompt_text`（参考音频原话） |

完整字段、流式与错误码见 [`docs/VoxCPM2远程接口.md`](docs/VoxCPM2远程接口.md)。

### 千问 CosyVoice（百炼）

- 注册音色：`POST {base}/services/audio/tts/customization`，`action=create_voice`，轮询 `query_voice` 直到 `status=OK`。
- 合成：`POST {base}/services/audio/tts/SpeechSynthesizer`，返回 24 小时有效的音频 URL 再下载。
- 注册音色与合成必须用**同一个模型 ID**（默认 `cosyvoice-v3.5-plus`）。

---

## 环境与排错

- 需要 Windows 10/11，Node 20+（仅打包/开发时需要，绿色版不需要）。
- **`ELECTRON_RUN_AS_NODE`**：如果启动报 `Cannot read properties of undefined (reading 'whenReady')`，说明这个环境变量被继承了，`启动.bat` 已自动清理。
- **Electron 运行时缺失**（`node_modules\electron\dist` 不存在）：

  ```powershell
  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
  node node_modules/electron/install.js
  ```

- **本机被代理/Clash 劫持域名**：如果访问 `127.0.0.1:8000` 报连接失败或空响应，双击 [`启动VoxCPM隧道.bat`](启动VoxCPM隧道.bat) 建立 SSH 隧道，然后在应用里把 API 切换成「VoxCPM2 · 本机隧道」（`http://127.0.0.1:8000`）。
- **首次生成较慢**：VoxCPM2 服务端预热/加载约 10 秒，之后单句通常 1–3 秒。

---

## 项目结构

```
main.js                 Electron 主进程：窗口、IPC、生成调度、旧数据迁移
preload.js              contextBridge 暴露 window.dsh
lib/voxcpm.js           VoxCPM2 HTTP 客户端（health / tts / references）
lib/cosyvoice.js        百炼 CosyVoice 客户端（音色注册 + 合成）
lib/store.js            设置、服务商、音色库、历史记录（safeStorage 加密 Key）
renderer/index.html     页面骨架
renderer/styles.css     紫白主题样式
renderer/app.js         全部界面逻辑
renderer/presets.js     14 个预设音色、格式、语言
test/voxcpm.test.js     VoxCPM2 客户端单测（11 项）
test/cosyvoice.test.js  CosyVoice 客户端单测（8 项）
test/clone-mock.js      本地 mock 服务，模拟百炼接口
tools/build-portable.ps1  绿色版打包
docs/                   接口文档与截图
```

## 开发命令

```bat
npm start              启动应用
npm run dev            启动并打开 DevTools
npm test               跑单元测试（19 项，全部离线）
npm run mock:clone     起本地 mock 服务（7788 端口）
npm run build:portable 生成绿色版
```

截图自检（无头截图，用于改完样式后快速核对）：

```bat
node_modules\electron\dist\electron.exe . --shot shot.png --shot-view settings
```

`--shot-view` 支持 `compose / history / settings`，`--shot-scene` 支持 `provider / voice / control / speed / format / generate / play`。

## 已知限制

- 千问渠道需要自行开通百炼「声音复刻 / CosyVoice」并填入 Key；两套 Key 不通用。
- VoxCPM2 单次文本上限 2000 字，长文请分段。
- 参考音频建议 5–30 秒、尽量干净；超 25 MB 会被拒绝。
- 「声音描述」只在**预设音色**模式下生效；选了参考音频或已保存音色时，音色由参考音频决定。
- 生成是串行的：同一时间只跑一个任务，切换任务前请等上一个结束或点取消。
