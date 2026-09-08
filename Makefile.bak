# Variables
APP_NAME = vf

.PHONY: run build deploy

# Default task
run:
	npm install
	npm dev

build:
	npm build

deploy:
	ssh -t ajmoon "\
		if [[ ! -d '/opt/$(APP_NAME)' ]]; then \
			mkdir -p /opt/$(APP_NAME); \
			cd /opt/$(APP_NAME); \
			git clone https://github.com/alex-moon/$(APP_NAME) .; \
		fi; \
		cd /opt/$(APP_NAME); \
		git reset --hard origin/main; \
		git pull origin \$$(git rev-parse --abbrev-ref HEAD); \
		npm install; \
		npm run build; \
		docker compose build; \
		docker stack deploy -c docker-compose.yml $(APP_NAME); \
		docker run --rm -i \
			-v /var/run/docker.sock:/var/run/docker.sock \
			-u root ubirak/docker-php:latest \
			stack:converge $(APP_NAME); \
		docker system prune -f \
	"

