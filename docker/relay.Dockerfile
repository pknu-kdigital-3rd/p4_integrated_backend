FROM golang:1.22-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/media-relay .

FROM alpine:3.21
RUN addgroup -S relay && adduser -S -G relay relay
RUN mkdir -p /run/p4/relay \
    && chown relay:relay /run/p4/relay
COPY --from=build /out/media-relay /media-relay
EXPOSE 39012
USER relay
ENTRYPOINT ["/media-relay"]
