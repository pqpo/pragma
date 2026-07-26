# Governance

## Principles

Pragma is developed in the open with these principles:

- architecture and protocol changes are documented and reviewable;
- user safety, portability, and long-term maintainability take priority over short-term compatibility;
- project decisions distinguish source code, third-party content, user data, and project marks;
- maintainers disclose material conflicts of interest;
- no contributor is entitled to merge access or special project status solely by contributing code.

## Roles

### Contributors

Anyone who participates through issues, design feedback, documentation, code, testing, or community
support.

### Reviewers

Contributors trusted to review a defined area. Review authority does not imply merge authority or
ownership of the project.

### Maintainers

People responsible for repository direction, releases, security response, merge decisions, and
enforcement of project policies. Current ownership defaults are recorded in
[`.github/CODEOWNERS`](./.github/CODEOWNERS).

## Decision Making

Routine changes are decided through pull request review. Maintainers seek evidence and rough
consensus, but consensus is not required for every decision.

The following changes normally require an ADR or equivalent design document:

- public protocol or DSL changes;
- persistent storage schema and migration policy;
- new package or dependency direction;
- Runtime Adapter or plugin contract changes;
- security and permission model changes;
- changes to project licensing or contribution terms;
- changes that materially alter contributor or user rights.

When consensus cannot be reached, maintainers make the final repository decision and document the
reasoning and rejected alternatives.

## Project Identity

The source code license, contribution terms, and Pragma project marks are governed separately.
Modified distributions must follow the source code license and the
[Trademark Policy](./TRADEMARKS.md). Repository decisions must continue to respect those policies,
the security policy, and documented architectural boundaries.

## Becoming a Maintainer

Maintainers may invite a contributor based on sustained, high-quality participation, sound judgment,
reliability, security awareness, and alignment with project values. Maintainer status may be scoped
to particular packages or domains.

Maintainer access may be reduced or removed for inactivity, security needs, repeated policy
violations, conflicts of interest that cannot be managed, or conduct inconsistent with the Code of
Conduct.

## Changes to Governance

Changes to this document require a pull request and explicit maintainer approval.
