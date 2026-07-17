# Step 1: Use Node base image
FROM node:20

# Step 2: Set working directory
WORKDIR /workspace

# Step 3: Copy dependency files
COPY package*.json /workspace/

# Step 4: Install Node dependencies
RUN npm install

# Step 5: Copy all frontend code
COPY . /workspace/

# Step 6: Expose Vite port
EXPOSE 5173

# Step 7: Run frontend dev server
CMD ["npm", "run", "dev", "--", "--host"]