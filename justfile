all: fonts frontend bin

fonts:
    mkdir -p fonts/pbf
    build_pbf_glyphs --overwrite --combinations fonts/combinations.json fonts/ fonts/pbf/

frontend:
    cd frontend && npm run build

bin:
    cargo build
