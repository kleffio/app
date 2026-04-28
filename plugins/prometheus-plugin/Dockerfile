# ── Stage 1: Build frontend JS bundle ─────────────────────────────────────────
FROM node:22-alpine AS frontend-builder

RUN apk add --no-cache git

WORKDIR /frontend

COPY prometheus-plugin/frontend/package.json ./
RUN npm install

COPY prometheus-plugin/frontend/ ./
RUN npm run build

# ── Stage 2: Build Go binary ──────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Build context is the plugins/ directory so we can access the local SDK.
COPY plugin-sdk-go /plugin-sdk-go
COPY prometheus-plugin/go.mod prometheus-plugin/go.sum ./
RUN go mod download

COPY prometheus-plugin/ .

# Overwrite the placeholder with the real frontend bundle so //go:embed resolves.
COPY --from=frontend-builder /frontend/dist/index.js ./cmd/plugin/dist/index.js

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /plugin ./cmd/plugin

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache ca-certificates
COPY --from=builder /plugin /plugin

EXPOSE 50051 3001
ENTRYPOINT ["/plugin"]
