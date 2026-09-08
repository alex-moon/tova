# Document Status

This document previously defined a packet-based backlog workflow (packets named `plan-XXX-...`, moved through `docs/done/`). That system is retired.

## Current State

- The packet backlog is empty. Packets 001–005 are delivered; the delivery history and current status live in `docs/progress.md`.
- There are no outstanding local tasks or plans.
- All future planning, tasks, and tracking happen on GitHub (`alex-moon/tova`): use issues and pull requests for open work.

## What Stays Here

- `docs/overview.md`: product intent (stable).
- `docs/progress.md`: closed packet history and current status (static log).
- `docs/plan.md`: this reconciled closure note.
- `docs/workflow.md`: the standard process for all new work (ticket → branch → plan → implement → verify → PR → archive).

Do not recreate the old packet backlog. New work follows `docs/workflow.md`: the "plan" filenames are similar, but each new plan doc is tied to a GitHub issue (see that file), not a local backlog.
