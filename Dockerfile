# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY src/client/package*.json ./src/client/

# Install dependencies
RUN npm install
RUN cd src/client && npm install

# Copy source
COPY . .

# Build both frontend and backend
RUN cd src/client && npm run build
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies.
# --ignore-scripts skips the root postinstall (`npm --prefix src/client install`):
# the client's package.json is not present in this stage (only its dist is copied),
# so running the hook would fail with ENOENT.
RUN npm install --omit=dev --ignore-scripts

# Copy built assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/client/dist ./src/client/dist

# Expose port
EXPOSE 5000

# Set environment variables
ENV NODE_ENV=production

# Start the server
CMD ["npm", "start"]
