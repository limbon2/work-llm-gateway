# Repository Guidelines

## Project Structure & Module Organization
This repository is currently a minimal scaffold with no application code checked in yet. Keep the root clean and organize new work using a predictable layout:
- `src/` for application code
- `tests/` for automated tests
- `scripts/` for developer and CI helpers
- `docs/` for design notes and operational runbooks

Prefer small, focused modules. Use feature-oriented paths (for example, `src/gateway/auth/` instead of large shared utility files).

## Build, Test, and Development Commands
No build system or test runner is configured yet in this workspace snapshot. In early setup PRs, add a single entry point for standard tasks (typically a `Makefile` or package scripts) and document it here.

Until tooling is added, useful inspection commands are:
- `ls -la` to view root contents
- `find . -maxdepth 3 -type f` to list tracked files

## Coding Style & Naming Conventions
Use 4 spaces for indentation in Python and 2 spaces for YAML/JSON/Markdown. Keep lines reasonably short (target <= 100 chars).

Naming conventions:
- Files/modules: `snake_case`
- Classes/types: `PascalCase`
- Functions/variables: `snake_case` (or language-idiomatic equivalent)
- Environment variables: `UPPER_SNAKE_CASE`

Add formatter/linter config with the first language-specific code (for example, `ruff`/`black`, `eslint`/`prettier`, or equivalent).

## Testing Guidelines
Place tests under `tests/` and mirror source paths (for example, `src/gateway/router.py` -> `tests/gateway/test_router.py`).

Minimum expectations:
- Add or update tests for every behavior change
- Cover success, edge, and failure paths
- Keep tests deterministic and fast

## Commit & Pull Request Guidelines
No Git history is available in this snapshot, so use Conventional Commits by default (for example, `feat: add request router`, `fix: handle timeout parsing`).

PRs should include:
- Clear summary of what changed and why
- Linked issue/task (if applicable)
- Test evidence (command + result)
- Notes on config, migration, or rollout impact

## Security & Configuration Tips
Do not commit secrets. Store local overrides in `.env.local` and commit only sanitized examples (for example, `.env.example`).
