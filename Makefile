# Task runner.
#
# Node's own task runner is `pnpm run`, and every target below delegates to a
# package.json script rather than reimplementing it — one definition, usable
# from either entrypoint. The Makefile exists so this repo answers to the same
# `make test` / `make lint` / `make hooks-install` muscle memory as the sibling
# python-ai and go-ai repos.

PNPM ?= pnpm

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install workspace dependencies from the lockfile
	@echo "Installing dependencies..."
	$(PNPM) install --frozen-lockfile

.PHONY: hooks-install
hooks-install: ## Install the pre-commit + pre-push git hooks
	@echo "Installing git hooks..."
	$(PNPM) run prepare

.PHONY: hooks-uninstall
hooks-uninstall: ## Remove the git hooks
	@echo "Uninstalling git hooks..."
	git config --unset core.hooksPath || true

.PHONY: hooks-run
hooks-run: ci ## Run everything the pre-push hook runs

# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

.PHONY: format
format: ## Rewrite files with Prettier
	@echo "Formatting with Prettier..."
	$(PNPM) run format

.PHONY: format-check
format-check: ## Fail if Prettier would change anything (what CI runs)
	@echo "Checking formatting..."
	$(PNPM) run format:check

.PHONY: lint
lint: ## Lint with ESLint
	@echo "Linting with ESLint..."
	$(PNPM) run lint

.PHONY: lint-fix
lint-fix: ## Lint and apply fixes
	$(PNPM) run lint:fix

.PHONY: typecheck
typecheck: ## Type check the whole workspace (tsc --build)
	@echo "Type checking with tsc..."
	$(PNPM) run typecheck

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

.PHONY: build
build: ## Build every package (ESM + CJS + .d.ts)
	@echo "Building packages..."
	$(PNPM) run build

.PHONY: clean
clean: ## Remove build, type and coverage output
	@echo "Cleaning build output..."
	$(PNPM) run clean

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

.PHONY: test
test: ## Run unit tests (excludes integration — this is the PR gate)
	@echo "Running unit tests..."
	$(PNPM) run test:unit

.PHONY: test-cov
test-cov: ## Run unit tests with a coverage report
	@echo "Running unit tests with coverage..."
	$(PNPM) run test:cov

.PHONY: test-watch
test-watch: ## Run unit tests in watch mode
	$(PNPM) run test:watch

.PHONY: test-integration
test-integration: ## Run integration tests (needs a Dapr sidecar; Ollama for e2e)
	@echo "Running integration tests..."
	$(PNPM) run test:integration

.PHONY: test-guards
test-guards: build ## Run the two invariants CI enforces directly
	@echo "Running guard tests..."
	$(PNPM) run test:guards

.PHONY: test-all
test-all: test test-integration ## Run both test lanes

# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

.PHONY: ci
ci: format-check lint typecheck build test ## Run everything CI runs on a PR

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'
