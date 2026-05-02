.PHONY: fmt test vet build docker run

fmt:
	gofmt -w ./cmd ./internal

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -trimpath -o bin/traeky ./cmd/traeky

docker:
	docker build -t traeky:local .

run:
	TRAEKY_MODE=all TRAEKY_ADDR=:8080 TRAEKY_DATA_DIR=./data go run ./cmd/traeky
