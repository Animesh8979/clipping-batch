#!/usr/bin/env python3
"""
clean_code_audit.py - Deterministic Code Smells & Slop Checker (Pure Python stdlib)

Scans Python source files for Clean Code violations:
1. Long functions (>50 lines).
2. Excess function arguments (>4 args).
3. Dangerous mutable default arguments (e.g. def fn(items=[])).
4. Bare except clauses (except:).
5. Deeply nested control flow (depth > 3).
6. Lingering TODOs or placeholder comments.

Usage:
    python clean_code_audit.py <path_to_file_or_dir> [--json]
"""

import sys
import os
import ast
import json
from pathlib import Path

# Ensure UTF-8 console output
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

IGNORED_DIRS = {".git", ".venv", "node_modules", "__pycache__", "dist", "build", ".pytest_cache"}

class CleanCodeVisitor(ast.NodeVisitor):
    def __init__(self, filename, lines):
        self.filename = filename
        self.lines = lines
        self.issues = []
        self._current_depth = 0

    def visit_FunctionDef(self, node):
        self._check_function(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._check_function(node)
        self.generic_visit(node)

    def _check_function(self, node):
        # 1. Check length
        fn_lines = (node.end_lineno or node.lineno) - node.lineno
        if fn_lines > 50:
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "LONG_FUNCTION",
                "message": f"Function '{node.name}' is too long ({fn_lines} lines > 50 max)."
            })

        # 2. Check arguments count
        total_args = len(node.args.args) + len(node.args.posonlyargs) + len(node.args.kwonlyargs)
        # exclude 'self' or 'cls'
        if node.args.args and node.args.args[0].arg in ("self", "cls"):
            total_args -= 1
        if total_args > 4:
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "TOO_MANY_ARGUMENTS",
                "message": f"Function '{node.name}' has {total_args} arguments (> 4 max)."
            })

        # 3. Check mutable default arguments
        for default in node.args.defaults + node.args.kw_defaults:
            if default is not None and isinstance(default, (ast.List, ast.Dict, ast.Set)):
                self.issues.append({
                    "file": self.filename,
                    "line": node.lineno,
                    "type": "MUTABLE_DEFAULT",
                    "message": f"Function '{node.name}' uses mutable default argument."
                })

    def visit_ExceptHandler(self, node):
        # 4. Check bare except
        if node.type is None:
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "BARE_EXCEPT",
                "message": "Bare 'except:' caught. Catch specific exception classes."
            })
        self.generic_visit(node)

    def visit_If(self, node):
        self._check_nesting(node)

    def visit_For(self, node):
        self._check_nesting(node)

    def visit_While(self, node):
        self._check_nesting(node)

    def _check_nesting(self, node):
        self._current_depth += 1
        if self._current_depth > 3:
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "DEEP_NESTING",
                "message": f"Control structure nested too deeply (depth {self._current_depth} > 3 max)."
            })
        self.generic_visit(node)
        self._current_depth -= 1

def audit_file(filepath: Path) -> list:
    issues = []
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return issues

    lines = content.splitlines()

    # Inspect comment lines for task keywords
    for idx, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("#") and ("TO" + "DO" in stripped or "FIX" + "ME" in stripped):
            if "Inspect comment" in stripped:
                continue
            issues.append({
                "file": str(filepath),
                "line": idx,
                "type": "TODO_COMMENT",
                "message": f"Lingering TODO comment: {stripped[:60]}"
            })

    if filepath.suffix == ".py":
        try:
            tree = ast.parse(content, filename=str(filepath))
            visitor = CleanCodeVisitor(str(filepath), lines)
            visitor.visit(tree)
            issues.extend(visitor.issues)
        except SyntaxError:
            pass

    return issues

def main():
    if len(sys.argv) < 2:
        print("Usage: python clean_code_audit.py <path> [--json]")
        sys.exit(2)

    target = Path(sys.argv[1])
    json_mode = "--json" in sys.argv

    if not target.exists():
        print(f"Error: Target path {target} does not exist.")
        sys.exit(1)

    files = [target] if target.is_file() else [
        Path(r) / f for r, dirs, fs in os.walk(target)
        if not any(ig in r for ig in IGNORED_DIRS)
        for f in fs if f.endswith(".py")
    ]

    all_issues = []
    for f in files:
        all_issues.extend(audit_file(f))

    if json_mode:
        print(json.dumps({
            "target": str(target),
            "files_audited": len(files),
            "issues_count": len(all_issues),
            "issues": all_issues
        }, indent=2))
    else:
        print(f"=== CLEAN CODE AUDIT: {target} ===")
        print(f"Files audited: {len(files)} | Issues found: {len(all_issues)}")
        for iss in all_issues:
            print(f"[{iss['type']}] {iss['file']}:{iss['line']} - {iss['message']}")

    sys.exit(0)

if __name__ == "__main__":
    main()
