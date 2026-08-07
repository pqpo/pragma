# Mission Chat 滚动位置记忆：测试报告

- 负责人：测试专家（r7edb5krrayh1r5j）
- 时间：2026-08-07 22:38 +0800
- 范围：`apps/desktop/src/renderer/src/pages/missions/MissionsPage.tsx` 的 Chat / Work / Memory 标签切换，以及 Mission 切换、首次进入和新消息跟随语义。
- 结论：**静态实现审查通过；自动化回归通过；六项 DOM/手动验收未能在当前环境完成，交付状态为待补 UI 验证。**

## 验收标准

1. Chat 从中间位置切至 Memory 或 Work 后，返回 Chat 恢复离开时的位置。
2. Chat 在底部时切换回来仍在底部。
3. 非底部返回 Chat 后接收新消息，不得被错误滚至底部。
4. 切换 Mission 不得把前一 Mission 的位置带到后一 Mission；首次进入不得使用其他 Mission 的旧值。

## 执行结果

| 场景 | 优先级 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1. Chat → Memory → Chat，中间位置 | P0 | 静态通过，UI 待验证 | `changeTab` 在卸载前保存 `scrollTop`；`useLayoutEffect` 在 Chat DOM 重建后恢复该值。 |
| 2. Chat → Work → Chat，中间位置 | P0 | 静态通过，UI 待验证 | Work 与 Memory 共用同一 `changeTab`，返回 Chat 使用同一恢复 effect。 |
| 3. 底部位置 | P0 | 静态通过，UI 待验证 | 离开前保存实际 `scrollTop`，返回时同步恢复；未改变原近底判断。 |
| 4. 非底部时新消息 | P0 | 静态通过，UI 待验证 | 恢复 effect 不写入 `followLatestRef`；非底部滚动事件已将其置为 `false`，原消息更新 effect 因此不执行置底。隐藏 Chat 时 `scrollRef` 为 `null`，返回时由 layout effect 恢复保存值。 |
| 5. Mission A/B 切换隔离 | P0 | 静态通过，UI 待验证 | `chatScrollMissionIdRef` 发现 `mission.id` 改变即将保存值置 `0`，不会把 A 的偏移用于 B（或从 B 带回 A）。 |
| 6. 首次进入 | P1 | 静态通过，UI 待验证 | ref 初始值为 `0`；首次 Chat 挂载时不会读取其他 Mission 的位置，既有 `followLatestRef` 初始语义仍可将初始列表置底。 |

## 自动化与静态检查

均通过：

- `pnpm --filter @pragma/desktop exec vitest run src/renderer/src/pages/missions/MissionsPage.test.tsx --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile <temp>`：11 个套件、42 个断言，全部通过。
- `pnpm --filter @pragma/desktop typecheck:web`：通过。
- `pnpm --filter @pragma/desktop exec eslint src/renderer/src/pages/missions/MissionsPage.tsx src/renderer/src/pages/missions/MissionsPage.test.tsx`：通过。
- `git diff --check -- apps/desktop/src/renderer/src/pages/missions/MissionsPage.tsx`：通过。

## 单元测试审查与缺口

现有 `MissionsPage.test.tsx` 使用 `renderToStaticMarkup`，Vitest 配置未设置浏览器环境；当前依赖未安装 `jsdom` 或 `happy-dom`。该模式不会执行 `useLayoutEffect`，也无法设置、触发或断言元素的 `scrollTop`，因此上述 42 个通过断言**不能覆盖本修复的六个交互场景**。

缺口（P0）：开发专家应在引入可用 DOM 测试环境后补充组件测试，至少覆盖：

1. Chat → Memory / Work → Chat 恢复中间 `scrollTop`；
2. 底部恢复；
3. 非底部切换后的新消息不置底；
4. 复用组件并更换 `mission.id` 时重置，不串用旧偏移；
5. 首次进入不复用旧 Mission 值。

## 手动 UI 验证阻塞

按要求尝试连接本地浏览器/桌面 UI 自动化通道，返回 `No browser is available`；当前环境也没有可操作的 Electron 窗口或预置 Mission 数据。因此未能执行真实 DOM 滚动和像素位置的手动验证，未把静态审查误报为 UI 通过。

## 缺陷跟踪

- 未发现可复现的功能缺陷。
- **测试缺陷 / 回归覆盖缺口（P0）**：没有 DOM 级自动化用例，真实滚动恢复仍需在可运行的 Desktop 环境完成一次六场景手测或补齐组件测试后关闭。
