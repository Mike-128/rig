---
name: agent-design
description: How to design a good agent for this rig — choosing tools, sandbox level, approvals, budgets, and writing instructions that actually steer behavior. Load this before creating or revising an agent definition.
---

# Designing an agent

An agent definition is a system prompt plus a bounded set of capabilities. Most of the quality comes from two choices: what you write in `instructions`, and which tools you grant.

## Instructions

Write to the agent, not about it. "You review pull requests for security problems" beats "This agent is a security reviewer."

Cover four things, in this order:

1. **What it does.** One or two sentences establishing the role and the output the user expects.
2. **How to approach the work.** The procedure a careful person would follow. This is where most of the value is: say what to read first, what to check, what order to work in.
3. **When to use which tool.** Name the tools explicitly: "read the file with file_read before editing it", "use web_fetch when the answer depends on current information".
4. **What good output looks like.** Format, length, and what to include or leave out.

Keep it specific to the job. Generic exhortations ("be helpful", "be accurate", "think step by step") consume context and change little. Constraints that rule things out are worth more than encouragement.

State what the agent should do when it cannot finish: ask, or report what it could not do. Otherwise agents guess.

## Tools

Grant the fewest tools that let the agent finish its job.

| Tool | Grant it when | Notes |
|---|---|---|
| `file_read` | The agent works with files or needs to inspect a project | Read-only, safe |
| `web_fetch` | The task depends on current information or a specific URL | Read-only, public http(s) only |
| `file_write` | The agent produces or edits files | Needs sandbox 1; put in `approvals` |
| `shell` | The agent runs builds, tests, or command-line tools | Needs sandbox 1; put in `approvals` |
| `load_skill` | The agent has skills attached | Required whenever `skills` is non-empty |
| `agent_list`, `agent_read`, `agent_write` | The agent creates or revises other agents | `agent_write` should be in `approvals` |
| `model_list` | The agent chooses models, usually alongside `agent_write` | Read-only |
| `skill_list`, `skill_write` | The agent manages reusable skills | `skill_write` should be in `approvals` |

An agent that only answers questions needs no tools at all. Do not grant `shell` "just in case" — it is the widest capability in the rig.

## Sandbox and approvals

- **Sandbox 0** is read-only: no writes, no process spawn. Use it for research, review, and question-answering agents.
- **Sandbox 1** allows writes and shell, jailed to the session workspace directory. Use it for agents that produce or change things.

Put every side-effecting tool in `approvals` unless the user has said they want it to run unattended. Approval pauses the run and shows the user the exact arguments. The cost is one click; the benefit is that a wrong `shell` command never runs silently.

## Model binding

Prefer `{"alias": "default"}`. Aliases resolve per machine, so the agent still works when shared with someone whose keys differ. Bind an explicit `{"connection", "model"}` pair only when the agent genuinely needs one specific model.

Check `model_list` before binding: only pick a model whose status is `entitled`.

## Budgets

`maxTurns` bounds a single run. A conversational agent rarely needs more than 10. An agent that reads, edits, and tests in a loop may need 30 to 50. Set `usd` when an agent runs unattended.

## Common mistakes

- Granting `shell` when `file_read` would do.
- Instructions that describe the agent instead of directing it.
- Skills attached without `load_skill` in tools, so the agent can never read them.
- Sandbox 1 with no approvals on an agent that edits files the user cares about.
- A `maxTurns` of 25 on an agent that needs to iterate through a long build-and-test loop.
