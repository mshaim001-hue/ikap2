"""Интеграция с Adobe PDF Services API для конвертации PDF в Excel."""
from __future__ import annotations

import io
import os
import re
import tempfile
import time
import requests
from pathlib import Path
from typing import Optional

import pandas as pd

try:
    from adobe.pdfservices.operation.auth.credentials import Credentials
    from adobe.pdfservices.operation.client_config import ClientConfig
    from adobe.pdfservices.operation.exception.exceptions import ServiceApiException, ServiceUsageException, SdkException
    from adobe.pdfservices.operation.execution_context import ExecutionContext
    from adobe.pdfservices.operation.io.file_ref import FileRef
    from adobe.pdfservices.operation.region import Region
    
    # Попробуем импортировать старую структуру (SDK < 2.3)
    try:
        from adobe.pdfservices.operation.pdfjobs.params.exportpdf.export_pdf_params import ExportPDFParams
        from adobe.pdfservices.operation.pdfjobs.params.exportpdf.export_pdf_target_format import ExportPDFTargetFormat
        from adobe.pdfservices.operation.pdfjobs.pdf_jobs import PDFJobs
        from adobe.pdfservices.operation.pdfjobs.result.export_pdf_result import ExportPDFResult
        USE_PDFJOBS = True
    except ImportError:
        # В SDK 2.3 структура изменилась - нужно использовать REST API напрямую
        USE_PDFJOBS = False
        ExportPDFParams = None  # type: ignore
        ExportPDFTargetFormat = None  # type: ignore
        PDFJobs = None  # type: ignore
        ExportPDFResult = None  # type: ignore

    ADOBE_AVAILABLE = True
except ImportError:
    ADOBE_AVAILABLE = False
    Region = None  # type: ignore
    USE_PDFJOBS = False


class AdobePDFService:
    """Класс для работы с Adobe PDF Services API."""

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        credentials_file: Optional[str] = None,
        region: Optional[str] = None,
        connect_timeout: Optional[int] = None,
        read_timeout: Optional[int] = None,
    ) -> None:
        """
        Инициализация сервиса Adobe PDF Services.

        Args:
            client_id: Adobe Client ID (или берется из переменной окружения ADOBE_CLIENT_ID)
            client_secret: Adobe Client Secret (или берется из переменной окружения ADOBE_CLIENT_SECRET)
            credentials_file: Путь к файлу credentials.json (или берется из переменной окружения ADOBE_CREDENTIALS_FILE)
            region: Регион обработки ('US' или 'EU', по умолчанию 'US')
            connect_timeout: Таймаут подключения в миллисекундах (по умолчанию 4000)
            read_timeout: Таймаут чтения в миллисекундах (по умолчанию 10000)
        """
        if not ADOBE_AVAILABLE:
            raise ImportError(
                "Adobe PDF Services SDK не установлен. "
                "Установите его командой: pip install pdfservices-sdk"
            )

        self._credentials_file = credentials_file or os.getenv("ADOBE_CREDENTIALS_FILE")
        self._client_id = client_id or os.getenv("ADOBE_CLIENT_ID")
        self._client_secret = client_secret or os.getenv("ADOBE_CLIENT_SECRET")
        self._region = region or os.getenv("ADOBE_REGION", "US")
        self._connect_timeout = connect_timeout or int(os.getenv("ADOBE_CONNECT_TIMEOUT", "4000"))
        self._read_timeout = read_timeout or int(os.getenv("ADOBE_READ_TIMEOUT", "10000"))

        import sys
        print(f"[ADOBE_SERVICE] Проверка credentials...", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] credentials_file: {self._credentials_file or 'не установлен'}", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] client_id: {'✅ установлен' if self._client_id else '❌ не установлен'}", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] client_secret: {'✅ установлен' if self._client_secret else '❌ не установлен'}", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] region: {self._region}", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] connect_timeout: {self._connect_timeout}ms", file=sys.stderr, flush=True)
        print(f"[ADOBE_SERVICE] read_timeout: {self._read_timeout}ms", file=sys.stderr, flush=True)
        
        if not self._credentials_file and (not self._client_id or not self._client_secret):
            error_msg = (
                "Необходимо указать либо credentials_file, либо client_id и client_secret. "
                "Можно также использовать переменные окружения: "
                "ADOBE_CREDENTIALS_FILE или ADOBE_CLIENT_ID/ADOBE_CLIENT_SECRET"
            )
            print(f"[ADOBE_SERVICE] ❌ {error_msg}", file=sys.stderr, flush=True)
            raise ValueError(error_msg)
        
        print(f"[ADOBE_SERVICE] ✅ Credentials проверены успешно", file=sys.stderr, flush=True)
        self._execution_context: Optional[ExecutionContext] = None

    def _get_execution_context(self) -> ExecutionContext:
        """Получить или создать ExecutionContext для работы с API."""
        if self._execution_context is None:
            if self._credentials_file:
                credentials = Credentials.service_principal_credentials_builder().from_file(
                    self._credentials_file
                ).build()
            else:
                credentials = Credentials.service_principal_credentials_builder().with_client_id(
                    self._client_id
                ).with_client_secret(
                    self._client_secret
                ).build()

            # Создаем ClientConfig с настройками таймаутов и региона
            # Согласно документации Python SDK использует конструктор напрямую
            client_config_kwargs = {
                "connect_timeout": self._connect_timeout,
                "read_timeout": self._read_timeout,
            }

            # Добавляем регион, если указан и доступен
            if Region is not None:
                try:
                    region_enum = Region.US if self._region.upper() == "US" else Region.EU
                    client_config_kwargs["region"] = region_enum
                except (AttributeError, ValueError):
                    # Если не удалось установить регион, используем по умолчанию (US)
                    pass

            # Попробуем создать через конструктор (как в документации Python)
            try:
                client_config = ClientConfig(**client_config_kwargs)
            except (TypeError, AttributeError):
                # Fallback на builder pattern, если конструктор не поддерживается
                client_config = ClientConfig.builder().with_connect_timeout(
                    self._connect_timeout
                ).with_read_timeout(
                    self._read_timeout
                ).build()

            self._execution_context = ExecutionContext.create(credentials, client_config)

        return self._execution_context

    def _get_access_token(self) -> str:
        """Получить access token для REST API."""
        import sys
        token_url = "https://pdf-services.adobe.io/token"
        print(f"[ADOBE_SERVICE] Запрос access token с {token_url}...", file=sys.stderr, flush=True)
        
        try:
            response = requests.post(
                token_url,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data={
                    "client_id": self._client_id,
                    "client_secret": self._client_secret
                },
                timeout=10
            )
            print(f"[ADOBE_SERVICE] Ответ на запрос token: статус {response.status_code}", file=sys.stderr, flush=True)
            response.raise_for_status()
            token_data = response.json()
            print(f"[ADOBE_SERVICE] ✅ Access token получен успешно", file=sys.stderr, flush=True)
            return token_data["access_token"]
        except Exception as e:
            print(f"[ADOBE_SERVICE] ❌ Ошибка получения access token: {e}", file=sys.stderr, flush=True)
            if hasattr(e, 'response') and e.response is not None:
                print(f"[ADOBE_SERVICE] Ответ сервера: {e.response.text[:500]}", file=sys.stderr, flush=True)
            raise

    def _upload_asset(self, access_token: str, pdf_bytes: bytes, filename: Optional[str] = None) -> str:
        """
        Шаг 2: Загрузить PDF файл как asset и получить assetID.
        
        Returns:
            assetID для использования при создании job
        """
        # Базовый URL для API
        if self._region.upper() == "EU":
            base_url = "https://pdf-services-eu.adobe.io"
        else:
            base_url = "https://pdf-services.adobe.io"
        
        headers = {
            "Authorization": f"Bearer {access_token}",
            "X-API-Key": self._client_id,
            "Content-Type": "application/json"
        }
        
        # Шаг 2.1: Получаем pre-signed URI для загрузки
        import sys
        print(f"[INFO] Получение pre-signed URI для загрузки PDF...", file=sys.stderr, flush=True)
        response = requests.post(
            f"{base_url}/assets",
            headers=headers,
            json={"mediaType": "application/pdf"},
            timeout=30
        )
        response.raise_for_status()
        asset_data = response.json()
        
        upload_uri = asset_data.get("uploadUri")
        asset_id = asset_data.get("assetID")
        
        if not upload_uri or not asset_id:
            raise Exception(f"Не удалось получить uploadUri или assetID: {asset_data}")
        
        print(f"[INFO] Asset ID получен: {asset_id}. Загрузка файла...", file=sys.stderr, flush=True)
        
        # Шаг 2.2: Загружаем файл на S3 используя pre-signed URI
        upload_response = requests.put(
            upload_uri,
            headers={"Content-Type": "application/pdf"},
            data=pdf_bytes,
            timeout=60
        )
        upload_response.raise_for_status()
        
        print(f"[INFO] Файл успешно загружен", file=sys.stderr, flush=True)
        return asset_id

    def convert_pdf_to_excel(self, pdf_bytes: bytes, filename: Optional[str] = None) -> bytes:
        """
        Конвертировать PDF в Excel (XLSX) через REST API по официальной документации.

        Процесс:
        1. Получить access token
        2. Загрузить PDF как asset (получить assetID)
        3. Создать job для экспорта
        4. Проверить статус job
        5. Скачать результат

        Args:
            pdf_bytes: Байты PDF файла
            filename: Имя файла (опционально, для логирования)

        Returns:
            Байты Excel файла (XLSX)

        Raises:
            Exception: Ошибка API Adobe
        """
        if not self._client_id or not self._client_secret:
            raise ValueError("Client ID и Client Secret обязательны для использования REST API")

        # Шаг 1: Получаем access token
        import sys
        print(f"[INFO] Получение access token...", file=sys.stderr, flush=True)
        access_token = self._get_access_token()
        print(f"[INFO] Access token получен", file=sys.stderr, flush=True)
        
        # Базовый URL для API
        if self._region.upper() == "EU":
            base_url = "https://pdf-services-eu.adobe.io"
        else:
            base_url = "https://pdf-services.adobe.io"
        
        headers = {
            "Authorization": f"Bearer {access_token}",
            "X-API-Key": self._client_id,
            "Content-Type": "application/json"
        }
        
        # Шаг 2: Загружаем PDF файл как asset
        asset_id = self._upload_asset(access_token, pdf_bytes, filename)
        
        # Шаг 3: Создаем job для экспорта PDF в Excel
        import sys
        print(f"[INFO] Создание job для экспорта PDF в Excel...", file=sys.stderr, flush=True)
        export_url = f"{base_url}/operation/exportpdf"
        
        # Формируем payload для экспорта в Excel
        # Попробуем упрощенный формат согласно примеру из документации
        payload_variants = [
            # Вариант 1: простой формат (согласно примеру)
            {
                "assetID": asset_id,
                "targetFormat": "xlsx"
            },
            # Вариант 2: с cpf:engine
            {
                "assetID": asset_id,
                "cpf:engine": {
                    "assetRef": {
                        "uri": "urn:adobe:pdfservices:pdf2excel:PDF2Excel"
                    }
                },
                "targetFormat": "xlsx"
            },
            # Вариант 3: полный формат
            {
                "cpf:engine": {
                    "assetRef": {
                        "uri": "urn:adobe:pdfservices:pdf2excel:PDF2Excel"
                    }
                },
                "cpf:inputs": {
                    "params": {
                        "cpf:inline": {
                            "targetFormat": "xlsx"
                        }
                    },
                    "documentIn": {
                        "cpf:location": {
                            "storageType": "external",
                            "assetID": asset_id
                        }
                    }
                }
            }
        ]
        
        response = None
        last_error = None
        
        # Пробуем разные варианты payload
        import sys
        for i, payload in enumerate(payload_variants, 1):
            print(f"[DEBUG] Пробую вариант payload {i}: {payload}", file=sys.stderr, flush=True)
            try:
                response = requests.post(
                    export_url,
                    headers=headers,
                    json=payload,
                    timeout=60
                )
                
                if response.status_code in (200, 201):
                    print(f"[INFO] ✅ Payload вариант {i} сработал!", file=sys.stderr, flush=True)
                    break
                else:
                    error_text = response.text
                    print(f"[DEBUG] Вариант {i} failed: {response.status_code} - {error_text[:300]}", file=sys.stderr, flush=True)
                    last_error = error_text
            except Exception as e:
                print(f"[DEBUG] Вариант {i} exception: {e}", file=sys.stderr, flush=True)
                last_error = str(e)
        
        if not response or response.status_code not in (200, 201):
            error_text = last_error or (response.text if response else "No response")
            print(f"[ERROR] Все варианты payload failed. Последняя ошибка: {response.status_code if response else 'No response'} - {error_text[:500]}", file=sys.stderr, flush=True)
            if response:
                response.raise_for_status()
            else:
                raise Exception(f"Не удалось создать job. Ошибка: {last_error}")
        
        # Получаем location из заголовка или job ID из тела ответа
        import sys
        location = response.headers.get("Location")
        job_id = None
        
        print(f"[DEBUG] Response headers Location: {location}", file=sys.stderr, flush=True)
        print(f"[DEBUG] Response status: {response.status_code}", file=sys.stderr, flush=True)
        
        if location:
            # Извлекаем job ID из location URL
            # Location может быть: /operation/exportpdf/{job_id}/status
            # или просто {job_id}
            location_parts = location.strip("/").split("/")
            print(f"[DEBUG] Location parts: {location_parts}", file=sys.stderr, flush=True)
            
            # Ищем job_id в location (обычно перед /status)
            if "status" in location_parts:
                status_idx = location_parts.index("status")
                if status_idx > 0:
                    job_id = location_parts[status_idx - 1]
            else:
                # Если нет /status, берем последний элемент
                job_id = location_parts[-1]
            
            print(f"[DEBUG] Extracted job_id from Location: {job_id}", file=sys.stderr, flush=True)
        
        # Пробуем получить из тела ответа, если не получили из location
        if not job_id:
            try:
                job_data = response.json()
                print(f"[DEBUG] Response body: {job_data}", file=sys.stderr, flush=True)
                job_id = job_data.get("jobId") or job_data.get("id") or job_data.get("job_id")
            except Exception as e:
                print(f"[DEBUG] Could not parse response body: {e}", file=sys.stderr, flush=True)
                pass
        
        if not job_id or job_id == "status":
            # Пробуем извлечь из полного URL location через regex
            if location:
                # Если location содержит путь типа /operation/exportpdf/{job_id}/status
                match = re.search(r'/exportpdf/([^/]+)/status', location)
                if match:
                    job_id = match.group(1)
                    print(f"[DEBUG] Extracted job_id from regex: {job_id}", file=sys.stderr, flush=True)
                else:
                    # Пробуем другой паттерн
                    match = re.search(r'/([a-f0-9\-]+)/status', location)
                    if match:
                        job_id = match.group(1)
                        print(f"[DEBUG] Extracted job_id from regex pattern 2: {job_id}", file=sys.stderr, flush=True)
        
        if not job_id or job_id == "status":
            print(f"[ERROR] Полный ответ: Status={response.status_code}, Headers={dict(response.headers)}, Body={response.text[:500]}", file=sys.stderr, flush=True)
            raise Exception(f"Не удалось получить правильный job ID из ответа. Location: {location}, Status: {response.status_code}, Response: {response.text[:200]}")
        
        print(f"[INFO] Job создан: {job_id}. Ожидание завершения...", file=sys.stderr, flush=True)
        
        # Шаг 4: Проверяем статус job
        status_url = f"{export_url}/{job_id}/status"
        # Таймаут по умолчанию: 10 минут (600 секунд) для больших файлов
        # Можно настроить через переменную окружения ADOBE_JOB_TIMEOUT (в секундах)
        max_wait = int(os.getenv("ADOBE_JOB_TIMEOUT", "600"))  # 10 минут по умолчанию
        start_time = time.time()
        import sys
        print(f"[DEBUG] Максимальное время ожидания: {max_wait} секунд ({max_wait // 60} минут)", file=sys.stderr, flush=True)
        
        while time.time() - start_time < max_wait:
            status_response = requests.get(status_url, headers=headers, timeout=10)
            status_response.raise_for_status()
            status_data = status_response.json()
            
            status = status_data.get("status", "unknown")
            print(f"[INFO] Статус job: {status}", file=sys.stderr, flush=True)
            
            if status == "done" or status == "success":
                # Шаг 5: Скачиваем результат
                print(f"[DEBUG] Полный ответ статуса: {status_data}", file=sys.stderr, flush=True)
                
                # Пробуем разные варианты ключей для downloadUri
                # Сначала проверяем asset объект (это основной путь для Adobe API)
                download_uri = None
                if isinstance(status_data.get("asset"), dict):
                    asset_obj = status_data.get("asset")
                    download_uri = (
                        asset_obj.get("downloadUri") or
                        asset_obj.get("download_uri") or
                        asset_obj.get("downloadURL") or
                        asset_obj.get("download_url")
                    )
                
                # Если не нашли в asset, проверяем корневой уровень
                if not download_uri:
                    if status_data.get("downloadUri"):
                        download_uri = status_data.get("downloadUri")
                    elif status_data.get("download_uri"):
                        download_uri = status_data.get("download_uri")
                    elif status_data.get("downloadURL"):
                        download_uri = status_data.get("downloadURL")
                    elif status_data.get("download_url"):
                        download_uri = status_data.get("download_url")
                
                # Если не нашли, проверяем result объект
                if not download_uri and isinstance(status_data.get("result"), dict):
                    result_obj = status_data.get("result")
                    download_uri = (
                        result_obj.get("downloadUri") or
                        result_obj.get("download_uri") or
                        result_obj.get("downloadURL") or
                        result_obj.get("download_url")
                    )
                
                # Если все еще нет, проверяем, может быть нужен отдельный запрос для получения результата
                if not download_uri:
                    # Пробуем получить результат через другой endpoint
                    result_url = f"{export_url}/{job_id}/result"
                    import sys
                    print(f"[DEBUG] Пробую получить результат через {result_url}", file=sys.stderr, flush=True)
                    try:
                        result_response = requests.get(result_url, headers=headers, timeout=10)
                        result_response.raise_for_status()
                        # Если это redirect, используем Location
                        if result_response.status_code in (301, 302, 303, 307, 308):
                            download_uri = result_response.headers.get("Location")
                            print(f"[DEBUG] Redirect на: {download_uri}", file=sys.stderr, flush=True)
                        elif result_response.headers.get("Content-Type", "").startswith("application/vnd.openxmlformats"):
                            # Прямой ответ с файлом
                            print(f"[INFO] Результат получен напрямую, размер: {len(result_response.content)} байт", file=sys.stderr, flush=True)
                            return result_response.content
                    except Exception as e:
                        print(f"[DEBUG] Не удалось получить результат через result endpoint: {e}", file=sys.stderr, flush=True)
                
                if download_uri:
                    import sys
                    print(f"[INFO] Скачивание результата с URI: {download_uri}", file=sys.stderr, flush=True)
                    result_response = requests.get(download_uri, timeout=60)
                    result_response.raise_for_status()
                    print(f"[INFO] Результат получен, размер: {len(result_response.content)} байт", file=sys.stderr, flush=True)
                    return result_response.content
                else:
                    import sys
                    print(f"[ERROR] downloadUri не найден. Полный ответ: {status_data}", file=sys.stderr, flush=True)
                    raise Exception(f"downloadUri не найден в ответе статуса. Доступные ключи: {list(status_data.keys())}")
            elif status == "failed" or status == "error":
                error_info = status_data.get("error", {})
                if isinstance(error_info, dict):
                    error_msg = error_info.get("message", str(error_info))
                else:
                    error_msg = str(error_info)
                raise Exception(f"Adobe API job failed: {error_msg}")
            
            time.sleep(2)
        
        raise Exception("Adobe API job timeout (превышено время ожидания)")

    def convert_pdf_to_excel_dataframe(self, pdf_bytes: bytes, filename: Optional[str] = None) -> pd.DataFrame:
        """
        Конвертировать PDF в Excel и вернуть как pandas DataFrame.

        Args:
            pdf_bytes: Байты PDF файла
            filename: Имя файла (опционально)

        Returns:
            DataFrame с данными из Excel

        Raises:
            ServiceApiException: Ошибка API Adobe
            ServiceUsageException: Превышение лимитов
            SdkException: Ошибка SDK
        """
        excel_bytes = self.convert_pdf_to_excel(pdf_bytes, filename)

        # Конвертируем Excel байты в DataFrame
        excel_file = io.BytesIO(excel_bytes)
        # Excel может содержать несколько листов, читаем первый
        df = pd.read_excel(excel_file, sheet_name=0, engine="openpyxl")

        return df

    @staticmethod
    def is_available() -> bool:
        """Проверить, доступен ли Adobe PDF Services SDK."""
        return ADOBE_AVAILABLE

