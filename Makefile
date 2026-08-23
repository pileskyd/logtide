.PHONY: help setup install build dev test clean docker-dev docker-prod migrate seed

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## Run initial setup
	@bash scripts/setup.sh

install: ## Install dependencies
	@bun install

build: ## Build all packages
	@bun run build

build-shared: ## Build shared package only
	@bun run build:shared

dev: ## Start development servers
	@bun run dev

dev-backend: ## Start backend only
	@bun run dev:backend

dev-frontend: ## Start frontend only
	@bun run dev:frontend

dev-worker: ## Start worker only
	@bun run --filter '@logtide/backend' dev:worker

test: ## Run tests
	@bun run test

typecheck: ## Run TypeScript type checking
	@bun run typecheck

clean: ## Clean build artifacts
	@bun run clean
	@rm -rf node_modules packages/*/node_modules

docker-dev: ## Start development databases (PostgreSQL + Redis)
	@docker-compose -f docker/docker-compose.dev.yml up -d

docker-dev-stop: ## Stop development databases
	@docker-compose -f docker/docker-compose.dev.yml down

docker-prod: ## Start full production stack
	@docker-compose -f docker/docker-compose.yml up -d --build

docker-prod-stop: ## Stop production stack
	@docker-compose -f docker/docker-compose.yml down

docker-logs: ## View Docker logs
	@docker-compose -f docker/docker-compose.yml logs -f

migrate: ## Run database migrations
	@bun run --filter '@logtide/backend' migrate

migrate-down: ## Rollback last migration
	@bun run --filter '@logtide/backend' migrate:down

seed: ## Seed database with sample data
	@bash scripts/seed-data.sh
