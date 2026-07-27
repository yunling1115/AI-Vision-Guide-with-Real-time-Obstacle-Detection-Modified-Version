# Step 1: Use Python base image (lighter than Ubuntu)
FROM python:3.10-slim
#Based on Debian Linux (slim version)
#Very lightweight
#Common for backend (FastAPI, AI, etc.)

# Step 2: Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Step 3: Install system dependencies (for OpenCV, etc.)
RUN apt-get update && apt-get install -y \
    curl wget git \
    libgl1 libglib2.0-0 \
    && apt-get clean

# Step 4: Set working directory
WORKDIR /workspace

# Pre-trust torch.hub repos used by MiDaS to avoid interactive y/N prompt
RUN mkdir -p /root/.cache/torch/hub && \
    printf "intel-isl_MiDaS\nrwightman_gen-efficientnet-pytorch\n" > /root/.cache/torch/hub/trusted_list

# Step 5: Copy dependency file
COPY requirements.txt /workspace/

# Step 6: Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Step 7: Copy all backend code
COPY . /workspace/

# Step 8: Expose FastAPI port
EXPOSE 8080
#EXPOSE 8080 merely informs anyone reading the Dockerfile (or certain tooling) that "this container intends to serve traffic on port 8080." 
#It is purely documentation/intent—it does not actually open the port, nor does it force the container to listen on it.

# Step 9: Run FastAPI server
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
#"If the PORT environment variable exists, use its value; if it doesn't, fall back to the default value of 8080."