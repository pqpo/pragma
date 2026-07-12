# Flows

```ts
const flow = defineFlow({ id: "review", version: "1.0.0" });
const prepare = flow.task({ id: "prepare", version: "1.0.0", handler });
const approve = flow.humanTask({ id: "approve", version: "1.0.0", request });
const expertStep = flow.use("expert", expert);
flow.compose(({ start, end }) => start(prepare).next(expertStep).next(approve).next(end()));
```

`flows.open()` 只读状态并提供观察接口。`flows.recover()` 校验定义后继续未完成节点，成功节点不会重复执行。
