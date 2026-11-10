"""A small SQLite "warehouse" exposed as a stdio MCP server, with tools tiered by risk.

    python sql_warehouse_mcp.py [--db path/to/analytics.db]

The database is built from db/seed.sql the first time (or whenever the file is missing).
Tool names carry the risk on purpose, so an ArmorIQ policy can match each one by name:

    list_tables, describe_table, run_select     read only            allow
    insert_row, update_rows                      writes               hold
    delete_rows, drop_table, export_table        destructive / exfil  block

The server keeps its own guard rails too (read only connection for run_select, identifier
checks everywhere). ArmorIQ is the policy layer; it does not replace basic input hygiene.
"""

import argparse
import csv
import io
import re
import sqlite3
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HERE = Path(__file__).resolve().parent
SEED = HERE / "db" / "seed.sql"
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--db", default=str(HERE / "analytics.db"), help="SQLite file (created from db/seed.sql if missing)")
ARGS, _ = parser.parse_known_args()
DB_PATH = Path(ARGS.db).resolve()

mcp = FastMCP("sql-warehouse", log_level="WARNING")


def _ensure_database() -> None:
    if DB_PATH.exists():
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(SEED.read_text(encoding="utf-8"))


def _connect(read_only: bool = False) -> sqlite3.Connection:
    _ensure_database()
    if read_only:
        conn = sqlite3.connect(f"{DB_PATH.as_uri()}?mode=ro", uri=True)
    else:
        conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _identifier(name: str) -> str:
    if not IDENTIFIER.match(name or ""):
        raise ValueError(f"Not a plain table or column name: {name!r}")
    return name


def _existing_table(conn: sqlite3.Connection, table: str) -> str:
    _identifier(table)
    row = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    if row is None:
        raise ValueError(f"No such table: {table}")
    return table


@mcp.tool()
def list_tables() -> list[str]:
    """List the tables in the analytics database."""
    with _connect(read_only=True) as conn:
        return [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]


@mcp.tool()
def describe_table(table: str) -> list[dict]:
    """Show a table's columns and types."""
    with _connect(read_only=True) as conn:
        _existing_table(conn, table)
        return [{"column": r["name"], "type": r["type"]} for r in conn.execute(f"PRAGMA table_info({table})")]


@mcp.tool()
def run_select(sql: str) -> list[dict]:
    """Run one read only SELECT (or WITH ... SELECT) query and return up to 200 rows."""
    statement = sql.strip().rstrip(";")
    if not re.match(r"^(select|with)\b", statement, re.IGNORECASE) or ";" in statement:
        raise ValueError("run_select only runs a single SELECT statement")
    with _connect(read_only=True) as conn:
        return [dict(r) for r in conn.execute(statement).fetchmany(200)]


@mcp.tool()
def insert_row(table: str, values: dict) -> dict:
    """Insert one row. `values` maps column name to value."""
    with _connect() as conn:
        _existing_table(conn, table)
        columns = [_identifier(c) for c in values]
        placeholders = ", ".join("?" for _ in columns)
        cursor = conn.execute(
            f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})", list(values.values())
        )
        return {"table": table, "inserted_rowid": cursor.lastrowid}


@mcp.tool()
def update_rows(table: str, values: dict, key_column: str, key_value: str) -> dict:
    """Set `values` on the rows where `key_column` equals `key_value`."""
    with _connect() as conn:
        _existing_table(conn, table)
        assignments = ", ".join(f"{_identifier(c)} = ?" for c in values)
        cursor = conn.execute(
            f"UPDATE {table} SET {assignments} WHERE {_identifier(key_column)} = ?",
            [*values.values(), key_value],
        )
        return {"table": table, "rows_updated": cursor.rowcount}


@mcp.tool()
def delete_rows(table: str, key_column: str, key_value: str) -> dict:
    """Delete the rows where `key_column` equals `key_value`. Irreversible."""
    with _connect() as conn:
        _existing_table(conn, table)
        cursor = conn.execute(f"DELETE FROM {table} WHERE {_identifier(key_column)} = ?", (key_value,))
        return {"table": table, "rows_deleted": cursor.rowcount}


@mcp.tool()
def drop_table(table: str) -> dict:
    """Drop a whole table. Irreversible."""
    with _connect() as conn:
        _existing_table(conn, table)
        conn.execute(f"DROP TABLE {table}")
        return {"table": table, "status": "dropped"}


@mcp.tool()
def export_table(table: str, destination: str) -> dict:
    """Export a whole table as CSV to a destination outside the warehouse."""
    with _connect(read_only=True) as conn:
        _existing_table(conn, table)
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    if rows:
        writer.writerow(rows[0].keys())
        writer.writerows(tuple(r) for r in rows)
    # This demo server never sends anything anywhere; it only reports what it would export.
    return {"table": table, "destination": destination, "rows": len(rows), "bytes": len(buffer.getvalue())}


if __name__ == "__main__":
    mcp.run()
