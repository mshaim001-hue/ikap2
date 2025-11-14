# Очистка банковских выписок из PDF через Adobe PDF Services API

Веб-приложение для обработки банковских выписок: **PDF → Adobe API → XLSX → обработка → JSON**

## Как это работает

1. **Пользователь загружает PDF файлы** через веб-интерфейс
2. **PDF отправляется в Adobe PDF Services API** для конвертации в Excel (XLSX)
3. **Adobe API возвращает XLSX файл** с таблицами из PDF
4. **Приложение обрабатывает Excel** и извлекает строки с заполненным столбцом "Кредит"
5. **Возвращается JSON** с отфильтрованными транзакциями

## Архитектура

```
[Веб-интерфейс] 
    ↓ (загрузка PDF)
[FastAPI сервер]
    ↓ (отправка PDF)
[Adobe PDF Services API]
    ↓ (возврат XLSX)
[Обработка Excel/DataFrame]
    ↓ (фильтрация по кредиту)
[JSON ответ]
```

## Установка

### 1. Установите зависимости

```bash
python -m venv .venv
source .venv/bin/activate  # на Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Настройте Adobe API credentials

**Обязательно!** Приложение работает ТОЛЬКО с Adobe PDF Services API.

Установите переменные окружения:

```bash
export ADOBE_CLIENT_ID=6fb148a7095c48c297bc275bebcae3d4
export ADOBE_CLIENT_SECRET=ваш_client_secret_здесь
```

Или используйте credentials файл:

```bash
export ADOBE_CREDENTIALS_FILE=/path/to/pdfservices-api-credentials.json
```

**Опциональные настройки:**

```bash
export ADOBE_REGION=US  # или EU
export ADOBE_CONNECT_TIMEOUT=4000
export ADOBE_READ_TIMEOUT=10000
```

Подробная инструкция: [ADOBE_API_SETUP.md](ADOBE_API_SETUP.md)

### 3. Запустите приложение

```bash
uvicorn app.main:app --reload
```

После запуска API доступно по адресу `http://127.0.0.1:8000`

## Использование

### Веб-интерфейс

1. Откройте `http://127.0.0.1:8000` в браузере
2. Прикрепите один или несколько PDF файлов
3. Нажмите "Отправить"
4. Получите JSON с отфильтрованными транзакциями

### API

**POST /process** - обработка PDF файлов

```bash
curl -X POST "http://127.0.0.1:8000/process" \
  -F "files=@statement1.pdf" \
  -F "files=@statement2.pdf"
```

**GET /health** - проверка статуса сервиса

```bash
curl http://127.0.0.1:8000/health
```

## Зависимости

- **pdfservices-sdk** - Adobe PDF Services API SDK (обязательно)
- **fastapi** - веб-фреймворк
- **pandas** - обработка данных
- **openpyxl** - работа с Excel файлами
- **pdfplumber** - извлечение метаданных из PDF (только для чтения заголовков)

## Важно

- **Adobe API обязателен** - без credentials приложение не запустится
- **Платный сервис** - Adobe PDF Services API требует подписки (есть пробный период)
- **Fallback отсутствует** - если Adobe API недоступен, приложение выдаст ошибку

## CLI

Для локальной обработки (требует Adobe credentials):

```bash
python -m app.cli path/to/statement1.pdf path/to/statement2.pdf --json
```

## Лицензия

См. LICENSE файл (если есть)
