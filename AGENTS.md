# Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- To use eslint install eslint from terminal: `npm install -g eslint`
- To use eslint to analyze this project use this command: `eslint main.ts`
- eslint will then create a report with suggestions for code improvement by file and line number.
- If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder: `eslint ./src/`

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
  ```
  src/
    main.ts           # Plugin entry point, lifecycle management
    settings.ts       # Settings interface and defaults
    commands/         # Command implementations
      command1.ts
      command2.ts
    ui/              # UI components, modals, views
      modal.ts
      view.ts
    utils/           # Utility functions, helpers
      helpers.ts
      constants.ts
    types.ts         # TypeScript interfaces and types
  ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

### Local sync smoke test

- The local Convex deployment is configured in `.env.local` as `CONVEX_URL=http://127.0.0.1:3210` and `CONVEX_SITE_URL=http://127.0.0.1:3211`.
- If `obsidian --help` fails with `Cannot find module 'electron'`, run Obsidian CLI commands with `ELECTRON_RUN_AS_NODE` unset: `env -u ELECTRON_RUN_AS_NODE obsidian help`.
- Known local test vaults can be listed with `env -u ELECTRON_RUN_AS_NODE obsidian vaults verbose`.
- There are two vaults named `convex-sync`; `vault=convex-sync` currently resolves to `/home/shlok/Documents/Programming/Sandbox/convex-sync`.
- The build copies plugin artifacts into both local dev vaults by default: `/home/shlok/Documents/Programming/Sandbox/convex-sync/.obsidian/plugins/obsidian-convex-sync` and `/home/shlok/Downloads/convex-sync/.obsidian/plugins/obsidian-convex-sync`.
- To reset local Convex data for a destructive smoke test, run the guarded debug mutation in batches: `npx convex run --push debug:wipeBatch '{"confirm":"WIPE_LOCAL_DEV_DB"}'` until it returns `{"deleted":0}`. Only do this against the local dev deployment unless the user explicitly requests otherwise.
- After wiping Convex and deleting plugin data, disable and enable the plugin with `env -u ELECTRON_RUN_AS_NODE obsidian plugin:disable id=obsidian-convex-sync filter=community vault=convex-sync` and `env -u ELECTRON_RUN_AS_NODE obsidian plugin:enable id=obsidian-convex-sync filter=community vault=convex-sync`.
- The plugin API key can be minted without UI using Obsidian eval: `env -u ELECTRON_RUN_AS_NODE obsidian eval vault=convex-sync code="(async()=>{const p=app.plugins.plugins['obsidian-convex-sync']; await p.mintVaultSecretFromDeployment(); return JSON.stringify(p.settings);})()"`.
- If the plugin was enabled before the key existed, reload live sync after minting: `env -u ELECTRON_RUN_AS_NODE obsidian eval vault=convex-sync code="(async()=>{const p=app.plugins.plugins['obsidian-convex-sync']; await p.reloadLiveSync(); return 'reloaded';})()"`.
- Trigger a local edit with the CLI, for example `env -u ELECTRON_RUN_AS_NODE obsidian append path="First Note.md" content="smoke test" vault=convex-sync`, then run the plugin command with `env -u ELECTRON_RUN_AS_NODE obsidian command id=obsidian-convex-sync:sync-vault-files vault=convex-sync` if live sync does not fire immediately.
- Inspect sync state with `npx convex data fileManifests --limit 20 --format json`, `npx convex data globalChanges --limit 20 --format json`, and `npx convex logs --history 20`.
- Attach CLI console capture before debugging plugin runtime errors: `env -u ELECTRON_RUN_AS_NODE obsidian dev:debug on vault=convex-sync`, then read logs with `env -u ELECTRON_RUN_AS_NODE obsidian dev:console limit=100 vault=convex-sync` and `env -u ELECTRON_RUN_AS_NODE obsidian dev:errors vault=convex-sync`.
- Trigger bootstrap from the plugin settings tab with `env -u ELECTRON_RUN_AS_NODE obsidian eval vault=convex-sync code="(async()=>{const tab=app.setting.pluginTabs.find(t=>t.plugin?.manifest?.id==='obsidian-convex-sync'); await tab.startBootstrapFlow(); return JSON.stringify(tab.bootstrapState);})()"`.
- Check bootstrap status with `npx convex run bootstrap:getStatus '{"convexSecret":"<secret>"}'`. Download a ready archive from `http://127.0.0.1:3211` plus the returned `downloadUrl`.
- To register an extracted bootstrap vault with the Obsidian CLI, add it to `~/.config/obsidian/obsidian.json` and run `env -u ELECTRON_RUN_AS_NODE obsidian restart`; after restart, `obsidian vaults verbose` should show the folder name as a unique vault.
- A wipe exposed and fixed an important backend invariant: public queries cannot insert documents. `fileSync:listChangesSince` must tolerate a missing `syncHead` by returning `headCursor: 0`; mutations that advance cursors create `syncHead` via `nextCursor`.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):
```ts
import { Plugin } from "obsidian";
import { MySettings, DEFAULT_SETTINGS } from "./settings";
import { registerCommands } from "./commands";

export default class MyPlugin extends Plugin {
  settings: MySettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    registerCommands(this);
  }
}
```

**settings.ts**:
```ts
export interface MySettings {
  enabled: boolean;
  apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
  enabled: true,
  apiKey: "",
};
```

**commands/index.ts**:
```ts
import { Plugin } from "obsidian";
import { doSomething } from "./my-command";

export function registerCommands(plugin: Plugin) {
  plugin.addCommand({
    id: "do-something",
    name: "Do something",
    callback: () => doSomething(plugin),
  });
}
```

### Add a command

```ts
this.addCommand({
  id: "your-command-id",
  name: "Do the thing",
  callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(this.app.workspace.on("file-open", f => { /* ... */ }));
this.registerDomEvent(window, "resize", () => { /* ... */ });
this.registerInterval(window.setInterval(() => { /* ... */ }, 1000));
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`. 
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide

<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->
