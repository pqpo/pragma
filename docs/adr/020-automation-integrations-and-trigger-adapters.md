# ADR 020: Automation Integrations and Trigger Adapters

## Status

Accepted

## Context

A product-level “timer” would couple Studio, persistence, and Mission creation to one trigger type.
The intended boundary is broader: schedules, webhooks, DingTalk robots, WeChat robots, and other
conversation channels should all be able to start the same Expert system without adding a separate
execution stack for every integration.

Trigger delivery also needs an explicit Mission-continuity rule. A schedule or IM conversation often
expects follow-up turns to reuse one ExpertSession, while independent jobs and every Flow execution
need a fresh Mission. Tool approvals and overlapping events must remain predictable.

## Decision

The Studio product module is named **Integrations**. Its primary configured object is an
**Automation**:

- an Automation selects one trigger adapter, one exact Expert, ExpertTeam, or Flow ref, an input,
  an interaction policy, and a delivery adapter;
- a **Connection** is a reusable host-owned credential and endpoint binding for adapters that need
  one; secret values and machine paths never enter portable DSL;
- a **Connector** is an adapter implementation. Core defines runtime-neutral source and delivery
  contracts, Interpreter owns the `Automation` DSL resource and adapter registry, and each host owns
  binding persistence and process lifecycle;
- Desktop implements `pragma.automation.schedule@v1`. Server may later host the same Automation
  model, but this decision does not introduce a Server runtime gateway.

Trigger adapters normalize input to a versioned `AutomationEventEnvelope`. Source mode is either a
one-shot `signal` or a `conversation`; placement is `desktop`, `server`, or `either`. Future IM
adapters key continuity by external conversation, and expose controlled status/final-answer
delivery rather than arbitrary Execution internals.

Schedule supports single timestamps, fixed intervals, daily/weekday/weekly/monthly calendar rules,
five-field Cron expressions, IANA time zones, and optional active windows. Desktop schedules only
while the app is running. A callback more than one minute late is recorded as skipped; offline and
sleep periods are not caught up.

Mission policies are:

- Expert and ExpertTeam default to `reuse-session`. Schedule continuity is scoped to the complete
  Automation. Events are FIFO; a running execution or pending tool/human approval blocks the next
  event.
- Expert and ExpertTeam may choose `new-mission`; independent events may execute concurrently.
- Flow always uses `new-mission` and structured Flow input.
- Resetting continuity rotates the Automation binding generation. Deleting an Automation removes
  only its DSL and host state; Missions, ExpertSessions, Executions, and conversation history remain.

Desktop keeps a versioned host binding under `~/.pragma/data/automation-bindings/` and recoverable
queue/run state under `~/.pragma/state/automations/`. Both start at v1, validate strictly, and reject
unknown future versions. Generation changes and deletion move recoverable state through the
journaled trash path. Future schema bumps follow ADR 019 with adjacent migrations.

The built-in Pragma Agent receives application-neutral Automation host tools. It can list, create,
edit, enable, disable, reset continuity, and delete Automations through conversation. Saving uses a
specialized host port because workspace and permission bindings cannot be committed as portable DSL
alone.

## Consequences

- New trigger types extend adapters, Connections, configuration UI, and host composition without
  creating a new Agent or Mission runtime.
- Studio can grow a Connections catalog independently of Automation definitions.
- Trigger retries are idempotent through stable event IDs and deterministic Mission/message IDs.
- Reused sessions preserve context and approvals but deliberately serialize events.
- Desktop is not a high-availability scheduler. Server placement is required before users can
  expect execution while every Desktop is offline.
- Connection lifecycle, webhook authentication, IM conversation identity, rate limits, and outbound
  delivery remain explicit future work rather than hidden fields in the schedule implementation.
