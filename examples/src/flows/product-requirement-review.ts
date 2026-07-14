import {
  defineExpertTeam,
  defineContextIdResolver,
  defineFlow,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type HumanInteractionResponse,
} from "@pragma/core";
import { z } from "zod";

import { FlowConsoleTui } from "../console/flow-console-tui.ts";
import { createExampleApp, createExampleExpert } from "../support/example-kit.ts";

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  throw new Error("The Flow TUI example requires an interactive TTY terminal.");
}

const RequirementSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  problem: z.string().min(1),
  targetUsers: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).min(1),
  requestedLaunchDate: z.string().date(),
  riskTolerance: z.enum(["low", "medium", "high"]),
});

const NormalizedRequirementSchema = RequirementSchema.extend({
  reviewFocus: z.array(z.string().min(1)),
  summary: z.string().min(1),
});

const RevisionRequestSchema = z.object({
  cycle: z.number().int().positive(),
  requestedChanges: z.string().min(1),
  previousTeamReview: z.string(),
});

const ReviewOutcomeSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  requirement: NormalizedRequirementSchema,
  productAnalysis: z.string(),
  teamReview: z.string(),
  humanDecision: z.object({
    decision: z.string(),
    notes: z.string().optional(),
  }),
  nextActions: z.array(z.string()),
});

type Requirement = z.infer<typeof RequirementSchema>;
type NormalizedRequirement = z.infer<typeof NormalizedRequirementSchema>;
type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

const evidenceByArea = {
  user_value: {
    finding: "7/10 pilot users lose context when comparing two long-running Executions.",
    metric: "Median manual comparison time is 18 minutes.",
    caveat: "Evidence is from 14 internal pilot sessions, not production telemetry.",
  },
  architecture: {
    finding: "Canonical Execution events already have stable executionId + sequence cursors.",
    metric: "A comparison view can be projected without introducing a second event store.",
    caveat: "Runtime token deltas are live-only, so replay must use persisted Agent messages.",
  },
  delivery: {
    finding: "Read-only replay can ship independently from saved comparison annotations.",
    metric: "A staged MVP avoids schema migration and write-path risk.",
    caveat: "Large Execution histories need pagination and output-size safeguards.",
  },
} as const;

const lookupRequirementEvidence: ExpertAgentManagedTool<
  "lookup_requirement_evidence",
  ExpertAgentToolCallResult
> = {
  name: "lookup_requirement_evidence",
  description:
    "Look up deterministic product, architecture, or delivery evidence for the requirement review.",
  inputSchema: {
    type: "object",
    properties: {
      area: { type: "string", enum: ["user_value", "architecture", "delivery"] },
    },
    required: ["area"],
    additionalProperties: false,
  },
  async call(input) {
    const area =
      typeof input === "object" && input !== null && "area" in input ? String(input.area) : "";
    if (!(area in evidenceByArea)) {
      return { text: `Unknown evidence area: ${area}`, isError: true };
    }
    const evidence = evidenceByArea[area as keyof typeof evidenceByArea];
    return { text: JSON.stringify(evidence), details: { area, evidence } };
  },
};

const productStrategist = await createExampleExpert(
  "product-strategist",
  [
    "You are the Product Strategist for a structured requirement review.",
    "Answer in Chinese and produce a concise product analysis with user value, scope, success metrics, and risks.",
    "You must call lookup_requirement_evidence with area=user_value before drawing conclusions.",
    "Distinguish supplied evidence from your recommendations and do not invent additional research results.",
  ].join("\n"),
  {
    name: "Product Strategist",
    description: "Turns a normalized requirement into an evidence-backed product proposal.",
    tools: [lookupRequirementEvidence],
  },
);

const reviewLead = await createExampleExpert(
  "solution-review-lead",
  [
    "You coordinate a cross-functional solution review and own the final team recommendation.",
    "Answer in Chinese.",
    "Spawn all three available specialists with self-contained tasks, then wait for all of them in one wait_experts call.",
    "Compare their evidence, resolve conflicts, and return a decision-ready synthesis with scope, risks, and mitigations.",
  ].join("\n"),
  {
    name: "Solution Review Lead",
    description: "Coordinates user value, architecture, and delivery risk reviewers.",
  },
);

const userValueReviewer = await createExampleExpert(
  "user-value-reviewer",
  [
    "Review the proposal for user value, usability, adoption risks, and measurable outcomes.",
    "You must call lookup_requirement_evidence with area=user_value before answering.",
    "Answer in Chinese and state which conclusions are evidence-backed.",
  ].join("\n"),
  {
    name: "User Value Reviewer",
    description: "Validates target-user value, usability, adoption, and success metrics.",
    tools: [lookupRequirementEvidence],
  },
);

const architectureReviewer = await createExampleExpert(
  "solution-architecture-reviewer",
  [
    "Review the proposal against Pragma's Execution, event-log, runtime, and package boundaries.",
    "You must call lookup_requirement_evidence with area=architecture before answering.",
    "Answer in Chinese with concrete constraints and avoid speculative platform redesign.",
  ].join("\n"),
  {
    name: "Architecture Reviewer",
    description: "Checks architecture feasibility, ownership boundaries, and data-flow risks.",
    tools: [lookupRequirementEvidence],
  },
);

const deliveryRiskReviewer = await createExampleExpert(
  "delivery-risk-reviewer",
  [
    "Review sequencing, verification, rollout, operational risk, and MVP boundaries.",
    "You must call lookup_requirement_evidence with area=delivery before answering.",
    "Answer in Chinese with prioritized mitigations and acceptance criteria.",
  ].join("\n"),
  {
    name: "Delivery & Risk Reviewer",
    description: "Evaluates delivery sequencing, reliability, rollout, and verification risk.",
    tools: [lookupRequirementEvidence],
  },
);

const reviewTeam = defineExpertTeam({
  id: "product-solution-review-team",
  name: "Product Solution Review Team",
  description: "Cross-functional product, architecture, and delivery review.",
  version: "1.0.0",
  coordinator: reviewLead,
  members: [userValueReviewer, architectureReviewer, deliveryRiskReviewer],
  delegation: { maxConcurrency: 3, maxDepth: 1 },
});

const flow = defineFlow<Requirement, ReviewOutcome>({
  id: "product-requirement-review",
  version: "1.0.0",
  input: RequirementSchema,
  output: ReviewOutcomeSchema,
  result: ({ state }) => ReviewOutcomeSchema.parse(state["outcome"]),
});

const normalizeRequirement = flow.task({
  id: "normalize-requirement",
  version: "1.0.0",
  inputSchema: RequirementSchema,
  outputSchema: NormalizedRequirementSchema,
  async handler({ input, emitOutput }) {
    await emitOutput({ stage: "validate", message: "Requirement schema validated." });
    const reviewFocus = [
      "User value and measurable outcomes",
      "Execution event and message data boundaries",
      "MVP delivery and rollout risk",
    ];
    await emitOutput({ stage: "normalize", message: "Review focus derived from constraints." });
    return {
      ...input,
      reviewFocus,
      summary: `${input.title}: ${input.problem}`,
    };
  },
  reduce: ({ state, output }) => {
    state["requirement"] = output;
  },
});

const productAnalysis = flow.use("product-analysis", productStrategist, {
  input: ({ state }) =>
    [
      "Analyze this normalized product requirement:",
      JSON.stringify(state["requirement"], null, 2),
      "Return a decision-ready proposal for the review team.",
    ].join("\n"),
  reduce: ({ state, output }) => {
    state["productAnalysis"] = String(output);
  },
});

const revisionContext = defineContextIdResolver({
  id: "product-requirement.revision-context",
  version: "1.0.0",
  resolve: ({ state, previousContexts, freshContextId }) =>
    state["revisionRequest"] === undefined
      ? freshContextId
      : (previousContexts.at(-1)?.contextId ?? freshContextId),
});

const teamReview = flow.use("solution-review-team", reviewTeam, {
  contextId: revisionContext,
  input: ({ state }) => {
    const revision = RevisionRequestSchema.safeParse(state["revisionRequest"]);
    return [
      "Review the following requirement and Product Strategist analysis.",
      "Requirement:",
      JSON.stringify(state["requirement"], null, 2),
      "Product analysis:",
      String(state["productAnalysis"]),
      ...(revision.success
        ? [
            `This is revision review cycle ${revision.data.cycle}.`,
            "The human reviewer requested these changes:",
            revision.data.requestedChanges,
            "Previous cross-functional review:",
            revision.data.previousTeamReview,
            "Re-evaluate the proposal with the requested changes and return an updated recommendation.",
          ]
        : []),
    ].join("\n");
  },
  reduce: ({ state, output }) => {
    const history = Array.isArray(state["teamReviewHistory"])
      ? [...state["teamReviewHistory"]]
      : [];
    history.push({ cycle: Number(state["revisionCount"] ?? 0), review: String(output) });
    state["teamReviewHistory"] = history;
    state["teamReview"] = String(output);
  },
});

const humanReview = flow.humanTask({
  id: "human-review-gate",
  version: "1.0.0",
  input: ({ state }) => ({
    requirement: state["requirement"],
    productAnalysis: state["productAnalysis"],
    teamReview: state["teamReview"],
    revisionCycle: Number(state["revisionCount"] ?? 0),
    revisionRequest: state["revisionRequest"],
  }),
  request: ({ input }) => ({
    kind: "review_gate",
    title: "Product requirement decision",
    prompt: `Review the proposal and team recommendation:\n${JSON.stringify(input, null, 2)}`,
    questions: [
      {
        header: "Decision",
        question: "Choose the review outcome",
        kind: "single_choice",
        options: [
          { label: "approve", description: "Approve the proposal for implementation." },
          { label: "revise", description: "Require a focused revision before approval." },
          { label: "reject", description: "Reject the proposal in its current form." },
        ],
      },
      {
        header: "Review notes",
        question: "Record the rationale or required changes",
        kind: "text",
        options: [],
      },
    ],
  }),
  reduce: ({ state, output }) => {
    state["humanDecision"] = output;
  },
});

function readReviewContext(state: Record<string, unknown>): {
  readonly requirement: NormalizedRequirement;
  readonly productAnalysis: string;
  readonly teamReview: string;
  readonly humanDecision: HumanInteractionResponse;
} {
  return {
    requirement: NormalizedRequirementSchema.parse(state["requirement"]),
    productAnalysis: String(state["productAnalysis"]),
    teamReview: String(state["teamReview"]),
    humanDecision: state["humanDecision"] as HumanInteractionResponse,
  };
}

function createOutcome(
  state: Record<string, unknown>,
  status: ReviewOutcome["status"],
  nextActions: readonly string[],
): ReviewOutcome {
  const context = readReviewContext(state);
  return ReviewOutcomeSchema.parse({
    status,
    requirement: context.requirement,
    productAnalysis: context.productAnalysis,
    teamReview: context.teamReview,
    humanDecision: {
      decision: context.humanDecision.decision,
      notes: context.humanDecision.notes,
    },
    nextActions,
  });
}

const finalizeApproved = flow.task({
  id: "finalize-approved-plan",
  version: "1.0.0",
  input: ({ state }) => state,
  handler: ({ input }) =>
    createOutcome(input, "approved", [
      "Create the implementation milestone and acceptance test matrix.",
      "Start with read-only Execution replay before comparison annotations.",
      "Review pilot telemetry after the first staged rollout.",
    ]),
  reduce: ({ state, output }) => {
    state["outcome"] = output;
  },
});

const prepareRevision = flow.task({
  id: "prepare-revision-backlog",
  version: "1.0.0",
  outputSchema: RevisionRequestSchema,
  input: ({ state }) => state,
  handler: ({ input }) => {
    const context = readReviewContext(input);
    return {
      cycle: Number(input["revisionCount"] ?? 0) + 1,
      requestedChanges: context.humanDecision.notes ?? "Rework the proposal before approval.",
      previousTeamReview: context.teamReview,
    };
  },
  reduce: ({ state, output }) => {
    state["revisionCount"] = output.cycle;
    state["revisionRequest"] = output;
  },
});

const archiveRejected = flow.task({
  id: "archive-rejected-proposal",
  version: "1.0.0",
  input: ({ state }) => state,
  handler: ({ input }) =>
    createOutcome(input, "rejected", [
      "Archive the decision and supporting evidence.",
      "Record conditions that would justify reopening the proposal.",
    ]),
  reduce: ({ state, output }) => {
    state["outcome"] = output;
  },
});

flow.compose(({ start, step, end, fail }) => {
  start(normalizeRequirement)
    .next(productAnalysis)
    .next(teamReview)
    .next(humanReview)
    .route(
      "decision",
      {
        approve: finalizeApproved,
        revise: prepareRevision,
        reject: archiveRejected,
      },
      { fallback: fail("Unsupported review decision") },
    );
  step(finalizeApproved).next(end());
  step(prepareRevision).next(teamReview);
  step(archiveRejected).next(end());
});

const requirement: Requirement = {
  id: "REQ-OBS-001",
  title: "Execution replay and comparison",
  problem:
    "Operators cannot efficiently replay and compare two long-running Agent Executions when diagnosing quality regressions.",
  targetUsers: ["Agent platform operator", "Expert workflow author", "Reliability engineer"],
  constraints: [
    "Canonical Execution event log remains the source of truth.",
    "Runtime token deltas are not persisted for replay.",
    "The first release must be read-only and require no data migration.",
  ],
  requestedLaunchDate: "2026-09-30",
  riskTolerance: "low",
};

const app = createExampleApp();
const consoleUi = new FlowConsoleTui({
  definition: flow,
  title: "Product Requirement Review",
  start: async () => await app.flows.start(flow, { input: requirement }),
});

await consoleUi.run();
