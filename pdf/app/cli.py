from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .pdf_processor import PDFStatementProcessor, merge_tables


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract credit transactions from bank statement PDFs")
    parser.add_argument("inputs", nargs="+", type=Path, help="Path(s) to PDF files")
    parser.add_argument("--output", "-o", type=Path, help="Optional path to save the filtered data (CSV or Excel)")
    parser.add_argument("--json", action="store_true", help="Print JSON to stdout instead of tabular view")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    processor = PDFStatementProcessor()
    documents = []
    aggregated_frames = []
    for path in args.inputs:
        if not path.exists():
            raise SystemExit(f"File not found: {path}")
        with path.open("rb") as pdf_file:
            extraction = processor.extract(pdf_file.read(), bank_name=path.name)
        frame = merge_tables(extraction.tables)
        transactions = frame.to_dict(orient="records") if not frame.empty else []
        if transactions:
            frame["source_file"] = path.name
            aggregated_frames.append(frame)

        documents.append(
            {
                "source_file": path.name,
                "metadata": extraction.metadata,
                "transactions": transactions,
            }
        )

    has_transactions = any(doc["transactions"] for doc in documents)
    if not has_transactions:
        print("No credit rows found.")
        return

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
        print(json.dumps(documents, ensure_ascii=False, indent=2))
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
