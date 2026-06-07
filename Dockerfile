FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy server code
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
