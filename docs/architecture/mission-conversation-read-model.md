# Mission conversation read model

Mission 会话读取遵循“事实、投影、展示”三层边界，读取路径不得承担修复任务。

## 权威边界

- Core Execution 是执行事实，负责运行、等待、取消与终态。
- Local Host Mission event feed 是 Mission activity 的耐久读取权威。`MissionActivityReader`
  统一解释事件；当事件仍是活动态时，它会有界回查 Core Execution，避免已完成任务继续显示为工作中。
- Desktop Mission 文件保存标题、工作区、执行引用和产品生命周期元数据。它不是执行状态裁决者。
- Desktop conversation projection 是已归档 Execution 的不可变读取来源。Renderer 只消费分页结果、
  控制状态和实时 patch，不从数组到达顺序推断执行生命周期。

```text
Core Execution ──terminal fact──▶ Local Host Mission events
       │                              │
       └──bounded terminal fallback──▶ MissionActivityReader
                                      │
Desktop product metadata ─────────────┴──▶ Desktop UI adapter ──▶ Renderer
```

## 读取规则

1. Chat page、pending/control state、context window 独立读取并独立降级；控制状态失败不得隐藏已读到的消息。
2. 历史分页使用稳定 entry key cursor。旧 byte-offset cursor 只作为升级输入，不能继续定位可替换文件。
3. 加载历史页不推进实时 `revision`；该水位只表示连续应用的 live change sequence。
4. pending interaction 只属于当前 waiting Execution。Execution 进入非 waiting 或终态后立即为空，缓存不得复活它。
5. archived projection 在内存中按当前规则规范化；读取不会重写文件、创建备份或调度 timer。
6. archived projection 仍受明确的条目、字节和字段长度上限约束；省略条目数和截断字段数进入读取协议并在
   UI 展示，禁止把有损归档伪装成完整历史。
7. Renderer 按权威条目顺序合并，且只挂载可视区域附近的会话块。

## 删除的后台修复

以下机制已经删除：

- Mission 列表/详情读取后异步回写终态的 terminal reconciler；
- 读取旧 conversation projection 后异步重排并替换文件的 projection repair；
- pending interaction 的异步重建 timer。

这些任务把读取变成写入，制造了 revision、cursor、通知和文件代次竞态。现在错误通过明确的
`syncIssues` 或 degraded 日志暴露，读取返回同一时刻可证明的数据。

以下不属于后台修复，必须保留：

- command/event/semantic-write journal 的崩溃重放；
- append-only 文件的 torn-tail 恢复；
- 用户明确触发的 orphan recovery / force interrupt；
- terminal Mission event 的同步、有界重试。

它们分别保证原子提交或执行控制，并不在普通读取后偷偷改写业务投影。

## 回归要求

- Core 已终态而 Mission event 或 Desktop 元数据仍为活动态时，列表与详情必须显示终态。
- askUserQuestion 被中断后，pending 立即关闭，刷新和任务切换不得复活。
- history page 与 live patch 交错时，历史 revision 不得吞掉尚未应用的 patch。
- 旧 projection cursor 不得按新文件字节偏移继续读取。
- 单个控制状态读取失败时，可读消息仍然展示。
- 元数据 upsert 不产生未读提醒；只有用户可见内容变化推进提醒边界。
