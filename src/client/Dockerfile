FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Build the compiled React app
RUN npm run build

EXPOSE 4173

# Serve the compiled build (uses src/client/dist/index.html)
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
