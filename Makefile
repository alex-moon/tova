.PHONY: install build clean

# Root workflow wrappers
install:
	npm install
	npm run install:client

build:
	npm run build:client

clean:
	rm -rf src/client/dist
	rm -rf node_modules
	rm -rf src/client/node_modules
