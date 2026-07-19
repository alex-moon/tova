## Agent Collaboration Guide

This repository keeps shared, agent-agnostic project coordination documents in `docs/`.

### Project intent

`Tova` is building a Groq-focused chat application with:

- authenticated users
- persistent chat sessions stored in MongoDB
- an intelligent router that selects Groq models based on prompt complexity
- a React frontend served through a unified local development experience

In short: it is aiming to be an application-layer “Heroku for Groq” with a built-in chat product.

### Documentation structure

- `docs/overview.md`: a high-level summary of the overall intent
- `docs/plan.md`: the canonical product and implementation plan
- `docs/progress.md`: the canonical delivery log and current status snapshot

### Working rules for agents

- Prefer `docs/plan.md` for goals, scope, architecture, and intended next steps.
- Prefer `docs/progress.md` for completed work, current status, and historical delivery notes.
- When updating project coordination docs, keep the shared version in `docs/` current first.

