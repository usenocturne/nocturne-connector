connector-api:
    cd src && bun install && bun run check && bun run build

run: connector-api
    sudo ./build.sh

test:
    scripts/services/connector-data-grow.test.sh
    bun test scripts/bin/uboot_tool.test.ts
    cd src && bun test

lint:
    pre-commit run --all-files

docker-qemu:
    docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

docker-build:
    docker build -t nocturne-connector-builder .

docker-run: docker-build
    docker run --rm --privileged -v "$PWD/output:/work/output" -v "$PWD/cache:/work/cache" nocturne-connector-builder

windows-server:
    bun windows/scripts/generate-bridge-types.ts
    cd src && bun run build
    bun windows/scripts/build-server.ts

windows-host-check:
    cargo check --manifest-path windows/Cargo.toml

windows-host-test:
    cargo test --release --manifest-path windows/Cargo.toml

windows-test:
    cd src && bun test
    cargo test --release --manifest-path windows/Cargo.toml

windows-check: windows-host-check
    cd src && bun run check

windows-universal: windows-server
    powershell -NoProfile -ExecutionPolicy Bypass -File windows/scripts/build-universal.ps1
