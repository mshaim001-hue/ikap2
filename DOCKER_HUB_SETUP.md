# Настройка деплоя через Docker Hub на Render.com

## Преимущества использования Docker Hub

- ✅ Быстрый деплой (образ уже собран)
- ✅ Надежность (все зависимости включены)
- ✅ Возможность версионирования образов
- ✅ Проще отладка (можно тестировать образ локально)

## Шаг 1: Сборка и загрузка образа в Docker Hub

### Вариант A: Использование скрипта (рекомендуется)

```bash
# Установите переменные окружения (опционально)
export DOCKER_USERNAME=your-dockerhub-username
export IMAGE_NAME=ikap2-backend
export VERSION=latest

# Сделайте скрипт исполняемым
chmod +x docker-build.sh

# Запустите скрипт
./docker-build.sh
```

### Вариант B: Ручная сборка

```bash
# 1. Войдите в Docker Hub
docker login

# 2. Соберите образ
docker build -t YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest .

# 3. Загрузите в Docker Hub
docker push YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest
```

## Шаг 2: Настройка на Render.com

### Способ 1: Через render.yaml (автоматически)

Раскомментируйте и обновите строку в `render.yaml`:

```yaml
services:
  - type: web
    name: ikap-backend
    dockerImage: YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest
    # ... остальные настройки
```

### Способ 2: Через панель Render.com (вручную)

1. Войдите в панель Render.com → ваш сервис `ikap-backend`
2. Перейдите в **Settings** → **Environment**
3. Выберите **"Docker"**
4. В поле **"Docker Image"** укажите: `YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest`
5. Сохраните изменения

## Шаг 3: Обновление образа

При изменении кода:

```bash
# Пересоберите и загрузите новый образ
./docker-build.sh

# Или вручную:
docker build -t YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest .
docker push YOUR_DOCKERHUB_USERNAME/ikap2-backend:latest
```

Render.com автоматически обнаружит изменения и пересоберет сервис (если настроен auto-deploy).

## Версионирование образов

Для версионирования используйте теги:

```bash
# Сборка с версией
docker build -t YOUR_DOCKERHUB_USERNAME/ikap2-backend:v1.0.0 .
docker push YOUR_DOCKERHUB_USERNAME/ikap2-backend:v1.0.0

# В render.yaml укажите:
dockerImage: YOUR_DOCKERHUB_USERNAME/ikap2-backend:v1.0.0
```

## Проверка

После деплоя проверьте логи:
- Должно быть: `🚀 Backend iKapitalist запущен на порту`
- При конвертации PDF должно быть: `✅ PDF конвертирован в JSON`

## Локальное тестирование

Перед загрузкой в Docker Hub можно протестировать образ локально:

```bash
# Сборка
docker build -t ikap2-backend:local .

# Запуск
docker run -p 10000:10000 \
  -e OPENAI_API_KEY=your-key \
  -e DATABASE_URL=your-db-url \
  -e ADOBE_CLIENT_ID=your-id \
  -e ADOBE_CLIENT_SECRET=your-secret \
  ikap2-backend:local
```

## Troubleshooting

### Ошибка: "unauthorized: authentication required"
- Выполните `docker login` перед push

### Ошибка: "denied: requested access to the resource is denied"
- Проверьте, что имя образа совпадает с вашим Docker Hub username

### Render.com не находит образ
- Убедитесь, что образ публичный или у Render.com есть доступ к вашему Docker Hub аккаунту

