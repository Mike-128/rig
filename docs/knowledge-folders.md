# Knowledge folders and persistent notes

An agent can read reference material from folders on the machine running Rig, including mounted network drives and Windows UNC shares. The original hierarchy stays intact. The agent browses folders, searches text, and retrieves relevant excerpts into its conversation context. Source files are not copied or edited by the knowledge tools.

## Attach a folder

1. Open **Agents** and select or create an agent.
2. Under **Knowledge folders and memory**, click **Add knowledge folder**.
3. Enter a unique source name such as `reference`, an absolute folder path, and a description telling the agent what it contains.
4. Click **Check folder** to confirm that the runtime can list it. This does not contact a model.
5. Save the agent. Knowledge read/search tools are enabled automatically when you attach folders through the editor.
6. Start a **new chat** with that agent. Existing sessions retain their saved agent version.

Examples of paths:

```text
C:\Knowledge\Product Manuals
\\server\share\Reference
/mnt/team/reference
```

These paths refer to the runtime's machine, not necessarily the computer displaying the browser. Network folders use the runtime account's existing filesystem permissions. A server URL such as an HTTPS document portal or S3 bucket is not a filesystem path: mount the store through your approved process first. Rig does not collect share credentials or require administrator mode.

Try: “Browse the reference source, find the deployment procedure, and summarize it with file citations.”

## What enters model context

Only source names and descriptions are added to the system prompt. `knowledge_read` lists a folder or retrieves a text excerpt; `knowledge_search` returns literal, case-insensitive text matches with relative paths and line numbers. The agent chooses what to read. This is on-demand retrieval, not automatic ingestion, semantic/vector search, or a guarantee that all documents have been reviewed.

Retrieved excerpts are sent to the agent's configured provider and stored as tool results in Rig's conversation history. Source contents and notes are reference data, not instructions. Removing a folder from an agent does not erase excerpts already present in chat history. Folder paths travel with exported agent YAML, so review them before sharing a definition.

The knowledge tools check both relative-path containment and resolved paths to reject symlink/junction escapes. They do not grant write access. Other separately enabled tools, such as shell, retain their own capabilities; a knowledge attachment is not an operating-system sandbox.

## Supported content and bounds

- UTF-8 text: Markdown, plain text, source code, CSV/TSV, JSON, YAML, and related text formats. PDF, Office, images and binary files need text extraction before use.
- Up to ten source folders per agent and 1 MiB per text file.
- Reads return up to 20,000 characters with a `nextOffset` for continuation. Directory listings return up to 500 entries and report truncation.
- Searches examine up to 100 files, 2,000 directory entries, approximately 8 MiB of text, and return at most 50 matches. Symlinks, `.git` and `node_modules` are skipped. Results include skipped counts and truncation status; an empty bounded search is not proof that a whole library contains no matches.
- Operations stop waiting after ten seconds or cancellation. A pending operating-system network request may take longer to settle, but subsequent traversal checks the cancellation signal.

Files are read from the store each time, so new tool reads see current contents. Previously retrieved conversation excerpts and saved notes remain historical snapshots. Large or frequently searched libraries may benefit from a future index; no index service is required for this feature.

## Persistent notes

Enable **persistent notes** to let the agent read its own notes from previous sessions. Optionally enable **Allow note updates, with approval** under sandbox 1. The model calls `memory_write`; Rig shows the proposed replacement text and pauses for approval before saving it. Rejecting approval leaves the notes unchanged.

Notes are separate from source folders and stored in the local SQLite `agent_memory` table under the agent's slug. They survive restarts and are shared across sessions and versions of that agent. They are not automatically loaded as instructions: the agent uses `memory_read` when useful. Notes have a 24,000-character limit and should contain concise findings and source citations, never credentials.

Updates require the exact previously read text so a stale session cannot overwrite a concurrent update. On conflict, read the latest notes and merge the changes. Disabling memory preserves notes; deleting the agent deletes its notes. Agent YAML export includes the memory setting, not the note contents. Ordinary chat history remains separately stored.

## YAML example

```yaml
name: Reference assistant
slug: reference-assistant
model:
  alias: default
instructions: >-
  Answer from the attached reference folders. Search and read relevant files,
  cite source names and paths, and say when evidence is missing.
knowledge:
  - name: reference
    path: 'C:\Knowledge\Reference'
    description: Product guides and operating procedures
memory: true
tools:
  - knowledge_read
  - knowledge_search
  - memory_read
  - memory_write
sandbox: 1
approvals:
  - memory_write
```

For read-only research, omit `memory_write`, use `sandbox: 0`, and set `approvals: []`. To use sources without persistent notes, omit `memory` and both memory tools.
