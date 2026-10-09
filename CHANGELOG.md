# Changelog

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
