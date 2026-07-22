# ADR 015: Pragma as the Default General-Purpose Agent

## Status

Accepted

## Context

The built-in system Expert was named Pragma Steward and described narrowly as a conversational
manager for Pragma DSL resources and Missions. That made expert authoring appear to be a prerequisite
for using the application and understated the Runtime's ability to complete ordinary work directly in
an authorized workspace.

Pragma needs a default Agent that is useful immediately. A user should be able to describe any task
without first creating an Expert. Specialized Experts, ExpertTeams, and Flows remain valuable for
repeatable behavior, domain specialization, delegation, and governed workflows, but they are optional
execution choices rather than onboarding requirements.

## Decision

Rename the built-in product Agent to `Pragma` and give it the canonical ref
`expert:pragma@1.0.0`. Pragma is the application's general-purpose default Agent:

- Home selects it by default and it is always available independently of editable project resources.
- Its primary goal is to complete the user's request with the selected Runtime, authorized workspace,
  installed capabilities, and configured approval policy.
- It works directly when no specialized Expert is needed.
- Creating and updating Experts, ExpertTeams, and Flows, and operating Missions, remain bundled
  capabilities rather than defining its entire scope.
- Pragma DSL writes still use the authoring Skill and prepare/validate/approve/commit boundary; the
  Agent never edits project storage directly.
- Mission storage, Execution events, chat, approvals, interruption, and recovery remain shared with
  every other executor. Pragma does not gain a separate Session or product protocol.
- Desktop localizes the built-in Pragma name, description, and scope in presentation surfaces without
  changing its canonical DSL or execution fingerprint. Customized built-in metadata and user-authored
  Expert metadata remain authored content and are displayed without translation.

Rename the reusable package from `@pragma/steward` to `@pragma/default-agent`. The package owns the
portable Pragma DSL, bundled authoring Skill, application-neutral project and Mission ports, managed
tools, and compiler helper. Desktop continues to own persistence, Runtime selection, permissions,
system-expert registration, and Mission execution.

This is an intentional breaking change. No `expert:steward@1.0.0` alias or package compatibility
layer is retained. Persisted data that explicitly references the former system ref is not migrated by
the default-agent package.

## Consequences

- A fresh installation has a useful Agent before the user creates any specialized resources.
- Product copy describes outcomes and general work instead of presenting orchestration as the only
  entry path.
- Specialized executors remain first-class and can be selected per Mission.
- Runtime and permission boundaries continue to determine what “general-purpose” can actually do.
- The old Steward name remains only in superseded ADR history.
