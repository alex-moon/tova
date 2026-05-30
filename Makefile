.PHONY: install build start dev test lint format docker-up docker-down docker-build clean

# Installation
install:
	npm install
	cd src/client && npm install

# Build
build:
	npm run build
	cd src/client && npm run build

# Development
dev:
	npm run dev

dev-server:
	npm run dev:server

dev-client:
	npm run dev:client

# Start production build
start:
	npm start

# Testing
test:
	npm test

# Linting and Formatting
lint:
	npm run lint
	cd src/client && npm run lint

format:
	npm run format
	cd src/client && npm run format

# Docker
docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-build:
	docker-compose build

# Cleanup
clean:
	rm -rf dist
	rm -rf src/client/dist
	rm -rf node_modules
	rm -rf src/client/node_modules
