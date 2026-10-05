"""test_checkpoint_engine.py — Rigorous verification suite for AgentCheckpointEngine."""

import os
from pathlib import Path
import shutil
import sqlite3
import unittest

from checkpoint_engine import AgentCheckpoint, AgentCheckpointEngine


class TestAgentCheckpointEngine(unittest.TestCase):

    def setUp(self):
        self.test_db = Path("D:/skills-library/agent-checkpoint/test_checkpoints.db")
        self.engine = AgentCheckpointEngine(db_path=self.test_db)
        with sqlite3.connect(self.test_db) as conn:
            conn.execute("DELETE FROM agent_checkpoints")
            conn.commit()

    def tearDown(self):
        if self.test_db.exists():
            try:
                self.test_db.unlink()
            except PermissionError:
                pass
        # Clean WAL and SHM files
        for ext in ["-wal", "-shm"]:
            p = Path(f"{self.test_db}{ext}")
            if p.exists():
                try:
                    p.unlink()
                except PermissionError:
                    pass

    def test_save_and_load_roundtrip(self):
        """Verify state is preserved exactly across save and load."""
        cp = AgentCheckpoint(
            task_id="task-test-001",
            agent_id="code-reviewer",
            status="paused",
            step_index=42,
            memory_state={"files_audited": ["a.py", "b.py"], "score": 9.5},
            task_queue=["audit_c.py", "generate_report"],
            metadata={"priority": "high", "timeout_sec": 300},
        )

        self.engine.save_checkpoint(cp)
        loaded = self.engine.load_checkpoint("task-test-001")

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded.task_id, "task-test-001")
        self.assertEqual(loaded.agent_id, "code-reviewer")
        self.assertEqual(loaded.step_index, 42)
        self.assertEqual(loaded.memory_state["score"], 9.5)
        self.assertEqual(len(loaded.task_queue), 2)
        self.assertEqual(loaded.metadata["priority"], "high")

    def test_list_and_delete(self):
        """Verify listing and deletion works atomically."""
        cp1 = AgentCheckpoint(
            task_id="task-1",
            agent_id="agent-a",
            status="running",
            step_index=1,
            memory_state={},
            task_queue=[],
        )
        cp2 = AgentCheckpoint(
            task_id="task-2",
            agent_id="agent-b",
            status="paused",
            step_index=5,
            memory_state={},
            task_queue=[],
        )

        self.engine.save_checkpoint(cp1)
        self.engine.save_checkpoint(cp2)

        items = self.engine.list_checkpoints()
        self.assertEqual(len(items), 2)

        deleted = self.engine.delete_checkpoint("task-1")
        self.assertTrue(deleted)

        remaining = self.engine.list_checkpoints()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["task_id"], "task-2")


if __name__ == "__main__":
    unittest.main()
