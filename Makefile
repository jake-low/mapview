.PHONY: all frontend bin

all: frontend bin

frontend:
	cd frontend && npm run build

bin:
	cargo build

install: frontend
	cargo install --path .
