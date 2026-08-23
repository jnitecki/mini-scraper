IMAGE_TAG=v1.62.1-noble
podman build -t mini-scraper:$IMAGE_TAG-arm64 --platform linux/arm64  --build-arg "IMAGE_TAG=$IMAGE_TAG" -f Docker/dockerfile Docker/Files/
podman build -t mini-scraper:$IMAGE_TAG-amd64 --platform linux/amd64  --build-arg "IMAGE_TAG=$IMAGE_TAG" -f Docker/dockerfile Docker/Files/
podman manifest rm -i mini-scraper:$IMAGE_TAG
podman manifest create mini-scraper:$IMAGE_TAG
podman manifest add mini-scraper:$IMAGE_TAG mini-scraper:$IMAGE_TAG-arm64
podman manifest add mini-scraper:$IMAGE_TAG mini-scraper:$IMAGE_TAG-amd64
podman tag mini-scraper:$IMAGE_TAG docker.io/jnitecki/mini-scraper:$IMAGE_TAG
podman tag mini-scraper:$IMAGE_TAG mini-scraper:latest
podman tag mini-scraper:latest docker.io/jnitecki/mini-scraper:latest
podman manifest push docker.io/jnitecki/mini-scraper:$IMAGE_TAG
podman manifest push docker.io/jnitecki/mini-scraper:latest

