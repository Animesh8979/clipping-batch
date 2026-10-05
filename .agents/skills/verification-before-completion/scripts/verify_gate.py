"""verify_gate.py — Deterministic verification gate runner for Antigravity.

Usage:
    python verify_gate.py --cmd "pytest"
    python verify_gate.py --cmd "python -m unittest discover -s tests"
"""

import argparse
import json
import os
import subprocess
import sys
import time


def run_verification_gate(command: str) -> dict:
    start_time = time.time()
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        proc = subprocess.run(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        duration = round(time.time() - start_time, 3)
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        exit_code = proc.returncode

        passed = exit_code == 0
        report = {
            "command": command,
            "status": "PASS" if passed else "FAIL",
            "exit_code": exit_code,
            "duration_seconds": duration,
            "stdout_summary": stdout[-500:] if len(stdout) > 500 else stdout,
            "stderr_summary": stderr[-500:] if len(stderr) > 500 else stderr,
        }
        return report
    except Exception as e:
        return {
            "command": command,
            "status": "ERROR",
            "exit_code": -1,
            "error": str(e),
            "duration_seconds": round(time.time() - start_time, 3),
        }


def main():
    parser = argparse.ArgumentParser(
        description="Run deterministic verification gate"
    )
    parser.add_argument("--cmd", required=True, help="Command to execute")
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    result = run_verification_gate(args.cmd)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        status_color = "PASS" if result["status"] == "PASS" else "FAIL"
        print(
            f"=== VERIFICATION GATE: [{status_color}] (exit {result['exit_code']} in {result['duration_seconds']}s) ==="
        )
        if result["stdout_summary"]:
            print(f"Output:\n{result['stdout_summary']}")
        if result["status"] != "PASS" and result.get("stderr_summary"):
            print(f"Errors:\n{result['stderr_summary']}")

    sys.exit(0 if result["status"] == "PASS" else 1)


if __name__ == "__main__":
    main()
