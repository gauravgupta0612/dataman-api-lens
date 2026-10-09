# Routinel

**Find every API in your code — and call it, Postman‑style, without leaving VS Code.**

Routinel scans your workspace, automatically discovers every HTTP endpoint **in any supported language**, works out its **path / query / header / body parameters** (including sample JSON bodies built from your DTOs / models), and opens each one in a built‑in **Postman‑like request client**. The same client also works on its own as a third‑party HTTP client for any URL.

> Screenshots: see the `docs/` folder of the source.

## Features

| | |
|---|---|
| 🔍 **Automatic API discovery** | Scans the whole workspace on startup and re-scans changed files on save. Routes are shown in the **Routinel** activity-bar view, grouped by file, framework, language, resource or method. |
| 🧩 **Parameters detected from code** | Path variables, query params, headers, cookies, form fields, file uploads and JSON bodies — with types and *required* flags. Request bodies are generated from your classes (Java POJOs/records, Kotlin data classes, C# classes/records, TypeScript classes/interfaces/zod, Pydantic/marshmallow/DRF serializers, Go structs with `json` tags, Rust serde structs, Laravel validation rules, Rails strong params). |
| 🧭 **Prefix resolution** | Understands router mounting and prefixes: `app.use('/api', router)`, Nest `setGlobalPrefix`, Spring `server.servlet.context-path`, class-level `@RequestMapping`, `[Route("api/[controller]")]`, FastAPI `include_router(prefix=…)`, Flask blueprints, Django `include()`, DRF routers, Gin/Echo/Fiber groups, chi `Route`/`Mount`, Laravel groups & `routes/api.php`, Rails `namespace`/`resources`, Axum `nest`, Actix `scope`, Ktor `route {}`. |
| 📮 **Postman-like client** | Method, URL, Params, Path Variables, Headers, Body (JSON, Text, XML, x-www-form-urlencoded, multipart form-data with files), Auth (Bearer, Basic, API key), response viewer with pretty JSON, headers, cookies and the request actually sent. |
| 🌍 **Environments & variables** | `{{baseUrl}}`, `{{token}}`… per environment. A *Local* environment is created automatically with the port detected from your code/config. Dynamic variables: `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomEmail}}`. |
| 🔐 **Secrets** | *Routinel: Set Secret Variable* stores values in the OS keychain (VS Code SecretStorage) — never written to disk. Auth values typed in clear text are stripped from history. |
| 🔗 **Chain requests** | *Save to variable* takes a value from a JSON response (e.g. `data.token`) and stores it in the active environment. |
| 📚 **Collections & history** | Save requests into collections (folders supported) stored in `.routinel/collections.json` so they can be shared through git. Every sent request is kept in History. |
| ↔️ **Import / export** | Import and export **Postman v2.1** collections; export all discovered APIs as a Postman collection or as an **OpenAPI 3** document. |
| 🧑‍💻 **Code generation** | cURL, PowerShell, JavaScript `fetch`, Python `requests`, `.http` file. |
| ▶️ **CodeLens** | A `▶ GET /users/:id` lens above every detected route opens it in the client; `cURL` copies it. |

## Supported languages & frameworks

| Language | Frameworks / sources |
|---|---|
| JavaScript / TypeScript | Express, Koa (koa-router), Fastify, Hono, Elysia, Restify, NestJS, Next.js (App Router `route.ts` and `pages/api`) |
| Python | FastAPI, Flask (+ Blueprints, flask-restx, Flask-RESTful), Quart, Sanic, Litestar, Django (urls.py, class-based views), Django REST Framework (routers, ViewSets, `@action`) |
| Java / Kotlin | Spring MVC & WebFlux (incl. functional routes), JAX-RS (Jakarta, Quarkus, Jersey, RESTEasy), Micronaut, Ktor |
| C# | ASP.NET Core controllers (attribute routing, `[controller]`/`[action]` tokens), Minimal APIs (`MapGet`, `MapGroup`) |
| Go | net/http (incl. Go 1.22 `"GET /items/{id}"`), gorilla/mux, Gin, Echo, Fiber, chi |
| PHP | Laravel (routes, groups, `resource`/`apiResource`, FormRequest rules), Symfony (`#[Route]` / `@Route`), Slim, Lumen |
| Ruby | Rails (`config/routes.rb`: resources, nested, member/collection, namespace, scope), Sinatra |
| Rust | Axum, Actix-web, Rocket |
| Specs | OpenAPI 3.x and Swagger 2.0 (JSON/YAML, `$ref` resolution), Postman collections found in the repo |

Ports for the default environment are read from `app.listen()`, `server.port`, `launchSettings.json`, `.env` `PORT=`, `uvicorn.run(port=…)`, `r.Run(":8080")`, OpenAPI `servers`, etc.

## Projects — scan any folder or Git repository

You don't have to open a project in VS Code to see its APIs. Click **Add Project** (📚 icon in the *Discovered APIs* title bar) and choose:

- **Choose a folder…** / **Type or paste a folder path…** – any folder on your computer (e.g. `C:\src\orders-service`)
- **Clone a Git repository…** – HTTPS or SSH URL (+ optional branch); Routinel clones it with your installed `git`, then scans it

Each project is **saved** (in VS Code's global storage) with its discovered APIs, so it appears in every window and after restarts, and is re-scanned automatically when its files change. Right-click a project for **Re-scan**, **Git Pull and Re-scan**, **Save APIs to a Collection**, **Export as Postman / OpenAPI**, **Open in New Window**, **Rename** or **Remove** (files on disk are never deleted).
You can also right-click any folder in the Explorer → **Scan Folder for APIs**, or list folders in the `routinel.projects.paths` setting. Set `routinel.scan.workspace` to `false` to show *only* the locations you provided.

## Environments — base URL, username/password, tokens

**Routinel: Manage Environments** (⚙ next to the environment picker, or the status bar `🌐 Local` → *Manage environments…*) opens a form where each environment has:

- **Base URL** (`{{baseUrl}}`)
- **Authorization**: No Auth, **Basic Auth (username / password)**, Bearer Token or API Key. Every request whose Auth tab is **Inherit from environment** (the default) uses it — switch environment to call the same APIs as another user or on another server.
- **Variables** table – tick **Secret** for passwords/tokens. Passwords, tokens, API-key values and secret variables are stored in the OS keychain (VS Code SecretStorage), never in `environments.json`.

## Getting started

1. Install the extension (see below) and open a project folder.
2. Click the **Routinel** icon in the activity bar — your APIs appear under **Discovered APIs**.
3. Click an endpoint (or the ▶ CodeLens in the source) → the request editor opens with URL, parameters and a sample body pre-filled.
4. Pick/edit the environment (status bar `🌐 Local`), then **Send** (`Ctrl+Enter`). **Save** (`Ctrl+S`) stores it in a collection.

Use **Routinel: New Request** (`Ctrl+Alt+N`) to call any URL, like Postman. **Routinel: Search Discovered APIs** (`Ctrl+Alt+A`) jumps to any endpoint.

## Files created in your workspace

```
.routinel/
  environments.json        # environments & variables (shareable)
  environments.local.json  # optional per-machine overrides (git-ignored)
  collections.json         # saved collections (shareable)
  .gitignore
```

> Keep tokens and passwords out of `environments.json` — use **Set Secret Variable** instead.

## Settings

| Setting | Default | Description |
|---|---|---|
| `routinel.scan.workspace` | `true` | Scan the folder open in VS Code (turn off to use only your projects) |
| `routinel.projects.paths` | `[]` | Folders always scanned as projects |
| `routinel.projects.cloneFolder` | `""` | Default parent folder for cloned repositories |
| `routinel.scan.onStartup` | `true` | Scan when VS Code starts |
| `routinel.scan.autoRescan` | `true` | Re-scan files when they change |
| `routinel.scan.includeTests` | `false` | Also scan test files/folders |
| `routinel.scan.excludeFolders` | `[]` | Extra folder names to skip |
| `routinel.scan.exclude` | `""` | Extra exclude glob |
| `routinel.scan.maxFiles` / `maxFileSizeKB` | `20000` / `768` | Scan limits |
| `routinel.groupBy` | `file` | Default grouping |
| `routinel.codeLens.enabled` | `true` | ▶ Send lens above routes |
| `routinel.http.timeoutMs` | `30000` | Request timeout |
| `routinel.http.rejectUnauthorized` | `true` | Set to `false` for self-signed certificates |
| `routinel.http.followRedirects` | `true` | Follow redirects |
| `routinel.http.cookieJar` | `true` | Keep cookies per host |

## Install

**From the VSIX:** Extensions view → `…` menu → **Install from VSIX…** → choose `routinel-1.1.0.vsix`,
or run `code --install-extension routinel-1.1.0.vsix`.

**From source:**

```bash
npm install
npm test                 # scanner + HTTP client unit tests
npx @vscode/vsce package # builds routinel-<version>.vsix
```

Press `F5` in this folder to launch an Extension Development Host.

## How detection works

Detection is static (no code is executed): each language module strips comments, finds route registrations with framework-aware patterns, reads handler signatures and bodies to infer parameters, and indexes models/DTOs across the workspace. A second pass resolves router mounts and prefixes across files. Anything dynamic (routes built from variables at runtime) may not be detected — you can always add it as a request in a collection.

## Privacy

Everything runs locally inside VS Code. Requests go only to the URLs you send them to; nothing is sent anywhere else.

## Releasing a new version

1. Bump `version` in `package.json` (and `package-lock.json`).
2. Add a `## x.y.z - date` section at the top of `CHANGELOG.md`.
3. Run `release.cmd` (Windows). It builds `routinel-x.y.z.vsix`, commits as **gauravgupta0612**, tags `vx.y.z`, pushes to GitHub and — if the GitHub CLI (`gh`) is installed — creates the GitHub Release with the `.vsix` and the changelog notes attached.

Optional, VS Code Marketplace: create the publisher `routinel` at https://marketplace.visualstudio.com/manage, create an Azure DevOps Personal Access Token (scope *Marketplace → Manage*), then run `npx @vscode/vsce login routinel` once and `npx @vscode/vsce publish` for each version.
