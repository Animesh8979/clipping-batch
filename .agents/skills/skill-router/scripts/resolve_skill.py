"""resolve_skill.py — Sub-millisecond FTS5 skill resolver for Antigravity agents.

Provides on-demand discovery across all 4,800+ skills in D:\\skills-library without
polluting the system prompt or wasting context tokens.

Features:
- Pure Python standard library (sqlite3 FTS5 + json + pathlib).
- Sub-2ms search latency with BM25 full-text ranking.
- Clickable markdown file links for immediate view_file inspection.
"""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

LIBRARY_DIR = Path(r"D:\skills-library")
CATALOG_JSON = LIBRARY_DIR / "catalog.json"
INDEX_DB = LIBRARY_DIR / "skills_fts.db"


def build_fts_index(db_path: Path, catalog_path: Path) -> int:
    """Build or rebuild SQLite FTS5 index from catalog.json."""
    if not catalog_path.exists():
        raise FileNotFoundError(f"catalog.json not found at {catalog_path}")

    with open(catalog_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    skills = data.get("skills", [])
    if not skills:
        return 0

    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("DROP TABLE IF EXISTS skills_fts;")
        conn.execute(
            """
            CREATE VIRTUAL TABLE skills_fts USING fts5(
                skill_id,
                name,
                description,
                sector,
                tier,
                path,
                tokenize = 'porter unicode61'
            );
            """
        )

        rows = []
        for s in skills:
            sid = str(s.get("skill_id", ""))
            name = str(s.get("name", sid))
            desc = str(s.get("description", ""))
            sec = s.get("sector", "")
            sector = json.dumps(sec) if isinstance(sec, (dict, list)) else str(sec)
            tr = s.get("tier", "research")
            tier = json.dumps(tr) if isinstance(tr, (dict, list)) else str(tr)

            # Resolve actual SKILL.md path
            p = LIBRARY_DIR / sid / "SKILL.md"
            if not p.exists():
                ep = s.get("entrypoints")
                if isinstance(ep, dict) and "skill_md" in ep:
                    p = Path(ep["skill_md"])

            rows.append((sid, name, desc, sector, tier, str(p)))

        conn.executemany(
            """
            INSERT INTO skills_fts (skill_id, name, description, sector, tier, path)
            VALUES (?, ?, ?, ?, ?, ?);
            """,
            rows,
        )
        conn.commit()

    return len(rows)


def search_skills(query: str, top_n: int = 5) -> list:
    """Search skills via SQLite FTS5 BM25 ranking."""
    if (
        not INDEX_DB.exists()
        or INDEX_DB.stat().st_mtime < CATALOG_JSON.stat().st_mtime
    ):
        build_fts_index(INDEX_DB, CATALOG_JSON)

    # Format query for FTS5 (support prefix queries on each word)
    clean_words = [w.strip() for w in query.replace('"', "").split() if w.strip()]
    if not clean_words:
        return []

    # Format as: "word1"* OR "word2"* OR MATCH group
    fts_query = " OR ".join([f'"{w}"*' for w in clean_words])

    with sqlite3.connect(INDEX_DB) as conn:
        cur = conn.execute(
            """
            SELECT skill_id, name, description, sector, tier, path, bm25(skills_fts) as rank
            FROM skills_fts
            WHERE skills_fts MATCH ?
            ORDER BY rank
            LIMIT ?;
            """,
            (fts_query, top_n * 4),
        )
        raw_results = cur.fetchall()

    # Deduplicate by normalized skill name, prioritizing root paths over _repos mirrors
    seen = {}
    import re
    for r in raw_results:
        sid, name, desc, sector, tier, path, rank = r
        norm_id = re.sub(r"^sec\d+-", "", sid).lower().strip()
        is_mirror = "_repos" in path or "_incoming" in path

        if norm_id not in seen:
            seen[norm_id] = r
        else:
            existing_path = seen[norm_id][5]
            if ("_repos" in existing_path or "_incoming" in existing_path) and not is_mirror:
                seen[norm_id] = r

    return list(seen.values())[:top_n]


def main():
    parser = argparse.ArgumentParser(
        description="Sub-millisecond FTS5 Skill Resolver"
    )
    parser.add_argument("query", help="Search query (e.g. 'postgres indexing')")
    parser.add_argument(
        "--top", type=int, default=5, help="Number of results to return"
    )
    parser.add_argument(
        "--rebuild", action="store_true", help="Force rebuild of FTS index"
    )
    parser.add_argument("--json", action="store_true", help="Output JSON format")
    args = parser.parse_args()

    if args.rebuild or not INDEX_DB.exists():
        count = build_fts_index(INDEX_DB, CATALOG_JSON)
        print(f"[REBUILT] Indexed {count} skills in {INDEX_DB.name}")

    start_time = time.time()
    results = search_skills(args.query, top_n=args.top)
    latency_ms = (time.time() - start_time) * 1000

    if args.json:
        out = [
            {
                "skill_id": r[0],
                "name": r[1],
                "description": r[2],
                "sector": r[3],
                "tier": r[4],
                "path": r[5],
                "rank": round(r[6], 3),
            }
            for r in results
        ]
        print(json.dumps(out, indent=2))
        return

    print(
        f"\n=== SKILL RESOLVER: '{args.query}' ({len(results)} matches in {latency_ms:.2f}ms) ===\n"
    )
    if not results:
        print("No matching skills found in library.")
        return

    print("| Rank | Skill ID | Description | File Link |")
    print("|---|---|---|---|")
    for idx, r in enumerate(results, start=1):
        sid, name, desc, sector, tier, path = r[0], r[1], r[2], r[3], r[4], r[5]
        clean_desc = (desc[:75] + "...") if len(desc) > 75 else desc
        # Windows-safe forward slash link
        link_path = path.replace("\\", "/")
        print(
            f"| #{idx} | **`{sid}`** | {clean_desc} | [SKILL.md](file:///{link_path}) |"
        )
    print("")


if __name__ == "__main__":
    main()
