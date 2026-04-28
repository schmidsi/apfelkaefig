#!/bin/bash
set -e

# Build the container image using Docker, then import into Apple Container.
# Apple Container's builder has a networking bug (DNS/403 errors during builds),
# so we build with Docker and shuttle the image via a local registry.

IMAGE_NAME="$(basename "$(cd "$(dirname "$0")" && pwd)")-sandbox"
REGISTRY="localhost:5555"

echo "Building image with Docker..."
docker build -t "$IMAGE_NAME" .devcontainer/

echo "Starting local registry..."
docker run -d --rm --name registry -p 5555:5000 registry:2

echo "Pushing to local registry..."
docker tag "$IMAGE_NAME" "$REGISTRY/$IMAGE_NAME"
docker push "$REGISTRY/$IMAGE_NAME"

echo "Pulling into Apple Container..."
container image pull --scheme http "$REGISTRY/$IMAGE_NAME"
container image tag "$REGISTRY/$IMAGE_NAME" "$IMAGE_NAME"

echo "Stopping registry..."
docker stop registry

echo "Done. Image '$IMAGE_NAME' is ready for Apple Container."
echo "Run ./start.sh to launch."
