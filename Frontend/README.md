# iKapitalist · Frontend для анализа выписок

Одностраничное приложение для сотрудников iKapitalist. Интерфейс позволяет:

- загружать банковские выписки и передавать их бэкенд-агенту на анализ;
- отслеживать прогресс обработки и переписку с агентом в режиме реального времени;
- просматривать историю заявок и готовые отчёты, сохранённые в базе данных PostgreSQL.

## Быстрый старт

```bash
cd Frontend
npm install
npm run dev
```

Приложение доступно на `http://localhost:5173`. При локальной разработке настройте переменные окружения (см. ниже), чтобы проксировать запросы на развернутый backend.

## Переменные окружения

В корне `Frontend` создайте файл `.env` или `.env.local` и задайте необходимые переменные:

| Переменная | Назначение | Пример |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Базовый URL backend-сервиса (Render, локальный сервер и т. д.) | `https://ikap-backend.onrender.com` |
| `VITE_ANALYSIS_ENDPOINT` | (Опционально) кастомный путь для запуска анализа | `/api/analysis` |
| `VITE_REPORTS_ENDPOINT` | (Опционально) путь для получения истории и деталей отчётов | `/api/reports` |
| `VITE_APP_BASE_PATH` | Базовый путь для деплоя на GitHub Pages; укажите `/<repository-name>` | `/ikap-frontend` |

Если дополнительные переменные не заданы, используются значения по умолчанию (`/api/analysis`, `/api/reports`, `/`).

## Скрипты npm

- `npm run dev` — старт локального dev-сервера с HMR.
- `npm run build` — production-сборка в каталог `dist`.
- `npm run preview` — предпросмотр собранной версии.
- `npm run lint` — запуск ESLint с актуальными правилами React Hooks и Fast Refresh.

## Деплой на GitHub Pages

1. Убедитесь, что в `.env` указаны нужные переменные `VITE_API_BASE_URL` и `VITE_APP_BASE_PATH`.
2. Выполните сборку:
   ```bash
   npm run build
   ```
3. Опубликуйте содержимое папки `dist` в ветку `gh-pages` (или используйте GitHub Actions/Pages Deploy Action).
4. В настройках репозитория включите GitHub Pages и выберите ветку `gh-pages`.

## Подключение к backend

- Backend ожидается на Render (`https://<your-app>.onrender.com`) и использует PostgreSQL `postgresql://postgres:2114343Rr@db.orfmzhidcswcxrmnsxut.supabase.co:5432/postgres`.
- Фронтенд отправляет файлы и комментарий через `POST VITE_ANALYSIS_ENDPOINT`. Ответ должен содержать `sessionId` и текущий статус анализа.
- Для получения истории и детализации фронтенд обращается к `GET VITE_REPORTS_ENDPOINT` и `GET VITE_REPORTS_ENDPOINT/:sessionId` (дополнительно `/messages`).

Структура ответов может быть адаптирована на сервере — фронтенд обрабатывает как "плоский" формат (`[]`, `{}`), так и вложенный (`{ data: [] }`, `{ data: {...} }`).
