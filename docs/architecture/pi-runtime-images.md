# Pi 图片输入与打包边界

Pragma 使用统一的 `ExpertPromptAttachment` 向 Runtime 交付附件。Pi adapter 按所选模型的
`inputModalities` 将图片转换为 SDK 的 `ImageContent`，通过 `AgentSession.prompt(..., { images })`
输入；附件路径仍保留在通用 prompt context 中。模型读取 workspace 图片时使用 Pi 原生 `read`，
返回文字与图片内容块。Pi SDK 负责图片格式、尺寸限制和供应商协议序列化。

其他 Runtime 同样由各自原生 SDK/CLI 负责多模态输入；没有原生上传接口的 Runtime 使用既有路径
上下文降级。不要为统一工具名另建图片读取工具，也不要把供应商图像处理下沉到 Core 或 Shared。

## Photon 资源

当前 Pi SDK 使用 `@silvia-odwyer/photon-node`，其 CommonJS 入口按 `__dirname` 读取
`photon_rs_bg.wasm`。图片处理需要先加载 Photon，即使原图已经小于尺寸和字节限制。

Desktop Main、随包 CLI 与 npm CLI 将 Photon 保留为外部运行依赖，保持入口和 WASM 相邻；
Desktop 与 npm CLI 显式声明同一版本。不能只将 Photon JavaScript 内联到 ESM bundle。
Pi 的图片 worker 在 bundle 中不可加载时，SDK 使用原生的进程内 fallback；无需增加 Pragma worker
或自定义压缩器。Photon JavaScript 和 WASM 是同一部署单元。

加载失败时，当前 SDK 会返回 `null`，并将附件或 `read` 结果替换成
`[Image omitted: could not be resized below the inline image size limit.]`。该提示不能证明图片真的太大。

## 回归验证

`apps/desktop/scripts/pi-image-bundle.test.mjs` 将真实 Pi SDK 打包并在仓库外运行，只复制 Photon
部署单元，不继承 workspace module 搜索路径。覆盖小于 17 KB 的 PNG、JPEG、2180 像素宽图和
WebP，验证原生 `read` 的图片内容块与 `AgentSession.prompt` 经 OpenAI-compatible 序列化后进入 HTTP 请求的
base64 图片。模型响应由本机 HTTP fixture 提供，图片处理不 mock。测试同时证明旧内联方式会丢弃图片。

Desktop 构建与发行审计从实际 Main、随包 CLI 的入口递归检查生成的模块图，确认 Photon 是外部
运行依赖；npm CLI 审计直接检查 tarball 中的 CLI bundle。独立探针里的正确导入不能替代这些检查。
Desktop 发行资源审计随后在隔离后的实际 ASAR 资源布局中验证小图和宽图的两条输入链路，记录 `piImages`。
这证明图片交付与 SDK 处理可用，不等同于远端模型视觉回答或 Desktop UI 人工验收。

2026-10-13 在 macOS x64、Pi SDK 1.1.0 和 Electron Node 24.18.0 下，用最小真实 ASAR
分别验证了归档内入口与解包后的 CLI 入口。所附 JPEG 截图与 2180×684 的 JPEG 均通过原生
`read`、附件处理和本机 HTTP 请求图片验证；不是完整安装包或线上模型验收。

完整图片集成测试归属 `test:packaging`，由发行门禁执行。`test:core` 只调用轻量的
`test:packaging:contracts` 与原有最小启动断言，不运行图片打包和 HTTP 集成测试。
