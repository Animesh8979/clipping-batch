"""test_stream_guard.py — Rigorous test suite for StreamGuard."""

import unittest

from stream_guard import StreamGuard, GuardVerdict


class TestStreamGuard(unittest.TestCase):

    def setUp(self):
        self.guard = StreamGuard(
            ngram_sizes=(2, 3), max_ngram_repeats=3, window_size=30
        )

    def test_clean_stream_passes(self):
        """Verify normal diverse tokens do not trigger corruption."""
        tokens = [
            "The",
            " ",
            "quick",
            " ",
            "brown",
            " ",
            "fox",
            " ",
            "jumps",
            " ",
            "over",
            " ",
            "the",
            " ",
            "lazy",
            " ",
            "dog.",
        ]
        for t in tokens:
            verdict = self.guard.push(t)
            self.assertFalse(verdict.corrupted)

    def test_repetition_loop_detection(self):
        """Verify repeated phrases trigger corruption alarm."""
        loop_tokens = ["repeat", "this", "loop", "repeat", "this", "loop", "repeat", "this", "loop"]
        triggered = False
        last_verdict = None
        for t in loop_tokens:
            verdict = self.guard.push(t)
            if verdict.corrupted:
                triggered = True
                last_verdict = verdict
                break

        self.assertTrue(triggered, "Failed to detect repeating n-gram loop")
        self.assertIn("Repetition loop detected", last_verdict.reason)
        self.assertIsNotNone(last_verdict.safe_prefix)

    def test_markdown_table_no_false_positive(self):
        """Verify markdown tables with repeated delimiter tokens do not trigger false positive."""
        table_tokens = ["|", "---", "|", "---", "|", "\n", "|", "---", "|", "---", "|"]
        triggered = False
        for t in table_tokens:
            verdict = self.guard.push(t)
            if verdict.corrupted:
                triggered = True
                break
        self.assertFalse(triggered, "False positive on markdown table structure")

    def test_ast_validation(self):
        """Verify AST validator identifies broken syntax vs clean syntax."""
        clean_code = "def add(a, b):\n    return a + b\n"
        is_valid, err = self.guard.validate_code_ast(clean_code)
        self.assertTrue(is_valid)
        self.assertIsNone(err)

        broken_code = "def broken(a, b:\n    return a +\n"
        is_valid, err = self.guard.validate_code_ast(broken_code)
        self.assertFalse(is_valid)
        self.assertIsNotNone(err)


if __name__ == "__main__":
    unittest.main()
