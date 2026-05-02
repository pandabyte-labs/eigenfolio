# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/traeky ./cmd/traeky

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/traeky /traeky
VOLUME ["/data"]
EXPOSE 8080
ENV TRAEKY_ADDR=:8080 \
    TRAEKY_MODE=all \
    TRAEKY_DATA_DIR=/data
USER nonroot:nonroot
ENTRYPOINT ["/traeky"]
