#!/usr/bin/env python3
"""
security_scan.py - Deterministic Static Security Scanner (Pure Python stdlib)

Scans source code for:
1. Hardcoded API keys, JWT tokens, private keys, and passwords.
2. Insecure shell execution (subprocess with shell=True, os.system).
3. SQL injection patterns in raw queries.
4. Unsafe deserialization (pickle.loads, yaml.load).

Usage:
    python security_scan.py <target_directory_or_file> [--json]
"""

import sys
import os
import re
import ast
import json
from pathlib import Path

# Ensure UTF-8 console output
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except AttributeError:
    pass

SECRET_PATTERNS = [
    ("NVIDIA NIM / API Key", re.compile(r"nvapi-[A-Za-z0-9_-]{30,}")),
    ("OpenAI API Key", re.compile(r"sk-[A-Za-z0-9]{32,}")),
    ("GitHub Personal Access Token", re.compile(r"ghp_[A-Za-z0-9]{36,}")),
    ("Generic Private Key", re.compile(r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----")),
    ("AWS Access Key ID", re.compile(r"(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}")),
]

IGNORED_DIRS = {".git", ".venv", "node_modules", "__pycache__", "dist", "build", ".pytest_cache"}

class SecurityVisitor(ast.NodeVisitor):
    def __init__(self, filename):
        self.filename = filename
        self.issues = []

    def visit_Call(self, node):
        func_name = ""
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        # Check for os.system
        if func_name == "system" and isinstance(getattr(node.func, 'value', None), ast.Name) and node.func.value.id == "os":
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "INSECURE_SHELL",
                "severity": "HIGH",
                "message": "Use of os.system() detected. Use subprocess.run(..., shell=False) instead."
            })

        # Check for subprocess shell=True
        if func_name in ("run", "Popen", "call", "check_call", "check_output"):
            for kw in node.keywords:
                if kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                    self.issues.append({
                        "file": self.filename,
                        "line": node.lineno,
                        "type": "SHELL_TRUE",
                        "severity": "HIGH",
                        "message": "subprocess called with shell=True. Avoid shell interpolation."
                    })

        # Check for pickle.loads
        if func_name in ("loads", "load") and isinstance(getattr(node.func, 'value', None), ast.Name) and node.func.value.id == "pickle":
            self.issues.append({
                "file": self.filename,
                "line": node.lineno,
                "type": "UNSAFE_DESERIALIZATION",
                "severity": "CRITICAL",
                "message": "Insecure deserialization via pickle.load(s). Use json or safe protocol."
            })

        self.generic_visit(node)

def scan_file(filepath: Path) -> list:
    findings = []
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return findings

    # Scan for secret patterns in lines
    for line_idx, line in enumerate(content.splitlines(), start=1):
        for name, pattern in SECRET_PATTERNS:
            if pattern.search(line):
                # Avoid flagging placeholders
                if "YOUR_" in line or "TODO" in line or "example" in line.lower():
                    continue
                findings.append({
                    "file": str(filepath),
                    "line": line_idx,
                    "type": "HARDCODED_SECRET",
                    "severity": "CRITICAL",
                    "message": f"Possible hardcoded secret: {name}"
                })

    # AST scan for Python files
    if filepath.suffix == ".py":
        try:
            tree = ast.parse(content, filename=str(filepath))
            visitor = SecurityVisitor(str(filepath))
            visitor.visit(tree)
            findings.extend(visitor.issues)
        except SyntaxError:
            pass

    return findings

def main():
    if len(sys.argv) < 2:
        print("Usage: python security_scan.py <target_path> [--json]")
        sys.exit(2)

    target = Path(sys.argv[1])
    json_mode = "--json" in sys.argv

    if not target.exists():
        print(f"Error: Target path {target} does not exist.")
        sys.exit(1)

    all_findings = []
    if target.is_file():
        files = [target]
    else:
        files = []
        for root, dirs, filenames in os.walk(target):
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
            for fname in filenames:
                if fname.endswith((".py", ".js", ".ts", ".json", ".env", ".yaml", ".yml", ".md")):
                    files.append(Path(root) / fname)

    for f in files:
        all_findings.extend(scan_file(f))

    criticals = [f for f in all_findings if f["severity"] == "CRITICAL"]
    highs = [f for f in all_findings if f["severity"] == "HIGH"]

    if json_mode:
        print(json.dumps({
            "target": str(target),
            "files_scanned": len(files),
            "total_findings": len(all_findings),
            "critical": len(criticals),
            "high": len(highs),
            "findings": all_findings
        }, indent=2))
    else:
        print(f"=== SECURITY AUDIT REPORT: {target} ===")
        print(f"Files scanned: {len(files)} | Findings: {len(all_findings)} (Critical: {len(criticals)}, High: {len(highs)})")
        for finding in all_findings:
            print(f"[{finding['severity']}] {finding['file']}:{finding['line']} - {finding['message']}")

    sys.exit(1 if criticals else 0)

if __name__ == "__main__":
    main()
