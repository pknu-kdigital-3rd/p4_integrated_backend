FROM nginx:1.27-alpine

RUN apk add --no-cache openssl
COPY docker/nginx-entrypoint.sh /usr/local/bin/p4-nginx-entrypoint

ENTRYPOINT ["/bin/sh", "/usr/local/bin/p4-nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
