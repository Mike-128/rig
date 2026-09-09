# Windows installation and testing

Use a normal PowerShell terminal, including the terminal in VS Code. These steps install pnpm in your user folder and do not require administrator mode or changes to PowerShell execution policy. Company application and network policies still apply.

Run commands one step at a time. If a step fails, save its error before continuing.

## 1. Check prerequisites

```powershell
git --version
node --version
npm.cmd --version
```

Rig requires Node **22.13 or newer** with built-in SQLite. If Git, Node, or npm is missing or blocked, obtain an approved installation through your company's software process. Corepack is not required for the installation below.

## 2. Install pnpm in your user folder

Install the version pinned in this repository's `package.json`:

```powershell
npm.cmd install --global pnpm@11.25.0 --prefix "$env:LOCALAPPDATA\rig-tools"
```

Despite the `--global` flag, the explicit prefix places this installation in your user folder. A message such as **“1 package is looking for funding”** is informational; you do not need to run `npm fund`. An update notice does not require upgrading beyond the repository's pinned version.

Make that folder available in the current terminal:

```powershell
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
pnpm.cmd --version
```

The expected version is `11.25.0`.

**Repeat the PATH line in every new terminal**, including the second terminal used later. This setting lasts only for the current terminal; closing it does not uninstall pnpm. Using `pnpm.cmd` avoids invoking the PowerShell `.ps1` launcher.

Alternatively, call pnpm by its full path whenever you need it:

```powershell
& "$env:LOCALAPPDATA\rig-tools\pnpm.cmd" --version
```

## 3. Get the repository and install dependencies

In a writable parent folder where you want the repository:

```powershell
git clone https://github.com/Mike-128/rig.git
cd rig
```

If you already have a clone, open its folder instead. For a clean checkout on `main`, update it with:

```powershell
git pull --ff-only
```

If Git reports local changes or diverging history, resolve that separately; do not discard work just to follow this guide.

From the repository root (the folder containing `pnpm-workspace.yaml`):

```powershell
pnpm.cmd install --frozen-lockfile
```

If installation fails with a registry, certificate, or access error, preserve the exact error. The fix depends on your company's approved package registry, proxy, or certificate configuration.

## 4. Test local prerequisites

```powershell
pnpm.cmd rig doctor --offline
```

This checks Node, in-memory SQLite, temporary file access, shell execution, and proxy/certificate environment configuration. It does not contact the runtime or any model provider.

Expected results include passes for Node, SQLite, writable folders, and shell execution. The runtime warning is expected in offline mode. A missing additional CA file is a warning, not proof that certificates are broken.

## 5. Start Rig and test runtime connectivity

Build the browser UI **before starting the runtime**. In the first terminal, from the repository root:

```powershell
pnpm.cmd build
```

Wait for the build to finish successfully and return to the PowerShell prompt. Then start Rig:

```powershell
pnpm.cmd rig serve
```

**Leave this terminal running.** Wait for Rig to report that it is listening. If startup fails, capture that error first.

Open [Rig locally](http://127.0.0.1:7777). You should see the application with **Chat**, **Agents**, **Skills**, and **Models** navigation. Continue to step 6 to enter your key.

Open a second PowerShell terminal and navigate to the same repository root. Restore its PATH and run the connected checks:

```powershell
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
pnpm.cmd rig doctor
```

By default, doctor checks the runtime at `http://127.0.0.1:7777`. It also reads the reported credential backend and checks whether the default model alias is configured. A new installation can legitimately report that no default model is configured yet. No provider request is made by this command.

### If the browser says “Rig runtime — The web UI has not been built yet”

This is a status page, not the application. The API is working, but the runtime started without a built UI. In the second terminal, run:

```powershell
pnpm.cmd build
```

After the build finishes, stop the runtime with **Ctrl+C** in its terminal and restart it with `pnpm.cmd rig serve`. Reload [Rig locally](http://127.0.0.1:7777). Restarting matters: the runtime checks for the built UI at startup; reloading the browser alone is insufficient.

### If you already started Vite

`pnpm.cmd dev:web` starts the development UI server. Its terminal displays a Local URL, normally [http://localhost:5173](http://localhost:5173). Open the URL Vite actually prints. Keep **both** the runtime and Vite terminals running: Vite serves the UI and forwards API requests to the runtime on port 7777. The two ports are different entry points to the same local runtime and stored connections.

If that UI is working, you can enter your key there and continue. Vite is optional; for ordinary use, stop it with **Ctrl+C** and follow the build-and-serve steps above to use port 7777 alone.

If Vite reports `EPERM: operation not permitted, rename` under `apps/web/node_modules/.vite`, a dependency-cache rename was denied. The message alone does not identify the cause. If the log subsequently reports successful dependency updates and the app works, continue. If it persists or the page fails, stop Vite and use the build-and-serve path above; retain the exact error if the build also fails. Administrator mode is not a required setup step.

## 6. Enter your API key and choose a model

Enter the key in the **Rig browser application**, not on the runtime status page, in chat, or in a source file. Use an approved gateway/provider API key; GitHub sign-in or Copilot access does not supply a key for this standalone runtime.

1. Open **Models** in the navigation. The page heading is **Model Catalog**.
2. Find **Add a connection**.
3. Select the matching **Gateway profile**. The form initially selects Google Gemini; change it if your key is for Claude, GPT, or a company gateway. For direct Claude access use the Anthropic profile, for direct GPT access use the OpenAI profile, and for a company gateway use its appropriate profile/template.
4. Give it a **Connection name**, such as `work-gateway`.
5. Paste your key into **Key (stored in the OS keychain, never shown again)**. This is a masked password field.
6. For a company gateway/template, enter the company-provided **Base URL override** and, if needed, **Auth header override**. For a direct provider using the matching profile, leave overrides blank unless instructed otherwise. Confirm the selected destination before submitting your key.
7. Click **Add and probe**. This stores the connection and sends provider requests to discover/probe models, which may incur usage. The key field clears after the connection is saved.
8. In the connection's model table, find the desired model with **entitled** status and click **set as default**. If it already has the **default** badge, no action is needed. Rig may have selected an initial default automatically.

If no models appear, or the desired Claude/GPT model is missing, confirm the endpoint and supported model IDs/routes with your gateway administrator. A gateway may require a custom profile or **Add model manually**; do not guess routes from the key alone. One gateway key can cover both Claude and GPT if the gateway exposes both; separate direct providers need separate connections.

The runtime stores credentials in the OS keychain when available and otherwise reports an encrypted-file fallback at startup and in doctor results. The connection card displays only the key's last four characters. You do not need to paste the key again at each startup; Vite and the built UI use the same storage when connected to the same runtime.

## 7. Test approved model access

Once a default model is configured, explicitly test it with:

```powershell
pnpm.cmd rig doctor --probe
```

This probes only the default model through the runtime, may incur provider usage, and updates saved entitlement. A successful entitlement probe can include a provider validation response; it does **not** establish successful streaming or tool execution. Follow it with a short chat and a read-only file task in a test workspace.

## Common messages

| Message | Meaning and next step |
| --- | --- |
| `pnpm.cmd` is not recognized | Restore the PATH line from step 2 in this terminal, or use the full path shown below. |
| `1 package is looking for funding` | Informational npm output; no action required. |
| A newer pnpm version is available | Continue with the repository's pinned version. |
| SQLite `ExperimentalWarning` | Node emitted a feature warning. If doctor's SQLite check passes, this warning did not block it. |
| Data directory “Not created yet” with `PASS` | The nearest existing parent accepted temporary writes. Rig will create its data directory at startup. |
| `WARN certificates` | Additional CA configuration is absent or unverified. Investigate company trust requirements if provider TLS requests fail. |
| `FAIL runtime` | Doctor could not reach a valid Rig health endpoint. Start `rig serve` and inspect startup output; if already running, check the configured URL, port, and local policy. |
| `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `ELIFECYCLE` after doctor | pnpm is reporting doctor's nonzero exit status. Read the preceding `FAIL` line for the underlying diagnostic. |

If pnpm disappeared from a new terminal, this command starts Rig without changing PATH (run it from the repository root):

```powershell
& "$env:LOCALAPPDATA\rig-tools\pnpm.cmd" rig serve
```

If the full path is also missing, check the installation location:

```powershell
Test-Path "$env:LOCALAPPDATA\rig-tools\pnpm.cmd"
```

A `False` result means the launcher is absent from that location; revisit step 2 and any installation error.

## Sharing results and optional developer tests

For structured diagnostics:

```powershell
pnpm.cmd rig doctor --json
```

Doctor's report omits keys, paths, proxy values, and raw provider errors. Review other terminal logs before sharing them. Exit code **1** means a required check failed; **0** means none failed, even if warnings remain. See the [README's CLI documentation](../README.md#cli) for timeout options and further limits.

To validate the repository itself, rather than live provider access:

```powershell
pnpm.cmd typecheck
pnpm.cmd test
```

The test suite uses a mock upstream and does not require model keys or make paid model requests.
