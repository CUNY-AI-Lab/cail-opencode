# CUNY AI Lab for OpenCode

Adds CUNY AI Lab to [OpenCode](https://opencode.ai): the lab's models through the CUNY AI Lab Gateway, and **Sign in with CUNY AI Lab** in OpenCode's connect dialog. It works in the OpenCode desktop app and in OpenCode's terminal interface. You need a CUNY AI Lab account with model access.

## Set up

1. Install OpenCode. The desktop app is at [opencode.ai/download](https://opencode.ai/download) for macOS, Windows and Linux.

2. Add the CUNY AI Lab plugin. In a terminal:

   ```text
   opencode plugin add @cuny-ai-lab/cail-opencode@latest
   ```

   OpenCode reloads its plugins by itself. If the desktop app is open and CUNY AI Lab doesn't appear in the next step, choose **Settings › Extensions › Plugins › Reload**, or restart the app.

3. Sign in. In OpenCode, open the providers list, choose **CUNY AI Lab**, then **Sign in with CUNY AI Lab**. Your browser opens the lab's sign-in page. Sign in with your CUNY Login, click **Connect OpenCode**, and go back to OpenCode.

New sessions start on the newest DeepSeek Flash unless you have chosen a default model yourself.

If OpenCode runs on another computer than your browser, for example over SSH, choose **Sign in with CUNY AI Lab using a code** instead. Open the link it shows on any computer, click **Connect OpenCode**, and paste the code the page shows. You can also choose **CUNY AI Lab API key** and paste a personal key from [Model access](https://tools.ailab.gc.cuny.edu/model-access).

## What you get

* **CUNY AI Lab models**, listed live from the gateway, so new models appear without updating anything. The plugin offers the text models that support tool calls, because OpenCode sends its tools with every request. The list is kept for times when the gateway can't be reached.
* **Sign in with CUNY AI Lab.** Signing in creates a personal key named "OpenCode on" and your computer's name, which expires after 180 days. It is listed in [Model access](https://tools.ailab.gc.cuny.edu/model-access), where you can revoke it. Signing in again from the same computer replaces that key.
* **The newest DeepSeek Flash as the default model**, unless you have set one. A `model` in your `opencode.json` always wins.

## Troubleshooting

**CUNY AI Lab isn't in the providers list**
Run `opencode plugin list`. It should show `@cuny-ai-lab/cail-opencode`. If it does, choose **Settings › Extensions › Plugins › Reload** in the desktop app, or restart OpenCode.

**"Your CUNY AI Lab sign-in has expired"**
Keys from signing in last 180 days. Sign in with CUNY AI Lab again.

**"Your CUNY AI Lab access is not active yet"**
Signing in works only for accounts with lab model access. Open [Model access](https://tools.ailab.gc.cuny.edu/model-access) to see how to request it.

**Two "OpenCode on …" accounts**
OpenCode keeps each sign-in as its own account, and plugins can't remove one. After you sign in again, the older account is marked "Replaced by a newer CUNY AI Lab sign-in" and its key no longer works. You can remove it.

## Privacy and security

* OpenCode stores your key in its own credential store on your computer. The plugin sends it only to the CUNY AI Lab gateway, with each model request.
* OpenCode also lists models from other providers, including free models from OpenCode's own service. Only CUNY AI Lab models go through the lab's gateway and its zero-data-retention providers.
* Advanced users can set `AILAB_API_KEY` instead of signing in.

## Updates and removal

Update the plugin with `opencode plugin update @cuny-ai-lab/cail-opencode`. OpenCode also checks for plugin updates when it starts.

Remove it with `opencode plugin remove @cuny-ai-lab/cail-opencode`. To revoke the key it created, use [Model access](https://tools.ailab.gc.cuny.edu/model-access).

---

## For developers

### What the package contains

```text
src/index.ts      the plugin: CUNY AI Lab integration and sign-in methods, provider, default model
src/signin.ts     PKCE, the loopback callback, the copy-code fallback, the key exchange
src/catalog.ts    gateway catalog → OpenCode models
test/unit         bun tests with a fake OpenCode context
test/opencode-smoke.ts  the packed package in a real OpenCode, against test/mock-gateway.ts
test/live.ts      optional check against the real gateway
```

The published package is the compiled `dist/` and has no dependencies. OpenCode's `Plugin.define` only returns its argument, so the plugin exports a plain object and uses `@opencode/plugin` for types alone.

### How it fits OpenCode

* The plugin registers an integration `cail` with four methods: browser sign-in (an OAuth method in `auto` mode with a `127.0.0.1` callback), sign-in with a code (`code` mode), a pasted key, and `AILAB_API_KEY`. Sign-in uses the lab's local-app connect flow with `client=opencode`, documented in the Model Access API README. The returned personal key is stored as an OAuth credential whose expiry is the key's; `refresh` fails with a sign-in-again message once it has expired.
* A new sign-in sends `replace_key_id` with the key from the active sign-in credential, so the lab rotates it. OpenCode stores the new sign-in as a separate account and plugins cannot delete credentials, so the plugin marks the replaced account `needs_auth`. A pasted key is never replaced.
* The provider `cail` uses `@opencode/ai/providers/openai-compatible` at `https://tools.ailab.gc.cuny.edu/v1`, with `activation: "auto"` so it is active once the integration has a credential. Models come from `GET /v1/models` at startup and every 15 minutes, with the last good list kept in plugin storage.
* A model transform sets the newest DeepSeek Flash as the default only when no default is set. Signed out of OpenCode's own service, OpenCode otherwise falls back to the first available model, which can be a free OpenCode model.

### Developing

```bash
bun install
bun run typecheck
bun test test/unit
bun run test:opencode                        # packed plugin in OpenCode 2.2.7, mock gateway
OPENCODE_VERSION=latest bun run test:opencode
CAIL_LIVE_KEY=... bun run test:live          # see below
```

`test:opencode` downloads the OpenCode release named by `opencode.tested` in `package.json` (or `OPENCODE_VERSION`), checks it against the release's `SHA256SUMS`, and runs it with an empty home directory and a minimal environment. It signs in by code and in the browser, lists the models, checks the default, and sends prompts that reach the mock gateway with the signed-in key.

`test:live` reads `CAIL_LIVE_KEY`, passes it to OpenCode as `AILAB_API_KEY` so it never appears in OpenCode's command-line log, and asks the newest DeepSeek Flash for a reply through the real gateway. It uses `OPENCODE_BIN`, or `opencode` on `PATH`.

### Compatibility

OpenCode releases often, and its plugin API is marked experimental. CI runs the smoke test against the pinned version on Linux, macOS and Windows, and the `opencode-latest` workflow runs it every day against the newest 2.x release. When that fails, fix the plugin, raise `opencode.tested`, and release.

### Publishing

Releases are published by GitHub Actions through npm trusted publishing. Bump the version and push the tag from `main`:

```bash
npm version patch
git push --follow-tags
```

The `publish` job in `.github/workflows/ci.yml` runs for `v*` tags after the unit and OpenCode jobs pass, checks the tag against `package.json`, and publishes with provenance. The trusted publisher on npmjs.com is tied to that workflow filename.
