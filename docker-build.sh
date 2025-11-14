#!/bin/bash
# Скрипт для сборки и загрузки Docker образа в Docker Hub

set -e

# Настройки
DOCKER_USERNAME="${DOCKER_USERNAME:-mshaim001-hue}"
IMAGE_NAME="${IMAGE_NAME:-ikap2-backend}"
VERSION="${VERSION:-latest}"

FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}:${VERSION}"

echo "🐳 Сборка Docker образа: ${FULL_IMAGE_NAME}"
echo "📦 Платформа: linux/amd64 (для Render.com)"

# Сборка образа для платформы linux/amd64 (требуется для Render.com)
docker build --platform linux/amd64 -t "${FULL_IMAGE_NAME}" .

echo "✅ Образ собран успешно"

# Загрузка в Docker Hub (если указан DOCKER_PASSWORD или выполнен docker login)
if [ -n "${DOCKER_PASSWORD}" ] || docker info | grep -q "Username:"; then
    echo "📤 Загрузка образа в Docker Hub..."
    docker push "${FULL_IMAGE_NAME}"
    echo "✅ Образ загружен в Docker Hub: ${FULL_IMAGE_NAME}"
else
    echo "⚠️  Для загрузки в Docker Hub выполните:"
    echo "   docker login"
    echo "   docker push ${FULL_IMAGE_NAME}"
fi

echo ""
echo "📋 Для использования на Render.com:"
echo "   1. В панели Render.com → Settings → Environment"
echo "   2. Выберите 'Docker'"
echo "   3. Укажите Docker Image: ${FULL_IMAGE_NAME}"
echo "   4. Или используйте render.yaml с dockerImage"

