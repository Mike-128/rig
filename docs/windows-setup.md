# Windows installation and testing

Use a normal PowerShell terminal, including the terminal in VS Code. These steps install pnpm in your user folder and do not require administrator mode or changes to PowerShell execution policy. Company application and network policies still apply.

Run commands one step at a time. If a step fails, save its error before continuing.

Already installed? See [the fresh-start sequence](#fresh-start-sequence-after-closing-terminals-or-rebooting). For `unable to get local issuer certificate`, see [Windows certificate trust](#windows-certificate-trust).

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

You can check whether pnpm is installed by calling its full path:

```powershell
& "$env:LOCALAPPDATA\rig-tools\pnpm.cmd" --version
```

This full-path check does **not** replace setting PATH for Rig's scripts. The root `rig` script calls `pnpm` internally, so even a full-path invocation of `rig serve` can fail with “pnpm is not recognized as an internal or external command” unless the PATH line above has been run in the same terminal.

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
7. For APIM, first review the custom-endpoint section below. Then click **Add and probe**. This stores the connection and sends provider requests to discover/probe models, which may incur usage. The key field clears after the connection is saved.
8. In the connection's model table, find the desired model with **entitled** status and click **set as default**. If it already has the **default** badge, no action is needed. Rig may have selected an initial default automatically.

If no models appear, or the desired Claude/GPT model is missing, confirm the endpoint and supported model IDs/routes with your gateway administrator. A gateway may require a custom profile or **Add model manually**; do not guess routes from the key alone. One gateway key can cover both Claude and GPT if the gateway exposes both; separate direct providers need separate connections.

The runtime stores credentials in the OS keychain when available and otherwise reports an encrypted-file fallback at startup and in doctor results. The connection card displays only the key's last four characters. You do not need to paste the key again at each startup; Vite and the built UI use the same storage when connected to the same runtime.

### APIM keys with a custom endpoint

An APIM key goes in the same masked **Key** field. The key alone does not tell Rig which model routes or authentication settings your company uses.

| Field | APIM configuration |
| --- | --- |
| Gateway profile | **Azure API Management gateway (template)**, or a company-specific profile if provided. |
| Connection name | A recognizable local name such as `work-apim`. |
| Key | Your APIM key, without adding a header name around it. |
| Base URL override | The company-provided gateway base URL, including any shared path prefix. |
| Auth header override | Leave blank only if your gateway uses the template default, `Ocp-Apim-Subscription-Key`. Otherwise enter the exact company-specified header name. |

**The APIM template contains example model IDs, deployment paths, and an API version. They are not a discovery of your company's configuration.** Confirm these before relying on the probe results. The template can work as supplied only when those details match the gateway.

Rig constructs the request URL by appending the model's **Route** to the connection's **Base URL**, then applying any model query parameters. For example, if the supplied request URL is:

```text
https://gateway.example.com/ai/openai/deployments/company-gpt/chat/completions?api-version=COMPANY_VERSION
```

one valid split is:

```text
Base URL: https://gateway.example.com/ai
Route:    /openai/deployments/company-gpt/chat/completions
Query:    api-version=COMPANY_VERSION
```

This is an illustration; use the values your company supplies. Do not paste the full completion URL into **Base URL override** while leaving the same completion path in the model route, or the path will be duplicated.

Ask your gateway administrator for a sample request with credentials removed that identifies:

- The full endpoint, including query parameters such as `api-version`.
- The required authentication header and whether a prefix or additional authentication is required.
- The deployment/model identifier and the value sent in the JSON `model` field, if any.
- Whether each endpoint speaks Anthropic Messages or OpenAI Chat Completions.

For a simple model route, the connection's **Add model manually** form provides **Model id**, **Dialect**, **Route**, **Body model override**, and **Query parameters**. For an API version, enter a JSON object such as `{"api-version":"2024-12-01-preview"}`, using the version supplied by your company. These parameters override matching values included in Route. Extra authentication headers still require a company-specific gateway profile or API configuration. Authentication requiring token acquisition/refresh needs separate validation; the APIM template does not implement that flow.

### Correcting a manually added model

In the saved connection's model table, click **Edit** beside a manually added model. The form opens above the table with its saved values. Correct the **Route**, **Query parameters**, **Body model override**, **Dialect**, **Display name**, or token/reasoning settings, then click **Save changes**. **Cancel** leaves the saved configuration unchanged.

The saved model ID remains fixed to preserve agent and alias references. To change the upstream deployment, edit its path in **Route**; to change the request body's model value, use **Body model override**. Leave that override blank to use the saved ID. Use `{}` to clear separate query parameters (also remove any unwanted query from Route).

Saving keeps the connection/key, pricing, and aliases, resets the model to **unprobed**, and clears the previous error. Click **probe** on that row to test the corrected settings. Saving itself does not send a provider request. **Edit** is available for manually added models only.

If you need help mapping a sample request, share the endpoint structure, header names, and example body with all keys/tokens removed. You may anonymize the hostname while preserving paths and query names. Never put a real key into the guide, a Git commit, or a screenshot shared for troubleshooting.

After the actual model routes are configured, probe the intended model and set it as **default**, then continue below.

## 7. Test approved model access

Once a default model is configured, explicitly test it with:

```powershell
pnpm.cmd rig doctor --probe
```

This probes only the default model through the runtime, may incur provider usage, and updates saved entitlement. A successful entitlement probe can include a provider validation response; it does **not** establish successful streaming or tool execution. Follow it with a short chat and a read-only file task in a test workspace.

## 8. Stop and restart Rig

Rig runs in the terminals you start it from. Closing the browser does not stop the runtime. After closing its terminal or rebooting, you must start the runtime again.

### Fresh-start sequence after closing terminals or rebooting

This sequence resolved startup on the work laptop after configuring Windows certificate trust. Stop old Rig and Vite processes with **Ctrl+C** in their respective terminals first. Answer **Y** if asked to terminate the batch job, and wait for the prompt before closing each terminal. Use ordinary PowerShell; administrator mode is not required.

Open a new **runtime terminal**. Run each command separately, pressing **Enter after each**. Replace the example repository path with your clone's actual location, including its final `rig` folder:

```powershell
cd "C:\path\to\rig"
```

```powershell
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
```

For Node versions supporting system CA trust (including the tested Node 25.4), when the company certificate fix below is needed:

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
```

```powershell
pnpm.cmd rig serve
```

Wait for **runtime listening** and leave this terminal running. Do not enter the Vite command into this occupied terminal.

If using the built UI, open [http://127.0.0.1:7777](http://127.0.0.1:7777). If using Vite instead, open a **second terminal**, navigate to the same repository, restore PATH, and start the UI:

```powershell
cd "C:\path\to\rig"
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
pnpm.cmd dev:web
```

Run those lines separately too. Leave both terminals running and open the Local URL Vite prints, normally [http://localhost:5173](http://localhost:5173). In **Models**, probe the manually configured model with the actual company route, rather than relying on the template's example rows.

### Windows certificate trust

`unable to get local issuer certificate` means Node could not build a trusted certificate chain. It does not establish that the API key is invalid. On the tested work laptop, enabling Windows system CA trust changed the unauthenticated root request from a certificate error to **HTTP 404**. That confirmed TLS worked for that request, not model entitlement.

Node supports `NODE_USE_SYSTEM_CA=1` from v22.19.0 and v24.6.0 onward in those release lines, including v25.4.0. Rig's minimum Node 22.13 alone does not guarantee this setting is supported. This uses existing system trust without disabling certificate verification. See [Node's documentation](https://nodejs.org/download/release/v25.9.0/docs/api/cli.html#node_use_system_ca1).

In a spare terminal, set the environment variable and test your approved gateway root. Replace the example hostname; this request sends **no API key**:

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
```

```powershell
node -e "fetch('https://gateway.example.com', {signal: AbortSignal.timeout(10000)}).then(r => console.log('HTTP status:', r.status)).catch(e => { console.log(e.message); console.log(e.cause); })"
```

An HTTP response such as 404 means this request completed TLS but the root resource was not found; a model request uses a different path. If the certificate error remains, obtain the approved CA chain from your company's administrator and confirm whether `NODE_EXTRA_CA_CERTS` is needed. Do not disable TLS verification.

**Apply the setting to the runtime terminal as well.** Setting it in a spare terminal or Vite terminal does not affect an already-running Rig process. Stop Rig, set the variable in its terminal, then start `pnpm.cmd rig serve` again. Repeat the setting in new runtime terminals; it is not permanently saved by these commands. Live model access remains a separate probe/chat check.

### Restart the built application (port 7777)

1. If the runtime is still running, go to its terminal and press **Ctrl+C**. Wait for the PowerShell prompt; if asked to terminate the batch job, answer **Y**. Avoid stopping a run that is still working: interrupted runs are marked failed on the next startup, not automatically resumed.
2. In a normal PowerShell terminal, navigate to your Rig repository. Replace the example path below with your actual clone location:

   ```powershell
   cd "C:\path\to\rig"
   $env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
   pnpm.cmd rig serve
   ```

3. Leave the terminal running and wait for the listening message. Open or reload [http://127.0.0.1:7777](http://127.0.0.1:7777).

Keep the pnpm directory on PATH even if using a full-path launcher: Rig's scripts invoke pnpm internally. If Windows system CA trust was required, set `$env:NODE_USE_SYSTEM_CA = "1"` before starting the runtime, as shown above.

You do **not** need to reinstall dependencies or rebuild the UI for an ordinary restart. If the UI has never been built, follow step 5 first. Your saved connections, keys, agents, and conversation history remain available when you restart under the same Windows account and use the same `RIG_HOME`. Unfinished work does not resume automatically.

If you used custom `RIG_HOME`, `RIG_PORT`, or other environment settings, restore them in the new terminal before starting Rig. Temporary environment settings, including the pnpm PATH line, do not persist across terminals. Use the matching browser port and `RIG_URL` for doctor if you changed the runtime port.

### Restart the Vite development setup (port 5173)

If you were using `pnpm.cmd dev:web`, restart both processes:

1. Stop any existing Vite and runtime processes with **Ctrl+C** in their respective terminals. Wait for each terminal's prompt.
2. In the first terminal, navigate to the repository, restore PATH as above, and run `pnpm.cmd rig serve`.
3. In a second terminal, navigate to the same repository and run:

   ```powershell
   $env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
   pnpm.cmd dev:web
   ```

4. Leave both terminals running. Open the **Local** URL printed by Vite, normally [http://localhost:5173](http://localhost:5173).

Refreshing the browser alone does not restart either server. If startup reports that a port is already in use, check your existing terminals for a running Rig/Vite instance before starting another one.

### Restart after pulling an update

Stop the runtime and Vite first. For a clean checkout on `main`, run these from the repository root, proceeding only when each command succeeds:

```powershell
git pull --ff-only
pnpm.cmd install --frozen-lockfile
pnpm.cmd build
pnpm.cmd rig serve
```

Restore the pnpm PATH line first if this is a new terminal. Rebuilding makes the built browser UI match the updated source. Then reload port 7777. To continue using Vite instead, start `pnpm.cmd dev:web` in the second terminal and open its Local URL.

To check a restarted runtime, run `pnpm.cmd rig doctor` from another terminal with the same repository and environment settings.

## Common messages

| Message | Meaning and next step |
| --- | --- |
| `pnpm.cmd` is not recognized | Restore the PATH line from step 2 in this terminal. |
| `pnpm` is not recognized as an internal or external command | A nested script could not find pnpm. Restore PATH even if you launched the outer command using its full path. |
| `Unexpected token '&'` | Commands may have been combined on one line. Run the environment assignment and launcher as separate commands. |
| `Unexpected token 'rig'` after a quoted executable path | A quoted path alone is a string in PowerShell. Use `pnpm.cmd rig serve` after setting PATH, or prefix a quoted executable path with `&`. |
| `listen EADDRINUSE` | Another process owns the port. Stop the old Rig terminal with Ctrl+C before restarting. Do not stop unrelated Node processes. |
| `unable to get local issuer certificate` | Follow the Windows certificate trust section, then restart Rig from the terminal containing the trust setting. |
| `1 package is looking for funding` | Informational npm output; no action required. |
| A newer pnpm version is available | Continue with the repository's pinned version. |
| SQLite `ExperimentalWarning` | Node emitted a feature warning. If doctor's SQLite check passes, this warning did not block it. |
| Data directory “Not created yet” with `PASS` | The nearest existing parent accepted temporary writes. Rig will create its data directory at startup. |
| `WARN certificates` | Additional CA configuration is absent or unverified. Investigate company trust requirements if provider TLS requests fail. |
| `FAIL runtime` | Doctor could not reach a valid Rig health endpoint. Start `rig serve` and inspect startup output; if already running, check the configured URL, port, and local policy. |
| `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `ELIFECYCLE` after doctor | pnpm is reporting doctor's nonzero exit status. Read the preceding `FAIL` line for the underlying diagnostic. |

If pnpm disappeared from a new terminal, restore PATH and start Rig (run each line separately from the repository root, and restore any required certificate setting first):

```powershell
$env:Path = "$env:LOCALAPPDATA\rig-tools;$env:Path"
pnpm.cmd rig serve
```

If the full path is also missing, check the installation location:

```powershell
Test-Path "$env:LOCALAPPDATA\rig-tools\pnpm.cmd"
```

A `False` result means the launcher is absent from that location; revisit step 2 and any installation error.

If `EADDRINUSE` persists and you cannot find the old terminal, identify the listener with this read-only command (use your actual runtime port if different):

```powershell
Get-NetTCPConnection -LocalPort 7777 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Identify the owning process before deciding how to stop it. Closing a browser tab or restarting Vite does not release the runtime's port.

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
