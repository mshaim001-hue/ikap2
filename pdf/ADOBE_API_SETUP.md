# Настройка Adobe PDF Services API

Это руководство поможет вам настроить интеграцию с Adobe PDF Services API для конвертации PDF в Excel.

## О Adobe PDF Services API

Adobe PDF Services API — это платный облачный сервис для работы с PDF. Он предоставляет:
- Конвертацию PDF в Excel (XLSX)
- Высокое качество извлечения таблиц
- Облачную обработку (не требует локальных ресурсов)

**Важно:** Это платный сервис. Доступен бесплатный пробный период для тестирования.

## Шаги настройки

### 1. Регистрация на Adobe Developer Console

1. Перейдите на [Adobe Developer Console](https://developer.adobe.com/console)
2. Войдите или создайте учетную запись Adobe
3. Создайте новый проект
4. Добавьте API: **PDF Services API**

### 2. Получение учетных данных

У вас есть два варианта:

#### Вариант А: Использование credentials.json (рекомендуется)

1. В Adobe Developer Console нажмите "Generate Credentials" для PDF Services API
2. Скачайте файл `pdfservices-api-credentials.json`
3. Сохраните файл в безопасном месте (например, в корне проекта, но НЕ добавляйте в git!)

#### Вариант Б: Использование Client ID и Client Secret

1. В Adobe Developer Console найдите ваш проект
2. Скопируйте **Client ID** и **Client Secret**

### 3. Установка SDK

Установите Adobe PDF Services SDK:

```bash
pip install pdfservices-sdk
```

### 4. Настройка переменных окружения

Выберите один из способов настройки:

#### Способ 1: credentials.json файл

Создайте файл `.env` в корне проекта:

```env
USE_ADOBE_API=true
ADOBE_CREDENTIALS_FILE=/path/to/pdfservices-api-credentials.json
```

Или установите переменную окружения напрямую:

```bash
export USE_ADOBE_API=true
export ADOBE_CREDENTIALS_FILE=/path/to/pdfservices-api-credentials.json
```

#### Способ 2: Client ID и Secret

Создайте файл `.env`:

```env
USE_ADOBE_API=true
ADOBE_CLIENT_ID=your_client_id_here
ADOBE_CLIENT_SECRET=your_client_secret_here
```

**Пример с реальным Client ID:**

```bash
export USE_ADOBE_API=true
export ADOBE_CLIENT_ID=6fb148a7095c48c297bc275bebcae3d4
export ADOBE_CLIENT_SECRET=your_client_secret_here
```

**ВАЖНО:** Client ID в примере выше приведен только для демонстрации. Используйте ваш собственный Client ID и никогда не публикуйте Client Secret!

### 5. Дополнительные настройки (опционально)

#### Настройка региона обработки

По умолчанию используется регион `US` (США). Для обработки в Европе установите:

```bash
export ADOBE_REGION=EU
```

Доступные регионы:
- `US` - United States (по умолчанию)
- `EU` - Europe

#### Настройка таймаутов

По умолчанию используются:
- `connect_timeout`: 4000 мс (4 секунды)
- `read_timeout`: 10000 мс (10 секунд)

Для изменения таймаутов:

```bash
export ADOBE_CONNECT_TIMEOUT=6000  # 6 секунд
export ADOBE_READ_TIMEOUT=20000    # 20 секунд
```

### 6. Безопасность

**ВНИМАНИЕ:** Никогда не коммитьте credentials.json или Client Secret в git!

Добавьте в `.gitignore`:

```
# Adobe credentials
pdfservices-api-credentials.json
*.credentials.json
.env
```

**ВАЖНО:** Client ID (API Key) можно публиковать, но Client Secret должен оставаться секретным!

### 7. Запуск приложения

После настройки переменных окружения запустите приложение:

```bash
uvicorn app.main:app --reload
```

Приложение автоматически обнаружит настройки Adobe API и будет использовать его для конвертации PDF.

## Как это работает

1. **Если Adobe API включен:** Приложение сначала пытается конвертировать PDF в Excel через Adobe API
2. **Fallback:** Если Adobe API недоступен или возникает ошибка, приложение автоматически переключается на локальную обработку (pdfplumber, tabula, camelot)
3. **Обработка:** Полученный Excel файл обрабатывается для извлечения строк с заполненным столбцом "Кредит"

### Полный пример настроек

```bash
# Включить Adobe API
export USE_ADOBE_API=true

# Учетные данные (выберите один из вариантов)
export ADOBE_CLIENT_ID=6fb148a7095c48c297bc275bebcae3d4
export ADOBE_CLIENT_SECRET=your_secret_here

# Или используйте credentials файл
# export ADOBE_CREDENTIALS_FILE=./pdfservices-api-credentials.json

# Опционально: регион (US или EU)
export ADOBE_REGION=US

# Опционально: таймауты (в миллисекундах)
export ADOBE_CONNECT_TIMEOUT=4000
export ADOBE_READ_TIMEOUT=10000
```

## Проверка работы

1. Загрузите PDF файл через веб-интерфейс
2. Проверьте метаданные в ответе: `extraction_method` должен быть `"adobe_pdf_services_api"`

## Отключение Adobe API

Если вы хотите использовать только локальную обработку:

```bash
export USE_ADOBE_API=false
```

Или просто не устанавливайте переменные окружения — по умолчанию Adobe API выключен.

## Стоимость и лимиты

- **Пробный период:** Обычно включает ограниченное количество бесплатных запросов
- **Тарифы:** Проверьте актуальные тарифы на сайте Adobe
- **Лимиты:** Обратите внимание на лимиты запросов в минуту/день

## Устранение проблем

### Ошибка: "Adobe PDF Services SDK не установлен"

Установите SDK:
```bash
pip install pdfservices-sdk
```

### Ошибка: "Adobe API не настроен"

Проверьте переменные окружения:
```bash
echo $USE_ADOBE_API
echo $ADOBE_CREDENTIALS_FILE
# или
echo $ADOBE_CLIENT_ID
```

### Ошибка: "ServiceApiException" или "ServiceUsageException"

- Проверьте правильность учетных данных
- Убедитесь, что у вас не исчерпан лимит запросов
- Проверьте подключение к интернету

### Adobe API недоступен, используется fallback

Это нормально! Приложение автоматически переключается на локальную обработку, если Adobe API недоступен.

## Дополнительная информация

- [Документация Adobe PDF Services API](https://developer.adobe.com/document-services/docs/overview/pdf-services-api/)
- [Python SDK GitHub](https://github.com/adobe/pdfservices-sdk-python)
- [Примеры кода](https://developer.adobe.com/document-services/docs/apis/pdf-services/convert-pdf/)

