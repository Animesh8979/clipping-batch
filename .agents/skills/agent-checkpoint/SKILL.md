---
name: agent-checkpoint
description: "Lightweight, zero-resource agent task checkpointing for Windows. Replaces Linux-only Kubernetes orchestrators (like Google AX) with atomic SQLite WAL snapshots and clean process termination."
tags: [agent, checkpoint, snapshot, state, lifecycle, windows, sqlite]
created: "2026-10-01 15:10:00"
---

# agent-checkpoint

A zero-resource, production-grade agent lifecycle checkpoint and resumption engine for Windows.

## The Senior Dev Insight vs Google AX
- **The Google AX Flaw**: Google AX attempts to suspend containers using Linux cgroups and CRIU. On Windows, suspending a process leaves 100% of RAM and VRAM mapped. Running Kubernetes/Minikube inside WSL2 burns 4GB–6GB of RAM just idling.
- **The Ponytail Solution**: The ultimate process suspension is **TERMINATION**. A terminated process consumes **0 bytes of RAM, 0% CPU, and 0 bytes of VRAM**.
- **How it works**:
  1. The agent serializes its task state, memory graph, and task queue into an atomic SQLite WAL database.
  2. The process exits cleanly or is stopped via `manage_task kill`.
  3. When resumed, the state is rehydrated into memory in <5ms.

## Usage Patterns

```python
from checkpoint_engine import AgentCheckpoint, AgentCheckpointEngine

engine = AgentCheckpointEngine()

# 1. Suspend task
checkpoint = AgentCheckpoint(
    task_id="refactor-auth-01",
    agent_id="planner",
    status="paused",
    step_index=14,
    memory_state={"files_analyzed": ["auth.py"], "diff": "..."},
    task_queue=["write_tests", "run_linter"]
)
engine.save_checkpoint(checkpoint)
# Process terminates here -> 0MB RAM, 0 VRAM!

# 2. Resume task later
state = engine.load_checkpoint("refactor-auth-01")
print(f"Resuming task {state.task_id} at step {state.step_index}")
```
