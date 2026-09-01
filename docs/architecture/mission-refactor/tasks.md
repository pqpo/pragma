# Mission Refactor Tasks

Status values: `Planned`, `In progress`, `Blocked`, `Completed`.

| ID      | Status    | Task                                                                                        |
| ------- | --------- | ------------------------------------------------------------------------------------------- |
| MRF-001 | Completed | Recheck the eight architecture findings against current source and tests.                   |
| MRF-002 | Completed | Record the implementation plan, task ledger, and process log in the repository.             |
| MRF-101 | Completed | Introduce immediate Desktop command receipts and remove message terminal waits from IPC.    |
| MRF-102 | Completed | Preserve structured IntegrationError recovery data across Desktop IPC.                      |
| MRF-103 | Completed | Reconcile optimistic sends and uncertain retries by stable request id.                      |
| MRF-201 | Completed | Make owner acquisition, renewal, and Inbox polling one lifecycle.                           |
| MRF-202 | Completed | Add poll failure diagnostics, backoff, relinquishment, and recovery.                        |
| MRF-203 | Completed | Add lease expiry reacquisition and retain multi-process race coverage.                      |
| MRF-301 | Completed | Create one Local Host Mission command dispatcher and normalized command results.            |
| MRF-302 | Completed | Delete Desktop and Core duplicate command switches.                                         |
| MRF-303 | Completed | Project follow-up Core Execution events into the canonical Mission feed.                    |
| MRF-304 | Completed | Make Desktop and CLI query/watch projections consistent.                                    |
| MRF-401 | Completed | Delete the unused Shared Mission operation schema and transitions.                          |
| MRF-402 | Completed | Keep storage at v10 and isolate v3-v9 schemas plus v3-v10 adjacent migrations.              |
| MRF-403 | Completed | Preserve historical fixtures and test backup, chain, recovery, no-op, and future rejection. |
| MRF-501 | Completed | Continue reducing MissionRunner after extracting execution observation and projection.      |
| MRF-511 | Completed | Isolate Runner contracts and single-owner state boundaries.                                 |
| MRF-512 | Completed | Extract Mission chat and Work services plus their projections and subscriptions.            |
| MRF-513 | Completed | Extract Mission Session and Execution lifecycle services.                                   |
| MRF-514 | Completed | Extract Mission command and Local Host control service.                                     |
| MRF-515 | Completed | Reduce MissionRunner to composition/delegation and split its tests by service.              |
| MRF-502 | Completed | Split timeline storage, projection storage, and historical migrations from MissionStore.    |
| MRF-503 | Completed | Continue extracting renderer state after isolating command delivery and retry rules.        |
| MRF-531 | Completed | Extract the pure conversation model and presentation components.                            |
| MRF-532 | Completed | Extract conversation cache, streaming, paging, and subscription state.                      |
| MRF-533 | Completed | Extract composer, draft, attachment, retry, and queued-message actions.                     |
| MRF-534 | Completed | Extract Work, human-interaction, options, and Context-operation state.                      |
| MRF-535 | Completed | Reduce MissionsPage to orchestration and split renderer tests by domain.                    |
| MRF-504 | Completed | Delete obsolete compatibility code and duplicate tests; run final validation.               |

## Host convergence follow-up

| ID      | Status      | Task                                                                                                                     |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| MRF-601 | Completed   | Move the shared Node Host composition root, Mission control and run wiring behind `@pragma/local-host/node-application`. |
| MRF-602 | Completed   | Compose Mission controller, owner lease, query, and watch as one reusable Local Host lifecycle.                          |
| MRF-603 | In progress | Move remaining Desktop product stores/services behind Host ports without leaking Electron.                               |
