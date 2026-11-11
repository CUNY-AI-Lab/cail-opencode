# cail-opencode agent notes

Product and developer documentation is in README.md.

- Use bun for installs, tests and builds. The published package is `dist/` only and must stay free of runtime dependencies; `@opencode/plugin` is for types.
- OpenCode's plugin API is experimental and changes often. Keep the plugin to the integration, provider and model transforms it uses now. Before raising `opencode.tested` in `package.json`, run `bun run test:opencode` against the new version, and read the OpenCode release notes for changes to integrations, providers, models or credentials.
- The daily `opencode-latest` workflow is the early warning for a breaking OpenCode release. Treat its failure as a release task: fix the plugin, raise `opencode.tested`, and publish.
- Never log, print or put in command-line arguments a sign-in code, PKCE verifier or key. OpenCode's CLI log records its arguments, which is why the live test passes the key through `AILAB_API_KEY`.
- The sign-in server side is the Model Access API's connect flow in CUNY-AI-Lab/cail-tools-proxy. The client name is `opencode`; keys are named "OpenCode on <device>" and a new sign-in only replaces a key named for the same app.
- Install instructions run `plugin add @cuny-ai-lab/cail-opencode@latest` with the CLI bundled in the desktop app, so people who only installed the app need nothing else. OpenCode records the spec as written, so `plugin update` with `@latest` reaches the newest release. Keep `@latest`.
- The bundled CLI path is internal to the desktop app: `/Applications/OpenCode.app/Contents/Resources/opencode-cli` on macOS and `%LOCALAPPDATA%\Programs\ai.opencode.desktop\resources\opencode-cli.exe` on Windows (checked with 2.2.7). Recheck both when OpenCode changes its packaging. Keep the package name quoted in the PowerShell line, where an unquoted argument starting with `@` can be read as splatting.
- OpenCode 2.2.7 does not update plugins by itself: a restart kept the old version, `plugin check` reported the update, and only `plugin update` installed it. `plugin list` can print "No plugins found" before the server has loaded plugins, so use `plugin check` to confirm an install.
