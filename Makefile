.PHONY: all frontend bin install

all: frontend bin

frontend/node_modules: frontend/package.json frontend/package-lock.json
	cd frontend && npm ci
	touch frontend/node_modules

frontend: frontend/node_modules
	cd frontend && npm run build

bin:
	cargo build

install: frontend
	cargo install --path .
