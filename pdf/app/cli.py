from __future__ import annotations

import argparse
import json
from pathlib import Path
import base64

import pandas as pd

from .pdf_processor import PDFStatementProcessor, merge_tables


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract credit transactions from bank statement PDFs")
    parser.add_argument("inputs", nargs="+", type=Path, help="Path(s) to PDF files")
    parser.add_argument("--output", "-o", type=Path, help="Optional path to save the filtered data (CSV or Excel)")
    parser.add_argument("--json", action="store_true", help="Print JSON to stdout instead of tabular view")
    return parser.parse_args()


def main() -> None:
    import os
    import sys
    
    args = parse_args()
    
    # Логируем информацию о запуске в stderr, чтобы не мешать JSON в stdout
    print(f"[CLI] Запуск обработки {len(args.inputs)} файл(ов)", file=sys.stderr, flush=True)
    print(f"[CLI] Python версия: {sys.version}", file=sys.stderr, flush=True)
    print(f"[CLI] Рабочая директория: {os.getcwd()}", file=sys.stderr, flush=True)
    
    # Проверяем переменные окружения Adobe API
    adobe_client_id = os.getenv("ADOBE_CLIENT_ID")
    adobe_client_secret = os.getenv("ADOBE_CLIENT_SECRET")
    adobe_credentials_file = os.getenv("ADOBE_CREDENTIALS_FILE")
    adobe_region = os.getenv("ADOBE_REGION", "US")
    
    print(f"[CLI] Adobe API Client ID: {'✅ установлен' if adobe_client_id else '❌ НЕ установлен'}", file=sys.stderr, flush=True)
    print(f"[CLI] Adobe API Client Secret: {'✅ установлен' if adobe_client_secret else '❌ НЕ установлен'}", file=sys.stderr, flush=True)
    print(f"[CLI] Adobe API Credentials File: {adobe_credentials_file or 'не установлен'}", file=sys.stderr, flush=True)
    print(f"[CLI] Adobe API Region: {adobe_region}", file=sys.stderr, flush=True)
    
    # Инициализируем процессор
    print(f"[CLI] Инициализация PDFStatementProcessor...", file=sys.stderr, flush=True)
    try:
        processor = PDFStatementProcessor()
        print(f"[CLI] ✅ PDFStatementProcessor инициализирован успешно", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[CLI] ❌ Ошибка инициализации PDFStatementProcessor: {e}", file=sys.stderr, flush=True)
        import traceback
        print(f"[CLI] Traceback: {traceback.format_exc()}", file=sys.stderr, flush=True)
        raise
    
    documents = []
    aggregated_frames = []
    
    for idx, path in enumerate(args.inputs, 1):
        print(f"\n[CLI] ========== Обработка файла {idx}/{len(args.inputs)}: {path.name} ==========", file=sys.stderr, flush=True)
        
        if not path.exists():
            print(f"[CLI] ❌ Файл не найден: {path}", file=sys.stderr, flush=True)
            raise SystemExit(f"File not found: {path}")
        
        file_size = path.stat().st_size
        print(f"[CLI] Размер файла: {file_size} байт", file=sys.stderr, flush=True)
        
        try:
            with path.open("rb") as pdf_file:
                pdf_bytes = pdf_file.read()
                print(f"[CLI] Файл прочитан: {len(pdf_bytes)} байт", file=sys.stderr, flush=True)
                
                print(f"[CLI] Вызов processor.extract()...", file=sys.stderr, flush=True)
                extraction = processor.extract(pdf_bytes, bank_name=path.name)
                print(f"[CLI] ✅ extraction завершен", file=sys.stderr, flush=True)
                print(f"[CLI] Найдено таблиц: {len(extraction.tables)}", file=sys.stderr, flush=True)
                print(f"[CLI] Метаданные: {list(extraction.metadata.keys())}", file=sys.stderr, flush=True)
            
            print(f"[CLI] Объединение таблиц...", file=sys.stderr, flush=True)
            frame = merge_tables(extraction.tables)
            print(f"[CLI] Размер объединенного DataFrame: {len(frame)} строк, {len(frame.columns) if not frame.empty else 0} колонок", file=sys.stderr, flush=True)
            
            # Конвертируем DataFrame в список словарей
            # Важно: заменяем NaN на None, чтобы они корректно сериализовались в JSON как null
            if not frame.empty:
                # Конвертируем DataFrame в словари
                transactions = frame.to_dict(orient="records")
                # Обрабатываем все NaN значения и заменяем их на None
                for trans in transactions:
                    for key, value in list(trans.items()):
                        # Проверка на NaN: через pd.isna() или сравнение с самим собой (для float NaN)
                        try:
                            if pd.isna(value):
                                trans[key] = None
                        except (TypeError, ValueError):
                            # Если pd.isna() не работает, проверяем через сравнение (для float NaN)
                            if isinstance(value, float) and value != value:
                                trans[key] = None
                        # Дополнительная проверка для строковых представлений NaN
                        if value == 'nan' or value == 'NaN' or value == 'NaT':
                            trans[key] = None
            else:
                transactions = []
            print(f"[CLI] Извлечено транзакций: {len(transactions)}", file=sys.stderr, flush=True)
            
            if transactions:
                print(f"[CLI] ✅ Найдено {len(transactions)} транзакций с кредитом", file=sys.stderr, flush=True)
                frame["source_file"] = path.name
                aggregated_frames.append(frame)
            else:
                print(f"[CLI] ⚠️ Транзакций не найдено (DataFrame пустой или нет строк с кредитом)", file=sys.stderr, flush=True)
                if not frame.empty:
                    print(f"[CLI] DataFrame не пустой, но транзакций нет. Колонки: {list(frame.columns)}", file=sys.stderr, flush=True)
                    print(f"[CLI] Первые 3 строки DataFrame:", file=sys.stderr, flush=True)
                    print(frame.head(3).to_string(), file=sys.stderr, flush=True)

            excel_bytes, excel_filename = processor.get_last_excel()
            excel_attachment = None
            if excel_bytes:
                excel_attachment = {
                    "name": excel_filename or f"{path.stem}.xlsx",
                    "size": len(excel_bytes),
                    "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "base64": base64.b64encode(excel_bytes).decode("utf-8"),
                }

            documents.append(
                {
                    "source_file": path.name,
                    "metadata": extraction.metadata,
                    "transactions": transactions,
                    "excel_file": excel_attachment,
                }
            )
        except Exception as e:
            print(f"[CLI] ❌ Ошибка при обработке файла {path.name}: {e}", file=sys.stderr, flush=True)
            import traceback
            print(f"[CLI] Traceback: {traceback.format_exc()}", file=sys.stderr, flush=True)
            # Добавляем документ с ошибкой
            documents.append({
                "source_file": path.name,
                "metadata": {},
                "transactions": [],
                "error": str(e)
            })

    has_transactions = any(doc["transactions"] for doc in documents)
    print(f"\n[CLI] ========== ИТОГИ ОБРАБОТКИ ==========", file=sys.stderr, flush=True)
    print(f"[CLI] Всего документов обработано: {len(documents)}", file=sys.stderr, flush=True)
    print(f"[CLI] Документов с транзакциями: {sum(1 for doc in documents if doc.get('transactions'))}", file=sys.stderr, flush=True)
    print(f"[CLI] Всего транзакций найдено: {sum(len(doc.get('transactions', [])) for doc in documents)}", file=sys.stderr, flush=True)
    print(f"[CLI] Документов с ошибками: {sum(1 for doc in documents if doc.get('error'))}", file=sys.stderr, flush=True)
    
    combined = pd.concat(aggregated_frames, ignore_index=True) if aggregated_frames else pd.DataFrame()

    if args.output:
        suffix = args.output.suffix.lower()
        if combined.empty:
            print("No data to save.")
            return

        if suffix in {".xlsx", ".xls"}:
            combined.to_excel(args.output, index=False)
        elif suffix == ".csv" or suffix == "":
            combined.to_csv(args.output if suffix else args.output.with_suffix(".csv"), index=False)
        else:
            raise SystemExit("Unsupported output format. Use .csv or .xlsx")
        print(f"Saved filtered data to {args.output}")
        return

    if args.json:
        # Всегда возвращаем JSON, даже если транзакций нет
        # Это позволяет вызывающему коду обработать результат правильно
        print(f"[CLI] Формирование JSON ответа...", file=sys.stderr, flush=True)
        
        # Функция для замены NaN/NaT на None в структуре данных
        def replace_nan(obj):
            if isinstance(obj, dict):
                return {k: replace_nan(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [replace_nan(item) for item in obj]
            elif isinstance(obj, float) and obj != obj:  # Проверка на NaN через сравнение
                return None
            elif hasattr(pd, 'isna') and pd.isna(obj):
                return None
            return obj
        
        # Обрабатываем все документы, заменяя NaN на None
        documents_cleaned = replace_nan(documents)
        
        json_output = json.dumps(documents_cleaned, ensure_ascii=False, indent=2)
        print(f"[CLI] Размер JSON: {len(json_output)} символов", file=sys.stderr, flush=True)
        # Выводим JSON ТОЛЬКО в stdout, без дополнительных логов
        # Важно: все логи должны быть выведены в stderr ДО вывода JSON
        sys.stderr.flush()  # Убеждаемся, что все логи в stderr выведены
        print(json_output, flush=True)
        return
    
    # Для не-JSON вывода
    if not has_transactions:
        print("No credit rows found.")
    else:
        for doc in documents:
            print("=" * 40)
            print(f"Файл: {doc['source_file']}")
            if doc["metadata"]:
                print("Метаданные:")
                for key, value in doc["metadata"].items():
                    if key == "raw_header":
                        continue
                    print(f"  - {key}: {value}")
            if doc["transactions"]:
                print("Транзакции:")
                frame = pd.DataFrame(doc["transactions"])
                print(frame.to_string(index=False))
            else:
                print("Транзакции: не найдены")


if __name__ == "__main__":
    main()
