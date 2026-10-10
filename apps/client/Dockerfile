# Stage 1: build the compiled React app
FROM node:22-alpine

WORKDIR /app

COPY src/client/package*.json /app/src/client/
COPY src/shared /app/src/shared

RUN npm ci --prefix /app/src/client

COPY src/client /app/src/client

RUN npm run build --prefix /app/src/client

# Stage 2: serve the static build with nginx
FROM nginx:alpine

COPY src/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=0 /app/src/client/dist /usr/share/nginx/html

EXPOSE 4173
