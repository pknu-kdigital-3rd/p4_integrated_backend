FROM golang:1.22-bookworm AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/media-relay .

FROM alpine:3.21
RUN apk add --no-cache su-exec \
    && addgroup -S relay \
    && adduser -S -G relay relay
RUN mkdir -p /run/p4/relay \
    && mkdir -p /var/tmp/p4-recordings \
    && chown -R relay:relay /run/p4/relay /var/tmp/p4-recordings
COPY --from=build /out/media-relay /media-relay
COPY relay-entrypoint.sh /usr/local/bin/p4-relay-entrypoint
RUN chmod 755 /usr/local/bin/p4-relay-entrypoint
EXPOSE 39012
ENTRYPOINT ["/usr/local/bin/p4-relay-entrypoint"]
CMD ["/media-relay"]
