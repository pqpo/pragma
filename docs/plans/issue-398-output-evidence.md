# Issue #398 输出基准

基线 `1cec48eba13590094c6ac0ddcd61dad3d01598ba`；统一 `RuntimeTokenCounter` 加载本地 `gpt-tokenizer/encoding/o200k_base`，所有计数的 source 必须为 tokenizer。

使用固定事实分别运行基线与当前 presenter；时间、合成 event ID 固定化以便复现。调用数是脚本明确列出的、为获取相同标题/回答/范围事实的路径，不是实际模型 Runtime 成本预测。

| 工作流             | 调用数（前→后） | 字节（前→后） | Token（前→后） | Token 变化 |
| ------------------ | --------------- | ------------- | -------------- | ---------- |
| 找任务 → 看结果    | 3 → 2           | 1433 → 504    | 625 → 202      | -67.7%     |
| 等待 → 回答 → 继续 | 3 → 2           | 1816 → 1022   | 568 → 320      | -43.7%     |
| 大 Board 分段读取  | 3 → 2           | 23631 → 14102 | 6712 → 4080    | -39.2%     |

旧文本列表缺少标题，脚本补一次 JSON list；旧 input_required 文本缺少问题，脚本补一次 JSON result；旧 Board 文本缺少范围，脚本补一次 JSON 首段读取。新输出直接给出这些必要事实。Board 两条路径使用相同 UTF-8 原文，并验证分段重建完全一致。

Cursor：176 → 97 字符，107 → 65 Token，保留完整 256-bit 范围/结果摘要。

续页入口：416 → 147 字节，230 → 77 Token。

同一普通查询 JSONL：1062 → 581 字节，347 → 175 Token。新视图去重；full v2 保留原行为。

复现（先完成 Local Host build）：

```bash
node apps/cli/scripts/issue-398-output-evidence.mjs docs/plans/issue-398-output-evidence.json
```

JSON 包含每个场景的解释与完整数据。执行正确性另由 Host/CLI 业务与真实子进程回归验证；本基准不启动或自动批准任务。
