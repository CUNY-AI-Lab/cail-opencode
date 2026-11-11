# cail-opencode agent notes

Product and developer documentation is in README.md.

- Use bun for installs, tests and builds. The published package is `dist/` only and must stay free of runtime dependencies; `@opencode/plugin` is for types.
- OpenCode's plugin API is experimental and changes often. Keep the plugin to the integration, provider and model transforms it uses now. Before raising `opencode.tested` in `package.json`, run `bun run test:opencode` against the new version, and read the OpenCode release notes for changes to integrations, providers, models or credentials.
- The daily `opencode-latest` workflow is the early warning for a breaking OpenCode release. Treat its failure as a release task: fix the plugin, raise `opencode.tested`, and publish.
- Never log, print or put in command-line arguments a sign-in code, PKCE verifier or key. OpenCode's CLI log records its arguments, which is why the live test passes the key through `AILAB_API_KEY`.
- The sign-in server side is the Model Access API's connect flow in CUNY-AI-Lab/cail-tools-proxy. The client name is `opencode`; keys are named "OpenCode on <device>" and a new sign-in only replaces a key named for the same app.
- Install instructions use `opencode plugin add @cuny-ai-lab/cail-opencode@latest`, so a reinstall always reaches the newest release.
