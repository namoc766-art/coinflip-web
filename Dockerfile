FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies first for faster Docker layer caching
COPY package*.json ./
RUN npm ci --only=production || npm install --only=production

# Copy application code
COPY . .

# Default Render port and data directory
ENV NODE_ENV=production
ENV PORT=10000
ENV DATA_DIR=/usr/src/app/data

# Create data directory
RUN mkdir -p /usr/src/app/data

EXPOSE 10000

CMD ["node", "server.js"]
