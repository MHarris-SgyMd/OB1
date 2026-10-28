# Agent Memory Dashboard Screenshots

These captures show the OB1 Agent Memory dashboard design pass inspired by the Content Master Pro graphite workspace aesthetic, with added Nate B. Jones / OB1 micro-branding and the beanie/glasses OB1 mark. They are intended as baseline visual assets for Linear updates, tutorial planning, and Nate-facing walkthroughs. They were captured from the Next.js dashboard's Agent Memory pages, which retired with that dashboard (SMD-3309); agent-memory-api's own pages come as a plugin's (SMD-2690). The full-dashboard walkthrough taken from that dashboard (its screenshots, PDF, video and scripts) retired with it.

| File | Surface | Capture Notes |
| --- | --- | --- |
| `agent-memory-review-queue.png` | Review queue | Pending agent-written memories with scope strip, trust labels, policy labels, and review actions. |
| `agent-memory-inspector.png` | Memory inspector | Single-memory provenance, source refs, metadata, use policy, scope, and origin. |
| `agent-memory-recall-trace.png` | Recall trace | Retrieval debug path showing request metadata, returned memories, scores, policy, and usage reporting. |
| `nate-continuity-pending-desktop.png` | Review queue | Desktop capture of Nate continuity demo data with pending agent-written memories. |
| `nate-continuity-evidence-desktop.png` | Evidence view | Desktop capture of imported/source-backed reference memories marked evidence-only. |
| `nate-continuity-confirmed-desktop.png` | Confirmed view | Desktop capture of trusted operating rules that can guide future agents. |
| `nate-continuity-rejected-desktop.png` | Rejected view | Desktop capture showing false assumptions blocked from future recall. |
| `nate-continuity-stale-desktop.png` | Stale view | Desktop capture showing old assumptions preserved but not auto-injected. |
| `nate-continuity-trace-desktop.png` | Recall trace | Desktop trace for the Nate continuity demo recall run. |

Capture source:

- Local dashboard: `http://localhost:3020`
- API proxy: `http://127.0.0.1:3022`
- Smoke workspace/project: `ob1-staging` / `agent-memory-api-smoke`
- Nate continuity demo workspace/project: `nate-jones-personal-ob1` / `continuity-os`
- Nate continuity trace request: `d766f44e-5a11-4034-8ab5-3f497fa29492`
- Brand assets: `docs/assets/agent-memory/brand`

The original smoke memories were created with the live smoke harness and then cleaned from the personal OB1 Supabase project after capture. The Nate continuity demo memories are intentionally seeded reference/demo data for visual docs and should be removed or reseeded before public launch captures if the data story changes.

Use `integrations/agent-memory-api/smoke/seed-nate-continuity-demo.mjs` to recreate the Nate continuity project.
