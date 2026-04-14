.PHONY: dev dev-detach dev-down dev-clean prod prod-detach prod-down prod-clean logs ps build-plugins cleanup-dev-containers cleanup-dev-volumes help

# -- Dev ----------------------------------------------------------------------

dev:					## Start dev environment (Next.js HMR + hot-reload API)
	docker compose -f docker-compose.dev.yml up --build

dev-detach:				## Start dev environment in the background
	docker compose -f docker-compose.dev.yml up --build -d

dev-down:				## Stop and remove dev containers
	docker compose -f docker-compose.dev.yml down
	$(MAKE) cleanup-dev-containers

dev-clean:				## Stop dev and wipe volumes (fresh DB)
	docker compose -f docker-compose.dev.yml down -v
	$(MAKE) cleanup-dev-containers
	$(MAKE) cleanup-dev-volumes

# -- Prod ---------------------------------------------------------------------

prod:					## Start production stack
	docker compose up --build

prod-detach:			## Start production stack in the background
	docker compose up --build -d

prod-down:				## Stop and remove prod containers
	docker compose down

prod-clean:				## Stop prod and wipe volumes (fresh DB)
	docker compose down -v

# -- Utilities ----------------------------------------------------------------

logs:					## Tail logs (dev). Pass s=<service> to filter: make logs s=panel
	docker compose -f docker-compose.dev.yml logs -f $(s)

ps:					## Show running containers
	docker compose -f docker-compose.dev.yml ps

build-plugins:			## Rebuild plugin images only (dev)
	docker compose -f docker-compose.dev.yml build keycloak-plugin-build authentik-plugin-build components-plugin-build

cleanup-dev-containers:		## Remove all remaining Kleff dev containers
	@docker rm -f $$(docker ps -aq --filter "network=kleff-local") >/dev/null 2>&1 || true
	@docker rm -f $$(docker ps -aq --filter "name=kleff") >/dev/null 2>&1 || true

cleanup-dev-volumes:		## Remove all volumes with "kleff" in the name
	@docker volume rm $$(docker volume ls -q --filter "name=kleff") >/dev/null 2>&1 || true

# -- Help ---------------------------------------------------------------------

help:					## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*##"}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
