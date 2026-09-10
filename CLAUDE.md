# Rig

Project context for coding agents lives in **[AGENTS.md](AGENTS.md)** — read that first.

It covers what Rig is, the architecture and its central abstraction, build and test commands,
runtime state, provider quirks that cost real debugging time, and the invariants not to break.

Further reading: `README.md` for user-facing setup, `DESIGN.md` for the full design record.

## Current adoption context

Read the progress and private-setup boundary in AGENTS.md section 9 before working on gateway compatibility. This checkout includes doctor diagnostics, Windows setup/restart guidance, connection-wide metadata headers, and configurable discovery. The manual-model editor tested by the user is from another revision; check branch history before assuming it exists here.

The user's manually configured model now works, but inventory scanning remains unresolved. Direct PowerShell listing worked. Provider model lists and Azure deployment inventories have different shapes: a resource `id`, deployment `name`, and model-family name are not interchangeable. Do not claim arbitrary inventory responses are supported just because a listing route can be configured. Pressure-test with synthetic fixtures and keep failures visible.

Use `docs/windows-setup.md` for normal, non-administrator PowerShell commands, per-terminal pnpm PATH, runtime certificate trust, and build/restart steps. `pnpm rig doctor` makes no provider request by default; `--probe` explicitly tests the default model and may incur usage. A validation-only 400 is classified as entitled but does not prove a successful chat.

Connection headers are non-secret metadata stored locally and forwarded by the runtime proxy to listing, probes, and inference. Credentials stay in the secret backend; adapters never receive them. Preserve authentication-header protections and keep inference dialect/route on each Model.

Employer-specific setup belongs only in the user's private Documents reference outside Git. Never copy its service details, raw inventory, or credentials into public files or PRs. Use generic examples in repository changes. Keep AGENTS.md as the authoritative shared guide rather than duplicating its full architecture here.
