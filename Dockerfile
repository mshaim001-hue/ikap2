# Используем официальный образ Node.js с Python
FROM node:20-bullseye

# Устанавливаем системные зависимости для Python и PDF обработки
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json и устанавливаем Node.js зависимости
COPY package*.json ./
RUN npm install

# Копируем и устанавливаем Python зависимости
COPY pdf/requirements.txt ./pdf/requirements.txt
RUN cd pdf && \
    python3 -m pip install --upgrade pip setuptools wheel && \
    python3 -m pip install -r requirements.txt && \
    cd ..

# Копируем остальные файлы
COPY . .

# Собираем фронтенд
RUN npm run build

# Открываем порт (Render.com будет использовать переменную PORT)
EXPOSE 10000

# Устанавливаем переменные окружения
ENV NODE_ENV=production
ENV PDF_SERVICE_PATH=/app/pdf
ENV PYTHON_PATH=python3

# Запускаем приложение
CMD ["npm", "start"]

