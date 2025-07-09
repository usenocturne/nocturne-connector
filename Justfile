connector-api:
    cd src && rm -f connector-api && GOOS=linux GOARCH=arm64 go build -ldflags "-s -w" -o connector-api

run: connector-api
    sudo ./build.sh

lint:
    pre-commit run --all-files
