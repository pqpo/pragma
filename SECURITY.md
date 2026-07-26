# Security Policy

## Supported Versions

Pragma is under active development and does not yet publish stable release branches. Security fixes
are currently made on the latest `main` branch. This policy will be updated when versioned releases
and support windows are introduced.

## Reporting a Vulnerability

Do not report suspected vulnerabilities in a public issue, discussion, pull request, or log dump.

GitHub private vulnerability reporting is not currently enabled for this repository. Open a
[security contact request](https://github.com/pqpo/pragma/issues/new?template=security_contact.yml)
containing no vulnerability details. A maintainer will arrange a private channel where you can
include:

- the affected commit, package, or application;
- impact and realistic attack scenario;
- reproduction steps or a minimal proof of concept;
- whether secrets, user data, local files, or remote execution are involved;
- any suggested mitigation;
- how you would like to be credited.

This temporary process must be replaced with GitHub private vulnerability reporting or a dedicated
security address before the first public release.

## Response Process

Maintainers will:

1. acknowledge a complete report as soon as practical;
2. validate scope and severity;
3. coordinate a fix and release plan;
4. keep the reporter informed at meaningful milestones;
5. publish an advisory when users need to take action.

Timelines depend on severity and release readiness. Please allow maintainers a reasonable period to
investigate and remediate before public disclosure.

## High-Risk Areas

Pragma coordinates AI runtimes and privileged tools. Reports involving these areas are especially
important:

- shell, filesystem, Git, browser, or network permission bypass;
- workspace path escape or symlink traversal;
- credential, secret, prompt, or personal-data exposure;
- unsafe plugin, Skill, MCP, or Runtime Adapter loading;
- Runtime Session ownership or cross-tenant isolation failures;
- execution event forgery, replay, or authorization bypass;
- Desktop preload, IPC, sandbox, or local bridge vulnerabilities;
- untrusted project or artifact integrity verification;
- persistent state corruption or unsafe migration behavior.

## Safe Research

Only test systems and data you own or are explicitly authorized to test. Do not access other users'
data, degrade hosted services, use social engineering, or retain sensitive data beyond what is
necessary to demonstrate the issue.

This policy does not create a bug bounty or promise payment.
