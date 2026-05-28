# Using the latest Apify Playwright image with Chrome
FROM apify/actor-node-playwright-chrome:20

# Copy package files
COPY package*.json ./

# Install packages, skip optional and dev to keep the image small
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "npm install finished"

# Copy source code
COPY . ./

# Run the actor
CMD npm start
