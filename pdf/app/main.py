from __future__ import annotations

import os
from typing import List

import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .pdf_processor import PDFStatementProcessor, merge_tables

app = FastAPI(title="PDF Statement Cleaner")

# Инициализация процессора с ОБЯЗАТЕЛЬНЫМ Adobe API
# Приложение использует только Adobe PDF Services API для конвертации PDF в Excel
ADOBE_CLIENT_ID = os.getenv("ADOBE_CLIENT_ID")
ADOBE_CLIENT_SECRET = os.getenv("ADOBE_CLIENT_SECRET")
ADOBE_CREDENTIALS_FILE = os.getenv("ADOBE_CREDENTIALS_FILE")
ADOBE_REGION = os.getenv("ADOBE_REGION", "US")
ADOBE_CONNECT_TIMEOUT = int(os.getenv("ADOBE_CONNECT_TIMEOUT", "4000")) if os.getenv("ADOBE_CONNECT_TIMEOUT") else None
ADOBE_READ_TIMEOUT = int(os.getenv("ADOBE_READ_TIMEOUT", "10000")) if os.getenv("ADOBE_READ_TIMEOUT") else None

if not ADOBE_CREDENTIALS_FILE and (not ADOBE_CLIENT_ID or not ADOBE_CLIENT_SECRET):
    raise ValueError(
        "Adobe API credentials обязательны! Установите переменные окружения: "
        "ADOBE_CLIENT_ID и ADOBE_CLIENT_SECRET, или ADOBE_CREDENTIALS_FILE"
    )

processor = PDFStatementProcessor(
    client_id=ADOBE_CLIENT_ID,
    client_secret=ADOBE_CLIENT_SECRET,
    credentials_file=ADOBE_CREDENTIALS_FILE,
    region=ADOBE_REGION,
    connect_timeout=ADOBE_CONNECT_TIMEOUT,
    read_timeout=ADOBE_READ_TIMEOUT,
)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return """
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8" />
        <title>Очистка выписки</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 2rem; background: #f6f8fa; }
            h1 { color: #0b3954; }
            form { padding: 1.5rem; background: #fff; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }
            input[type="file"] { margin-bottom: 1rem; }
            button { background: #0b3954; color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 4px; cursor: pointer; }
            button:disabled { opacity: 0.6; cursor: not-allowed; }
            pre { background: #0b3954; color: #fff; padding: 1rem; border-radius: 6px; max-height: 50vh; overflow: auto; }
            .status { margin-top: 1rem; font-weight: bold; }
            .error { color: #b00020; }
            .success { color: #007e33; }
        </style>
    </head>
    <body>
        <h1>Очистка банковских выписок</h1>
        <p>Прикрепите PDF-файлы с выписками и получите JSON только по строкам, где заполнен столбец «Кредит».</p>
        <form id="upload-form">
            <input id="file-input" type="file" name="files" accept="application/pdf" multiple required />
            <br />
            <button id="submit-btn" type="submit">Отправить</button>
        </form>
        <div id="status" class="status"></div>
        <h2>JSON ответ</h2>
        <pre id="result">—</pre>
        <script>
            const form = document.getElementById("upload-form");
            const fileInput = document.getElementById("file-input");
            const result = document.getElementById("result");
            const status = document.getElementById("status");
            const submitBtn = document.getElementById("submit-btn");

            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (!fileInput.files.length) {
                    status.textContent = "Добавьте хотя бы один PDF.";
                    status.className = "status error";
                    return;
                }

                const formData = new FormData();
                for (const file of fileInput.files) {
                    formData.append("files", file);
                }

                submitBtn.disabled = true;
                status.textContent = "Загружаем...";
                status.className = "status";
                result.textContent = "—";

                try {
                    const response = await fetch("/process", {
                        method: "POST",
                        body: formData
                    });
                    
                    if (response.status === 204) {
                        status.textContent = "Нет строк с кредитом.";
                        status.className = "status";
                        result.textContent = "[]";
                        return;
                    }

                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(errorText || "Ошибка загрузки");
                    }

                    const data = await response.json();
                    status.textContent = "Готово.";
                    status.className = "status success";
                    result.textContent = JSON.stringify(data, null, 2);
                } catch (error) {
                    status.textContent = error.message || "Не удалось обработать файл.";
                    status.className = "status error";
                    result.textContent = "—";
                } finally {
                    submitBtn.disabled = false;
                }
            });
        </script>
    </body>
    </html>
    """


@app.post("/process")
async def process_statement(files: List[UploadFile] = File(..., description="Bank statement PDFs")):
    payload = []
    total_files = len(files)
    
    for idx, uploaded_file in enumerate(files, 1):
        print(f"[INFO] Обработка файла {idx}/{total_files}: {uploaded_file.filename}", flush=True)
        
        try:
            if uploaded_file.content_type not in {"application/pdf", "application/octet-stream"}:
                # Пропускаем файлы с неподдерживаемым типом, но добавляем в результат с ошибкой
                payload.append(
                    {
                        "source_file": uploaded_file.filename,
                        "metadata": {},
                        "transactions": [],
                        "error": f"Неподдерживаемый тип файла: {uploaded_file.content_type}",
                    }
                )
                continue

            # Сбрасываем позицию файла на случай, если он уже был прочитан
            await uploaded_file.seek(0)
            contents = await uploaded_file.read()
            
            # Проверяем, что файл не пустой
            if not contents or len(contents) == 0:
                raise ValueError(f"Файл {uploaded_file.filename} пустой или не может быть прочитан")
            
            print(f"[DEBUG] Файл {uploaded_file.filename} прочитан, размер: {len(contents)} байт", flush=True)
            
            extraction = processor.extract(contents, bank_name=uploaded_file.filename)
            frame = merge_tables(extraction.tables)
            transactions = []
            if not frame.empty:
                frame = frame.astype(object).where(pd.notna(frame), None)
                transactions = frame.to_dict(orient="records")

            payload.append(
                {
                    "source_file": uploaded_file.filename,
                    "metadata": extraction.metadata,
                    "transactions": transactions,
                }
            )
            print(f"[INFO] Файл {idx}/{total_files} обработан успешно: найдено {len(transactions)} транзакций", flush=True)
            
        except Exception as e:
            # Обрабатываем ошибки для каждого файла отдельно
            error_message = str(e)
            print(f"[ERROR] Ошибка при обработке файла {uploaded_file.filename}: {error_message}", flush=True)
            import traceback
            print(f"[ERROR] Traceback: {traceback.format_exc()}", flush=True)
            
            payload.append(
                {
                    "source_file": uploaded_file.filename,
                    "metadata": {},
                    "transactions": [],
                    "error": error_message,
                }
            )
            # Продолжаем обработку остальных файлов
            continue

    # Проверяем, есть ли хотя бы один успешно обработанный файл с транзакциями
    successful_files = [item for item in payload if item.get("transactions") and not item.get("error")]
    has_transactions = any(item["transactions"] for item in successful_files)
    
    if not has_transactions and not payload:
        return Response(status_code=204)
    
    # Возвращаем результат даже если есть ошибки (чтобы пользователь видел, что произошло)
    return payload


@app.get("/health")
def healthcheck():
    return {"status": "ok"}
