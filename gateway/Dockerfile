# Use Node.js 20 Alpine for a small footprint
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the gateway port
EXPOSE 3000

# Start the application
CMD ["node", "app.js"]
