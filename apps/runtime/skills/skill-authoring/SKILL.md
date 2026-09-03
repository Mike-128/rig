---
name: skill-authoring
description: How to write a good skill for this harness — what belongs in the description versus the body, and how to structure reusable task instructions. Load this before creating or editing a skill.
---

# Writing a skill

A skill is reusable instructions for a kind of task, loaded on demand. It has two parts, and they do different jobs.

## The description is the trigger

The description is the only part always in context. It is what an agent reads when deciding whether this skill is relevant. Everything else is invisible until the skill is loaded.

Write it to answer "should I load this right now?" — name the task, not the skill's qualities.

- Good: "Fill and extract data from PDF forms, including flattening and checkbox handling."
- Bad: "A comprehensive and powerful skill for PDF work."

Include the concrete nouns someone would use for the task. If the skill covers changelogs, the word "changelog" belongs in the description. Two sentences at most.

## The body is the procedure

The body is read only after the agent has committed to the task, so skip motivation and get to the work. Write it as instructions to whoever is performing the task.

Structure that works:

1. **When this applies** — one line, if the description left any ambiguity.
2. **The procedure** — numbered steps in the order they should happen.
3. **Rules and constraints** — what to always do, what never to do.
4. **Examples** — a short before-and-after, if the task has a house style.
5. **Failure modes** — what commonly goes wrong and what to do instead.

## Keep it about the task

A skill should not restate general good behavior. It earns its place by carrying knowledge the model does not already have: your house style, your file layouts, your naming conventions, the sequence your build needs, the fields your forms require.

If you could delete a paragraph and no behavior would change, delete it.

## Length

Aim for one to two pages. A skill that grows past that is usually two skills, or wants a resource file beside it holding reference material the agent reads only when it needs the detail.

## Naming

Lowercase letters, digits, and dashes. Name it after the task (`release-notes`, `pdf-forms`, `incident-review`), not after a role or a document type.
