# Настройка Docker на Render.com

## Проблема
На Render.com при использовании Node.js окружения, Python зависимости, установленные через `--user`, могут не сохраняться между build и runtime.

## Решение: Docker

Docker гарантирует, что все зависимости установлены и доступны во время выполнения.

## Инструкция по настройке Docker на Render.com

1. **Войдите в панель Render.com** и откройте ваш сервис `ikap-backend`

2. **Перейдите в Settings** → **Environment**

3. **Выберите "Docker"** вместо "Node"

4. **Укажите Dockerfile Path**: `./Dockerfile`

5. **Сохраните изменения**

6. Render.com автоматически пересоберет сервис с использованием Docker

## Альтернатива: Ручная настройка Python зависимостей

Если Docker недоступен, можно попробовать:

1. В панели Render.com → Settings → Build & Deploy
2. Добавить в Build Command:
   ```bash
   python3 -m pip install --user -r pdf/requirements.txt
   ```
3. Убедиться, что переменная окружения `PYTHONPATH` включает путь к user site-packages

## Проверка

После деплоя проверьте логи:
- Должно быть: `Python dependencies installed successfully`
- При конвертации PDF должно быть: `✅ PDF конвертирован в JSON`

