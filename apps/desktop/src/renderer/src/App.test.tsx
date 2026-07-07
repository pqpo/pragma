import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.tsx";

describe("App", () => {
  it("renders agent plaza as the default view", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Agent 广场");
    expect(html).toContain("需求分析调度官");
    expect(html).toContain("创建 Agent");
  });

  it("renders the model management view when selected", () => {
    const html = renderToStaticMarkup(<App initialView="models" />);

    expect(html).toContain("模型管理");
    expect(html).toContain("Provider");
    expect(html).toContain("gpt-4.1-coder");
  });

  it("renders workflow node details for the selected node", () => {
    const html = renderToStaticMarkup(<App initialView="workflows" initialSelectedWorkflowNodeId="review-node" />);

    expect(html).toContain("工作流编排");
    expect(html).toContain("human.review");
    expect(html).toContain("必须人工确认后继续");
  });

  it("renders task board detail with human intervention state", () => {
    const html = renderToStaticMarkup(<App initialView="tasks" initialSelectedTaskId="task-waiting-1" />);

    expect(html).toContain("任务看板");
    expect(html).toContain("支付链路技术方案审阅");
    expect(html).toContain("人工接入");
    expect(html).toContain("触发人工节点");
  });

  it("renders the active drawer content for the current workflow action", () => {
    const html = renderToStaticMarkup(<App initialDrawerKind="create-workflow" />);

    expect(html).toContain("新建工作流");
    expect(html).toContain("可视化画布 Playbook");
  });
});
