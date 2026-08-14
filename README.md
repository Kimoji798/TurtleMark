# 🐢 TurtleMark 去水印

一个**全平台**的去水印工具：网页版、iPhone（添加到主屏幕当 App 用）、安卓（可直接下载 APK 安装）。所有处理都在设备本地完成，**图片/视频不会上传到任何服务器**。

## ✨ 功能

| 功能 | 图片 | 视频 | 说明 |
| --- | :---: | :---: | --- |
| ✨ AI 修复 | ✅ | — | 内置 LaMa AI 模型本地推理，先秒出快速修复预览，后台自动替换为 AI 结果 |
| 🟫 马赛克 | ✅ | ✅ | 把水印区域打码遮盖 |
| ✂️ 裁剪 | ✅ | ✅ | 沿最近边缘剪掉含水印的一条，无损清晰 |

- 📷 支持拍照 / 相册导入，JPG、PNG、WebP、MP4、MOV、WebM
- 🔄 前后对比滑块、多步撤销（含处理结果撤销）、画笔大小调节
- 📲 PWA 离线可用，可安装到桌面/主屏幕
- 🔒 100% 本地处理，隐私安全（AI 推理同样在设备内完成，不上传）

## 🚀 一键部署（推荐）

> 已预先在 GitHub 上创建好仓库 `TurtleMark`，只需一次配置。

1. 双击仓库根目录的 **`deploy-to-github.bat`**
2. 首次运行输入仓库地址：`https://github.com/你的用户名/TurtleMark.git`，再输入 Git 昵称和邮箱
3. 推送时会弹出浏览器登录 GitHub（首次会弹出登录窗口，登录一次即可）
4. 完成后打开仓库页面：**Settings → Pages → Build and deployment → Source 选 `GitHub Actions` → Save**
5. 等待 1～2 分钟，网页自动上线：`https://你的用户名.github.io/TurtleMark/`

以后每次改完代码，**双击 `deploy-to-github.bat` 即可一键更新上线**。

## 🍎 iPhone 使用（添加到主屏幕当 App）

1. 用 **Safari** 打开网页地址（其他浏览器也可以，Safari 体验最好）
2. 点底部 **分享按钮** → 向下滑动选择 **「添加到主屏幕」**
3. 主屏幕出现「去水印」图标，点击即可全屏使用，像原生 App 一样

> 网页里也有「📲 安装应用」按钮，点它会给出对应提示。

## 🤖 安卓使用（下载 APK 安装）

**方式一：云端构建 APK（推荐，电脑上无需安装任何开发工具）**

1. 推送代码后，打开仓库 → **Actions** → 左侧 **「构建 Android APK」**
2. 点击右侧 **Run workflow** 按钮 → 等待构建完成（约 3 分钟）
3. 进入构建详情页，在页面底部 **Artifacts** 处下载 `TurtleMark-APK`
4. 把 APK 传到手机安装（需允许「安装未知来源应用」）

> 构建前记得把 `android/app/src/main/res/values/strings.xml` 里的
> `app_url` 改成你的 Pages 地址。

**方式二：浏览器直接安装**

安卓手机用 **Chrome / Edge** 打开网页 → 菜单 → **「安装应用」/「添加到主屏幕」**。

**方式三：本地构建**

用 Android Studio 打开 `android/` 目录，或运行：

```bash
cd android
gradlew assembleDebug    # Windows 用 gradlew.bat
```

产物在 `android/app/build/outputs/apk/debug/`。

## 🖥 本地预览

```bash
# 任选其一
npx serve .
python -m http.server 8080
```

浏览器打开 `http://localhost:8080`。注意：PWA 的「安装/离线」能力需要 HTTPS，本地预览仅用于开发调试。

## 📖 使用说明

**图片去水印**

1. 选择图片或拍照
2. 用「涂抹 / 框选」工具标记水印位置（画笔大小可调，橡皮可擦除，支持撤销）
3. 选择去除方式：✨ AI 修复 / 马赛克 / 裁剪
4. 点「✨ 开始去水印」，拖动滑块对比前后效果
5. 下载或分享结果

**视频去水印**

1. 选择视频或拍摄
2. 拖动虚线框覆盖水印（拖中间移动、拖四角缩放）
3. 选择方式：✂️ 裁剪（快且清晰，沿最近边缘剪掉一条）/ 🟫 马赛克（快）/ ✨ 智能填充（逐帧处理，适合短视频）
4. 点「🎬 开始处理」，等待视频播放完毕（会保留原声）
5. 下载或分享结果

## 🛠 技术实现

- **纯前端**：无服务器、无后端，静态托管即可
- **AI 修复**：内置 LaMa（int8 量化）修复模型 + `onnxruntime-web` WASM 本地推理；先以 Telea 快速修复秒出预览，AI 完成后在原水印区域软边合成替换
- **视频处理**：`canvas.captureStream()` + `MediaRecorder` 逐帧处理并重新编码，音频通过 Web Audio 保留
- **PWA**：Web App Manifest + Service Worker，支持离线与安装
- **安卓 App**：原生 WebView 壳工程，含文件选择、结果保存到系统「下载」目录的桥接
- **CI/CD**：GitHub Actions 自动部署 Pages + 自动构建 APK

## 📁 目录结构

```
├── index.html              # 应用入口
├── app.js                  # 核心逻辑（去水印算法 + 编辑器）
├── styles.css              # 样式（移动端优先深色主题）
├── manifest.webmanifest    # PWA 配置
├── sw.js                   # Service Worker（离线缓存）
├── assets/onnx/            # onnxruntime-web WASM 运行时（AI 推理）
├── assets/model/           # 内置 LaMa 修复模型（约 60MB）
├── icons/                  # 应用图标
├── tools/make-icons.ps1    # 图标生成脚本（可重新生成）
├── android/                # 安卓 App 工程（Android Studio / Gradle）
├── .github/workflows/      # 自动部署 + 自动构建 APK
└── deploy-to-github.bat    # 一键部署脚本（双击运行）
```

## ⚠️ 使用须知

- 请仅对**自己拥有版权或已获授权**的内容进行去水印处理
- AI 修复首次使用需下载约 60MB 模型（之后离线可用），单次修复通常需 1–3 分钟；期间会先显示快速修复结果
- 涂抹/框选尽量贴合水印轮廓，AI 修复效果更好
- iOS Safari 的视频输出为 MP4，安卓 Chrome 输出为 WebM（部分手机相册可能不识别 WebM，可用裁剪/马赛克模式再试或转码）

## ❓ 常见问题

- **AI 修复一直显示加载？** 首次使用需从 GitHub Pages 下载约 60MB 模型，网速较慢时请耐心等待；之后由 Service Worker 缓存，可离线复用。
- **推送提示仓库地址错误？** 删除根目录的 `deploy-config.txt` 后重新双击部署脚本。
- **APK 提示无法安装？** 需要在手机设置里允许当前来源（浏览器/文件管理器）安装应用；首次安装可能还需关闭 Play Protect 的阻止提示。
- **视频处理没有声音？** 少数旧版浏览器不支持录制音频，会降级为无声处理，建议升级 Chrome / Safari。

---

MIT License · 纯本地处理 · 隐私友好