# Mission 详情页切回 Chat 后滚动位置丢失：分析

- 负责人：开发专家（b2cd7xn16ntzcc0w）
- 时间：2026-08-07
- 状态：已修复，类型检查通过

## 需求与验收标准

目标是在同一 Mission 的详情页中，用户从 `memory` 或 `work` 切回 `chat` 时恢复离开 Chat 前的垂直滚动位置。

建议验收：

1. Chat 列表滚到中间或顶部后切到 `memory`，再切回 `chat`，可见消息和像素位置保持不变。
2. 同样流程对 `work` 成立。
3. 用户位于 Chat 底部时，返回后仍在底部；新消息到达时现有“跟随最新消息”行为不回归。
4. 加载更早历史后的高度补偿、"跳至最新"按钮和切换 Mission 时的初始定位不回归。

## 定位结果

用户描述中的 `apps/web/` 与当前仓库不符：该目录只有健康检查首页，没有 Mission 详情页或 `chat / work / memory` 标签。实际实现位于 Desktop renderer：

- `apps/desktop/src/renderer/src/pages/missions/MissionsPage.tsx`
  - `MissionDetailFragment`：约第 966 行。
  - tab 状态与按钮：第 976、1934–1965 行。
  - Chat 滚动容器：第 1979–1991 行。
  - tab 内容的互斥条件渲染：第 1979、2241 行。
  - 聊天消息变更时的自动定位 effect：第 1835–1857 行。
- `apps/desktop/src/renderer/src/styles.css`
  - `.mission-chat-shell` / `.mission-chat-scroll`：约第 18843–18860 行。

当前 `apps/web` 不是本问题的修改点。若产品确实还有另一套 Web Mission 页面，需要提供对应分支或目录后重新定位。

## 根因与触发链路

这是 **tab 条件渲染导致的滚动 DOM 节点重建，且没有保存/恢复滚动 state**；不是 `MissionDetailFragment` 整体被重新挂载，也不是数据重新加载直接造成的。

1. `tab` 是 `MissionDetailFragment` 内部 state，点击标签仅调用 `setTab(...)`。
2. 当 `tab === "chat"` 时才渲染带 `ref={scrollRef}` 的 `<div className="mission-chat-scroll">`。
3. 切到 `memory` 或 `work` 后，该条件分支为 false，React 卸载该 `<div>`；浏览器持有的 `scrollTop` 因节点销毁而丢失，`scrollRef.current` 变为 `null`。
4. 切回 `chat` 后，React 创建新的 `<div>`，浏览器默认 `scrollTop` 为 `0`，因此直接显示列表顶部。
5. 组件仅维护 `followLatestRef`（第 1050 行），它表示用户是否接近底部，不含离开时的数值位置。`onScroll`（第 1984–1989 行）也只更新这个布尔值。
6. 现有自动滚动 effect 只依赖聊天数据、交互及上下文操作变化，**不依赖 `tab`**。因此仅切回 Chat 时它通常不会执行恢复；若之后有新消息且 `followLatestRef.current` 为 `false`，它仍不会恢复原位置。若离开前在底部，后续数据更新可能把新节点滚到底部，但那是自动跟随，不是位置恢复。

工作页的数据 effect（第 1416–1473 行）和 memory 数据 effect（第 1475 行起）会在切入各自标签时加载/清空相关数据，但它们不是 Chat 位置丢失的根因。

## 修复建议

优先采用“保存数值位置、重新挂载后在 layout effect 恢复”的方案，保持现有按需渲染，避免隐藏状态下保留 chat 复杂子树和输入控件。

1. 在 `MissionDetailFragment` 新增 `chatScrollTopRef`；如果未来同一 Fragment 能复用多个 Mission，应按 `mission.id` 作为 key 保存，或在 Mission id 切换 effect 中清零。
2. 在 Chat 容器的 `onScroll` 中，在现有 near-bottom 判断之外写入 `chatScrollTopRef.current = element.scrollTop`。
3. 为三个 tab click handler 抽出切换函数：从 `chat` 离开前同步读取 `scrollRef.current?.scrollTop`；再调用 `setTab(nextTab)`。不能只依靠 scroll event，因为某些程序化布局变化未必触发最后一次用户滚动事件。
4. 新增 `useLayoutEffect`，在 `tab === "chat"` 且新 Chat 容器已挂载时执行 `element.scrollTop = chatScrollTopRef.current`。使用 layout effect 可在浏览器绘制前完成定位，避免先闪到顶部再跳回原位。
5. 恢复过程中不改写 `followLatestRef`：它仍应由用户最后一次真实滚动的 near-bottom 状态决定。首次进入或切换到新 Mission 时保持现有行为：初值 `0`，由当前自动滚动 effect 按 `followLatestRef` 决定是否置底。

可选替代方案是三个面板始终挂载、通过 `hidden`/CSS 控制显示。它可自然保留 DOM 的 `scrollTop`，但会让 chat、work、memory 的监听、请求和复杂控件同时存活，需额外处理焦点、可访问性、隐藏面板的实时更新与资源消耗；不建议仅为此 bug 采用。

## 测试建议

当前 `MissionsPage.test.tsx` 主要使用 `renderToStaticMarkup`，只能检验静态结构，无法覆盖 DOM 卸载后的 `scrollTop` 恢复。修复时应增加 jsdom/浏览器组件测试：

1. 渲染含足够长 Chat 内容的 `MissionDetailFragment`，设置 `.mission-chat-scroll.scrollTop = 320` 并触发 `scroll`。
2. 点击 `memory`，确认 Chat 容器卸载；再点击 `chat`，断言新容器的 `scrollTop === 320`。
3. 复用相同步骤覆盖 `work -> chat`。
4. 覆盖底部场景与“切回后接收新消息”：在近底部时仍跟随到底部；在非底部时不被错误拉到底部。
5. 覆盖切换 Mission 后不应用上一 Mission 的旧 scroll offset。

## 相关历史

仓库分支 `fix/memory-tab-scroll` 的提交 `aa653588`（2026-08-04）仅修复了 `.mission-memory-activity` 的 CSS 高度/overflow，使 Memory 内容可滚动；它没有改动 Chat tab 的条件渲染或任何滚动位置保存逻辑，不能解决本问题。

## 修复记录

已在 `apps/desktop/src/renderer/src/pages/missions/MissionsPage.tsx` 实现：

1. 新增 `chatScrollTopRef` 保存 Chat 容器的垂直位置，并用 `chatScrollMissionIdRef` 隔离不同 Mission，防止新 Mission 恢复旧位置。
2. Chat 的 `onScroll` 现在同步写入当前 `scrollTop`，原有 `followLatestRef` 的 near-bottom 判断未改变。
3. 三个标签按钮统一通过 `changeTab` 切换；从 Chat 离开时，它在卸载前再次同步保存 DOM 中的 `scrollTop`。
4. 新增 `useLayoutEffect`，当 Chat 容器在当前 Mission 下挂载时，在绘制前恢复保存的位置；首次进入或切换到另一 Mission 的位置为 `0`，维持原有初始行为。

验证：2026-08-07 执行 `pnpm --filter @pragma/desktop typecheck`，`typecheck:node` 与 `typecheck:web` 均通过。
