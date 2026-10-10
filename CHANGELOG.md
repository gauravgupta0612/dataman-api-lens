# Changelog

## 1.3.0 - 2026-10-10
- **Mock server**: *Start Mock Server* serves every discovered API locally (default http://localhost:4010) and adds a "Mock" environment. Responses come from saved mocks, then OpenAPI response examples, then responses generated from the request models (POST 201 + id, GET item/list, PUT/PATCH merge, DELETE 204). CORS enabled, optional latency, request log.
- **Save as mock**: one click in the response viewer turns a real response into the mock for that endpoint (`.routinel/mocks.json`, with templates such as `{{params.id}}`, `{{query.page}}`, `{{body.name}}`, `{{$guid}}`).
- **API documentation**: *Open API Documentation* shows a searchable page of all endpoints (parameters, request body, example response, cURL, source location) with Try it / Source buttons; export it as a self-contained HTML page or Markdown.
- OpenAPI/Swagger response examples are now read and used by the mock server and the documentation.

## 1.2.1 - 2026-10-09
- Maintenance release.

## 1.2.0 - 2026-10-10
- **Full code scan for Restlet resource classes**: classes annotated with `@Path` that extend `ServerResource` / `*Resource` and implement `get/post/put/delete` (or Restlet `@Get/@Post/...`), plus `router.attach("/path", XResource.class)`.
- Paths written as Java constants are resolved across files: `@Path(Resources.ORDER)` where `ORDER = STORE + "/orders/{orderid}"`.
- Parameters from resource code: `getQueryValue(...)`, `getQuery().getFirstValue(...)`, request headers, JSON body fields read with `getString/optInt/...` (constant keys resolved), `Form` fields.
- Resources without their own verb methods inherit them from a base class found in the workspace.
- JAX-RS `@Path` values written as constants are resolved too.
- Local editor data (`.routinel/`, `.dataman/`) is never committed.
- When an endpoint exists both in code and in an OpenAPI/Swagger file, they are merged into one entry (code location + documented parameters/examples).
- Ports mentioned in README.md (e.g. localhost:8080) are used for the default environment base URL.

## 1.1.2 - 2026-10-10
- Marketplace publisher changed to `gauravgupta0612` (extension ID is now `gauravgupta0612.routinel`).
- Added repository, homepage and issues links to the extension manifest.

## 1.1.1 - 2026-10-10
- Adding a project (folder, typed path, Git repository or Explorer "Scan Folder for APIs") now asks for a **project name** (defaults to the folder name).
- Quoted / trailing-slash paths are accepted when typing a folder path.
- Package metadata renamed to `routinel` (package.json / package-lock.json).
- Added `release.cmd` and `scripts/release-notes.js` to publish a version (commit, tag, GitHub release with the .vsix).

## 1.1.0
- Renamed to **Routinel**.
- Projects: add any folder or clone a Git repository; its APIs are scanned, saved and kept up to date (Git pull + re-scan, export, open in new window).
- Environment manager UI: base URL, Basic / Bearer / API-key auth per environment (secrets in the OS keychain), variables with a Secret flag.
- Requests default to *Inherit from environment* auth.

## 1.0.0
- First release: multi-language API discovery (JS/TS, Python, Java/Kotlin, C#, Go, PHP, Ruby, Rust, OpenAPI/Swagger, Postman files).
- Postman-like request editor with environments, secrets, auth helpers, all body types, response viewer, code generation.
- Collections, history, Postman v2.1 import/export, OpenAPI 3 export, CodeLens.
