# Code Reviewer Implementation Playbook

Production-grade code review checklist and execution playbooks for Antigravity agents.

---

## 1. The Senior Review Decision Hierarchy

When reviewing any Pull Request or code modification:
1. **Correctness & Edge Cases**: Does the code execute as specified? Are null, empty, negative, or overflow bounds guarded?
2. **Security & Secrets**: Are inputs sanitized? Any SQL injection, command injection, path traversal, or leaked credentials?
3. **Resource & Memory Leaks**: Are file handles, database connections, and subprocesses closed deterministically in `try...finally` or `with` contexts?
4. **Performance & Complexity**: Are there nested loops ($O(n^2)$), N+1 queries, unindexed database filters, or full-viewport CSS repaints?
5. **Simplicity (Ponytail Ladder)**: Can this be solved with standard library? Is there redundant abstraction or boilerplate?

---

## 2. Review Checklist Matrix

| Dimension | Critical Checks | Immediate Rejection Criteria |
|---|---|---|
| **Security** | - Input validation at boundary<br>- Parameterized SQL queries<br>- Path sanitization (`os.path.abspath`) | - Unescaped string formatting in SQL/Shell<br>- Hardcoded tokens or API keys<br>- Insecure deserialization (`pickle.loads`) |
| **Concurrency & Async** | - Thread-safety on shared state<br>- SQLite WAL mode with single writer<br>- Async task timeouts | - Blocking synchronous I/O inside async event loop<br>- Unbounded worker queues |
| **Error Handling** | - Explicit exception catching<br>- Contextual logging with stack traces<br>- User-friendly error responses | - Bare `except:` or `catch (e) {}` swallowing errors<br>- Silent failure with placeholder return |
| **Verification Gate** | - Unit tests covering happy path & failure modes<br>- Deterministic test execution (zero flakiness)<br>- 0 linter / compiler regressions | - Claims of "done" without running tests<br>- Placeholder comments (`// TODO: implement`) |

---

## 3. Automated Diff Review Workflow

```bash
# 1. Review changed files
git diff --name-only origin/main...HEAD

# 2. Inspect specific file diff with context
git diff -U5 origin/main...HEAD -- path/to/file.py

# 3. Check for leftover debug statements
git diff origin/main...HEAD | grep -E "console\.log|print\(|debugger|import pdb"
```
