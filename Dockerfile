# Production Dockerfile for Telegram Filestore Bot
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy package descriptors and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy application source code
COPY src/ ./src/

# Default environment configuration
ENV NODE_ENV=production
ENV PORT=8000

# Koyeb routes to port 8000 by default (process.env.PORT is also respected by the app)
EXPOSE 8000

# Run with non-privileged user for enhanced security
USER node

# Start the application
CMD ["node", "src/server.js"]
